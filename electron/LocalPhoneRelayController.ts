import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { app, clipboard, desktopCapturer, screen } from "electron"
import type {
  CompleteLocalPhonePairingResponse,
  CreateLocalPhonePairingSessionResponse,
  LocalPhonePairingQrPayload,
  LocalPhonePairingSessionSummary,
  LocalPhoneRemoteInputPayload,
  LocalPhoneRelayEventSummary,
  LocalPhoneRelayEventType,
  LocalPhoneRelayState,
} from "../shared/localPhoneRelay"
import type { ComputerUseStartData, ComputerUseState } from "../shared/followUpChat"

interface StoredPairingSession extends LocalPhonePairingSessionSummary {
  pairingToken: string | null
  deviceToken: string | null
}

interface StoredLocalPhoneRelayData {
  activePairing: StoredPairingSession | null
  devices: StoredPairingSession[]
  events: LocalPhoneRelayEventSummary[]
}

type StartComputerTaskResult =
  | { success: true; data: ComputerUseStartData }
  | { success: false; error: string; authRequired?: boolean }

interface LocalPhoneRelayControllerDeps {
  startComputerTask?: (task: string) => Promise<StartComputerTaskResult>
  analyzeScreen?: () => Promise<void>
  resetDesktop?: () => Promise<void>
  handleRemoteInput?: (input: LocalPhoneRemoteInputPayload) => Promise<void>
  subscribeToComputerUseState?: (
    listener: (state: ComputerUseState) => void
  ) => () => void
}

interface ActiveMobileCommand {
  commandId: string
  pairingId: string
}

interface LatestCameraFrame {
  id: number
  pairingId: string
  mobileDeviceName: string | null
  facing: "front" | "back" | null
  width: number | null
  height: number | null
  frameCount: number
  updatedAt: string
  data: Buffer
}

const PREFERRED_PORTS = [39393, 39394, 39395, 39396, 39397]
const MAX_EVENTS = 40
const MAX_FILE_UPLOAD_BYTES = 512 * 1024 * 1024
const MAX_CAMERA_FRAME_BYTES = 3 * 1024 * 1024
const CAMERA_ACTIVE_TTL_MS = 5000
const DESKTOP_SCREEN_JPEG_QUALITY = 68
const PAIRING_TTL_MS = 10 * 60 * 1000
const SUPPORTED_EVENT_TYPES: LocalPhoneRelayEventType[] = [
  "clipboard",
  "otp",
  "link",
  "note",
  "notification",
  "computer_command",
  "computer_command_status",
  "desktop_command",
  "desktop_command_status",
  "screen_result",
  "file",
]

type DesktopCommandName = "analyze_screen" | "reset"

function normalizeDesktopCommandName(value: unknown): DesktopCommandName {
  const command = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_")

  if (command === "analyze_screen" || command === "analyse_screen") {
    return "analyze_screen"
  }

  if (command === "reset" || command === "reset_desktop" || command === "start_over") {
    return "reset"
  }

  throw new Error("Unsupported desktop command.")
}

function clampRemoteNumber(value: unknown, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return 0
  }

  return Math.max(min, Math.min(max, Math.round(parsed)))
}

function sanitizePathSegment(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+$/, "")

  const safeValue = cleaned || fallback
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(safeValue)) {
    return `_${safeValue}`
  }

  return safeValue.slice(0, 180)
}

function sanitizeRelativeUploadPath(value: string, fallbackFileName: string): string[] {
  const parts = value
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter((part) => part && part !== "." && part !== "..")
    .map((part, index) =>
      sanitizePathSegment(part, index === 0 ? "Upload" : fallbackFileName)
    )
    .slice(0, 32)

  if (parts.length > 0) {
    return parts
  }

  return [sanitizePathSegment(fallbackFileName, "phone-upload")]
}

function isPrivateIpv4(value: string): boolean {
  return (
    value.startsWith("10.") ||
    value.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(value)
  )
}

function pickLanAddress(): string | null {
  const interfaces = os.networkInterfaces()
  const preferred: string[] = []
  const fallback: string[] = []

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (
        !entry ||
        entry.family !== "IPv4" ||
        entry.internal ||
        !entry.address ||
        entry.address.startsWith("127.")
      ) {
        continue
      }

      if (isPrivateIpv4(entry.address)) {
        preferred.push(entry.address)
      } else {
        fallback.push(entry.address)
      }
    }
  }

  return preferred[0] || fallback[0] || null
}

function createId(): string {
  return crypto.randomUUID()
}

function createSecret(): string {
  return crypto.randomBytes(24).toString("base64url")
}

function toSummary(session: StoredPairingSession): LocalPhonePairingSessionSummary {
  return {
    id: session.id,
    desktopDeviceName: session.desktopDeviceName,
    mobileDeviceName: session.mobileDeviceName,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
    pairedAt: session.pairedAt,
    lastSeenAt: session.lastSeenAt,
  }
}

export class LocalPhoneRelayController {
  private server: http.Server | null = null
  private port: number | null = null
  private state: LocalPhoneRelayState
  private readonly storePath: string
  private readonly listeners = new Set<(state: LocalPhoneRelayState) => void>()
  private storedData: StoredLocalPhoneRelayData
  private readonly mobileCommandByThreadId = new Map<string, ActiveMobileCommand>()
  private readonly lastComputerStatusKeys = new Map<string, string>()
  private readonly cameraViewerToken = createSecret()
  private latestCameraFrame: LatestCameraFrame | null = null
  private unsubscribeComputerUseState: (() => void) | null = null

  constructor(
    private readonly desktopDeviceName = "Sylica AI Desktop",
    private readonly deps: LocalPhoneRelayControllerDeps = {}
  ) {
    this.storePath = path.join(app.getPath("userData"), "local-phone-relay.json")
    this.storedData = this.loadStoredData()
    this.expirePendingPairingIfNeeded()
    this.state = this.buildPublicState("offline", null)
    this.unsubscribeComputerUseState =
      this.deps.subscribeToComputerUseState?.((state) => {
        this.handleComputerUseState(state)
      }) || null
  }

  public subscribe(listener: (state: LocalPhoneRelayState) => void): () => void {
    this.listeners.add(listener)
    listener(this.getState())
    return () => {
      this.listeners.delete(listener)
    }
  }

  public getState(): LocalPhoneRelayState {
    return JSON.parse(JSON.stringify(this.state)) as LocalPhoneRelayState
  }

  public async ensureStarted(): Promise<LocalPhoneRelayState> {
    if (this.server && this.port) {
      this.refreshState("ready", null)
      return this.getState()
    }

    this.refreshState("starting", null)

    let lastError: Error | null = null
    for (const port of PREFERRED_PORTS) {
      try {
        await this.listenOnPort(port)
        this.port = port
        this.refreshState("ready", null)
        return this.getState()
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("Failed to start local relay server.")
      }
    }

    this.refreshState(
      "error",
      lastError?.message || "Failed to start local relay server."
    )
    throw lastError || new Error("Failed to start local relay server.")
  }

  public async createPairingSession(input?: {
    desktopDeviceName?: string
  }): Promise<CreateLocalPhonePairingSessionResponse> {
    await this.ensureStarted()
    this.expirePendingPairingIfNeeded()

    if (
      this.storedData.activePairing &&
      this.storedData.activePairing.status === "pending" &&
      !this.isExpired(this.storedData.activePairing.expiresAt)
    ) {
      this.refreshState("ready", null)
      return this.getActivePairingResponse()
    }

    const now = new Date().toISOString()
    const nextDesktopDeviceName =
      input?.desktopDeviceName?.trim() || this.desktopDeviceName
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString()
    const pairing: StoredPairingSession = {
      id: createId(),
      desktopDeviceName: nextDesktopDeviceName,
      mobileDeviceName: null,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      expiresAt,
      pairedAt: null,
      lastSeenAt: null,
      pairingToken: createSecret(),
      deviceToken: null,
    }

    this.storedData.activePairing = pairing
    this.persist()
    this.refreshState("ready", null)
    return this.getActivePairingResponse()
  }

  public shutdown(): void {
    if (this.unsubscribeComputerUseState) {
      this.unsubscribeComputerUseState()
      this.unsubscribeComputerUseState = null
    }

    if (!this.server) {
      return
    }

    this.server.close()
    this.server = null
    this.port = null
    this.refreshState("offline", null)
  }

  public publishDesktopEvent(
    eventType: LocalPhoneRelayEventType,
    payload: Record<string, unknown>
  ): LocalPhoneRelayEventSummary[] {
    if (!SUPPORTED_EVENT_TYPES.includes(eventType)) {
      throw new Error("Unsupported phone relay event type.")
    }

    const pairedDevices = this.storedData.devices.filter(
      (device) => device.status === "paired" && Boolean(device.deviceToken)
    )

    return pairedDevices.map((device) =>
      this.appendRelayEvent(device, eventType, payload, "desktop")
    )
  }

  private loadStoredData(): StoredLocalPhoneRelayData {
    if (!fs.existsSync(this.storePath)) {
      return {
        activePairing: null,
        devices: [],
        events: [],
      }
    }

    try {
      const rawValue = fs.readFileSync(this.storePath, "utf8")
      const parsed = JSON.parse(rawValue) as Partial<StoredLocalPhoneRelayData>
      return {
        activePairing: parsed.activePairing || null,
        devices: Array.isArray(parsed.devices) ? parsed.devices : [],
        events: Array.isArray(parsed.events) ? parsed.events : [],
      }
    } catch (error) {
      console.warn("Failed to load local phone relay store:", error)
      return {
        activePairing: null,
        devices: [],
        events: [],
      }
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.storePath, JSON.stringify(this.storedData, null, 2), "utf8")
    } catch (error) {
      console.warn("Failed to persist local phone relay store:", error)
    }
  }

  private refreshState(
    serverStatus: LocalPhoneRelayState["serverStatus"],
    lastError: string | null
  ): void {
    this.expirePendingPairingIfNeeded()
    this.state = this.buildPublicState(serverStatus, lastError)
    for (const listener of this.listeners) {
      listener(this.getState())
    }
  }

  private buildPublicState(
    serverStatus: LocalPhoneRelayState["serverStatus"],
    lastError: string | null
  ): LocalPhoneRelayState {
    const apiBaseUrl = this.getApiBaseUrl()
    const activePairing = this.storedData.activePairing
    const cameraFrame = this.latestCameraFrame
    const cameraActive =
      Boolean(cameraFrame) &&
      Date.now() - new Date(cameraFrame!.updatedAt).getTime() < CAMERA_ACTIVE_TTL_MS
    const cameraSnapshotUrl =
      apiBaseUrl && cameraFrame
        ? `${apiBaseUrl}/api/camera/latest.jpg?token=${this.cameraViewerToken}`
        : null
    const cameraStreamUrl =
      apiBaseUrl && cameraFrame
        ? `${apiBaseUrl}/api/camera.mjpeg?token=${this.cameraViewerToken}`
        : null
    const devices = this.storedData.devices
      .filter((device) => device.status === "paired")
      .sort((left, right) => {
        const leftValue = left.lastSeenAt || left.pairedAt || left.updatedAt || ""
        const rightValue = right.lastSeenAt || right.pairedAt || right.updatedAt || ""
        return leftValue < rightValue ? 1 : -1
      })
      .map(toSummary)

    return {
      serverStatus,
      apiBaseUrl,
      desktopDeviceName: activePairing?.desktopDeviceName || this.desktopDeviceName,
      camera: {
        active: cameraActive,
        mobileDeviceName: cameraFrame?.mobileDeviceName || null,
        facing: cameraFrame?.facing || null,
        width: cameraFrame?.width || null,
        height: cameraFrame?.height || null,
        frameCount: cameraFrame?.frameCount || 0,
        updatedAt: cameraFrame?.updatedAt || null,
        snapshotUrl: cameraSnapshotUrl,
        streamUrl: cameraStreamUrl,
      },
      activePairing: activePairing ? toSummary(activePairing) : null,
      activeManualCode:
        activePairing && apiBaseUrl && activePairing.pairingToken
          ? this.buildManualCode(apiBaseUrl, activePairing)
          : null,
      activeQrPayload:
        activePairing && apiBaseUrl && activePairing.pairingToken
          ? this.buildQrPayload(apiBaseUrl, activePairing)
          : null,
      devices,
      events: this.storedData.events.slice(0, MAX_EVENTS),
      lastError,
    }
  }

  private async listenOnPort(port: number): Promise<void> {
    if (this.server) {
      this.server.close()
      this.server = null
    }

    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response)
    })

    await new Promise<void>((resolve, reject) => {
      const handleError = (error: Error) => {
        this.server?.removeListener("listening", handleListening)
        reject(error)
      }
      const handleListening = () => {
        this.server?.removeListener("error", handleError)
        resolve()
      }

      this.server?.once("error", handleError)
      this.server?.once("listening", handleListening)
      this.server?.listen(port, "0.0.0.0")
    })
  }

  private async handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    try {
      this.applyCorsHeaders(response)

      if (request.method === "OPTIONS") {
        response.statusCode = 204
        response.end()
        return
      }

      const url = new URL(request.url || "/", "http://127.0.0.1")

      if (request.method === "GET" && url.pathname === "/health") {
        this.sendJson(response, 200, {
          ok: true,
          desktopDeviceName: this.desktopDeviceName,
        })
        return
      }

      if (request.method === "POST" && url.pathname === "/api/pairings/complete") {
        const body = await this.readJsonBody(request)
        const result = this.completePairing(body)
        this.sendJson(response, 200, result)
        return
      }

      if (request.method === "GET" && url.pathname === "/api/events") {
        const events = this.listEventsForDevice(url)
        this.sendJson(response, 200, { events })
        return
      }

      if (request.method === "POST" && url.pathname === "/api/events") {
        const body = await this.readJsonBody(request)
        const result = this.recordEvent(body)
        this.sendJson(response, 200, { event: result })
        return
      }

      if (request.method === "POST" && url.pathname === "/api/remote-input") {
        const body = await this.readJsonBody(request)
        await this.handleRemoteInputRequest(body)
        this.sendJson(response, 200, { success: true })
        return
      }

      if (request.method === "POST" && url.pathname === "/api/files") {
        const result = await this.saveUploadedFile(request, url)
        this.sendJson(response, 200, result)
        return
      }

      if (request.method === "POST" && url.pathname === "/api/camera/frame") {
        await this.saveCameraFrame(request, url)
        this.sendJson(response, 200, { success: true })
        return
      }

      if (request.method === "GET" && url.pathname === "/api/camera/latest.jpg") {
        this.sendLatestCameraFrame(response, url)
        return
      }

      if (request.method === "GET" && url.pathname === "/api/camera.mjpeg") {
        this.streamCameraFrames(response, url)
        return
      }

      if (request.method === "GET" && url.pathname === "/api/desktop/screen.jpg") {
        await this.sendDesktopScreenFrame(response, url)
        return
      }

      this.sendJson(response, 404, { error: "Route not found." })
    } catch (error) {
      this.sendJson(response, 400, {
        error:
          error instanceof Error
            ? error.message
            : "Failed to process the local phone relay request.",
      })
    }
  }

  private listEventsForDevice(url: URL): LocalPhoneRelayEventSummary[] {
    const pairingId = String(url.searchParams.get("pairingId") || "").trim()
    const deviceToken = String(url.searchParams.get("deviceToken") || "").trim()
    const after = String(url.searchParams.get("after") || "").trim()

    const device = this.storedData.devices.find(
      (item) => item.id === pairingId && item.deviceToken === deviceToken
    )

    if (!device) {
      throw new Error("This phone is not paired with the desktop.")
    }

    const now = new Date().toISOString()
    device.lastSeenAt = now
    device.updatedAt = now
    this.persist()
    this.refreshState("ready", null)

    const afterTime = after ? new Date(after).getTime() : 0
    return this.storedData.events
      .filter((event) => event.pairingId === device.id)
      .filter((event) => {
        if (!afterTime || !event.createdAt) {
          return true
        }

        return new Date(event.createdAt).getTime() > afterTime
      })
      .slice(0, MAX_EVENTS)
  }

  private getPairedDeviceFromBody(body: unknown): StoredPairingSession {
    const pairingId = String((body as any)?.pairingId || "").trim()
    const deviceToken = String((body as any)?.deviceToken || "").trim()
    const device = this.storedData.devices.find(
      (item) => item.id === pairingId && item.deviceToken === deviceToken
    )

    if (!device) {
      throw new Error("This phone is not paired with the desktop.")
    }

    return device
  }

  private async handleRemoteInputRequest(body: unknown): Promise<void> {
    const device = this.getPairedDeviceFromBody(body)
    const payload =
      body && typeof body === "object" && typeof (body as any).payload === "object"
        ? ((body as any).payload as Record<string, unknown>)
        : {}
    const input = this.normalizeRemoteInputPayload(payload)

    if (!this.deps.handleRemoteInput) {
      throw new Error("Remote input is not available on this desktop.")
    }

    const now = new Date().toISOString()
    device.lastSeenAt = now
    device.updatedAt = now
    this.persist()
    this.refreshState("ready", null)

    await this.deps.handleRemoteInput(input)
  }

  private normalizeRemoteInputPayload(
    payload: Record<string, unknown>
  ): LocalPhoneRemoteInputPayload {
    const type = String(payload.type || "").trim()

    if (type === "mouse_move_delta") {
      return {
        type,
        dx: clampRemoteNumber(payload.dx, -2400, 2400),
        dy: clampRemoteNumber(payload.dy, -2400, 2400),
      }
    }

    if (type === "mouse_move_absolute") {
      return {
        type,
        normalizedX: clampRemoteNumber(
          Number(payload.normalizedX) * 10000,
          0,
          10000
        ) / 10000,
        normalizedY: clampRemoteNumber(
          Number(payload.normalizedY) * 10000,
          0,
          10000
        ) / 10000,
      }
    }

    if (type === "mouse_click_absolute") {
      const rawButton = String(payload.button || "left").trim()
      const button =
        rawButton === "right" || rawButton === "middle" ? rawButton : "left"
      return {
        type,
        normalizedX: clampRemoteNumber(
          Number(payload.normalizedX) * 10000,
          0,
          10000
        ) / 10000,
        normalizedY: clampRemoteNumber(
          Number(payload.normalizedY) * 10000,
          0,
          10000
        ) / 10000,
        button,
        double: Boolean(payload.double),
      }
    }

    if (type === "mouse_click") {
      const rawButton = String(payload.button || "left").trim()
      const button =
        rawButton === "right" || rawButton === "middle" ? rawButton : "left"
      return {
        type,
        button,
        double: Boolean(payload.double),
      }
    }

    if (type === "mouse_scroll") {
      const deltaY = clampRemoteNumber(payload.deltaY, -12000, 12000)
      const deltaX = clampRemoteNumber(payload.deltaX, -12000, 12000)
      if (deltaY === 0 && deltaX === 0) {
        throw new Error("Remote scroll delta is required.")
      }
      return { type, deltaY, deltaX }
    }

    if (type === "keyboard_type") {
      const text = String(payload.text || "").slice(0, 2000)
      if (!text) {
        throw new Error("Keyboard text is required.")
      }
      return { type, text }
    }

    if (type === "keyboard_press") {
      const keys = String(payload.keys || "").trim().slice(0, 80)
      if (!keys) {
        throw new Error("Keyboard shortcut is required.")
      }
      return { type, keys }
    }

    throw new Error("Unsupported remote input type.")
  }

  private completePairing(body: unknown): CompleteLocalPhonePairingResponse {
    const pairingId = String((body as any)?.pairingId || "").trim()
    const pairingToken = String((body as any)?.pairingToken || "").trim()
    const mobileDeviceName =
      String((body as any)?.mobileDeviceName || "").trim() || "Sylica Mobile"

    if (!pairingId || !pairingToken) {
      throw new Error("Missing pairing credentials.")
    }

    const activePairing = this.storedData.activePairing
    if (
      !activePairing ||
      activePairing.id !== pairingId ||
      activePairing.pairingToken !== pairingToken
    ) {
      throw new Error("That pairing code is no longer valid.")
    }

    if (this.isExpired(activePairing.expiresAt)) {
      activePairing.status = "expired"
      activePairing.updatedAt = new Date().toISOString()
      this.persist()
      this.refreshState("ready", null)
      throw new Error("That pairing code has expired. Start a new pairing from the desktop.")
    }

    const now = new Date().toISOString()
    const pairedDevice: StoredPairingSession = {
      ...activePairing,
      mobileDeviceName,
      status: "paired",
      updatedAt: now,
      pairedAt: now,
      lastSeenAt: now,
      deviceToken: createSecret(),
      pairingToken: null,
    }

    this.storedData.devices = [
      pairedDevice,
      ...this.storedData.devices.filter((device) => device.id !== pairedDevice.id),
    ]
    this.storedData.activePairing = null
    this.persist()
    this.refreshState("ready", null)

    const apiBaseUrl = this.getApiBaseUrl()
    if (!apiBaseUrl) {
      throw new Error("No local network address is available on the desktop.")
    }

    return {
      pairing: toSummary(pairedDevice),
      deviceToken: pairedDevice.deviceToken || "",
      apiBaseUrl,
    }
  }

  private recordEvent(body: unknown): LocalPhoneRelayEventSummary {
    const pairingId = String((body as any)?.pairingId || "").trim()
    const deviceToken = String((body as any)?.deviceToken || "").trim()
    const eventType = String((body as any)?.eventType || "").trim() as LocalPhoneRelayEventType
    const payload =
      body && typeof body === "object" && typeof (body as any).payload === "object"
        ? ((body as any).payload as Record<string, unknown>)
        : {}

    const device = this.storedData.devices.find(
      (item) => item.id === pairingId && item.deviceToken === deviceToken
    )

    if (!device) {
      throw new Error("This phone is not paired with the desktop.")
    }

    if (!SUPPORTED_EVENT_TYPES.includes(eventType)) {
      throw new Error("Unsupported phone relay event type.")
    }

    const normalizedPayload = this.normalizeEventPayload(eventType, payload)

    if (eventType === "clipboard") {
      const clipboardText = String(normalizedPayload.text || "").trim()
      if (clipboardText) {
        try {
          clipboard.writeText(clipboardText)
        } catch (error) {
          console.warn("Failed to sync phone clipboard to desktop clipboard:", error)
        }
      }
    }

    const event = this.appendRelayEvent(
      device,
      eventType,
      normalizedPayload,
      "mobile"
    )

    if (eventType === "computer_command") {
      this.startMobileComputerCommand(device, event)
    }

    if (eventType === "desktop_command") {
      this.startMobileDesktopCommand(device, event)
    }

    return event
  }

  private async saveUploadedFile(
    request: http.IncomingMessage,
    url: URL
  ): Promise<{
    file: Record<string, unknown>
    event: LocalPhoneRelayEventSummary
  }> {
    const pairingId = String(url.searchParams.get("pairingId") || "").trim()
    const deviceToken = String(url.searchParams.get("deviceToken") || "").trim()
    const originalFileName = sanitizePathSegment(
      String(url.searchParams.get("fileName") || "").trim(),
      "phone-upload"
    )
    const relativePath = String(
      url.searchParams.get("relativePath") || originalFileName
    ).trim()
    const batchId = sanitizePathSegment(
      String(url.searchParams.get("batchId") || "").trim() ||
        new Date().toISOString().replace(/[:.]/g, "-"),
      "mobile-upload"
    )
    const mimeType = String(
      url.searchParams.get("mimeType") ||
        request.headers["content-type"] ||
        "application/octet-stream"
    )
      .split(";")[0]
      .trim()
      .slice(0, 140)

    const device = this.storedData.devices.find(
      (item) => item.id === pairingId && item.deviceToken === deviceToken
    )

    if (!device) {
      throw new Error("This phone is not paired with the desktop.")
    }

    const declaredSize = Number(request.headers["content-length"] || 0)
    if (declaredSize > MAX_FILE_UPLOAD_BYTES) {
      throw new Error("File upload is too large. Limit is 512 MB per file.")
    }

    const rootDirectory = this.getPhoneUploadRootDirectory()
    const batchDirectory = path.join(rootDirectory, batchId)
    const safeSegments = sanitizeRelativeUploadPath(relativePath, originalFileName)
    const requestedPath = path.join(batchDirectory, ...safeSegments)
    const targetPath = this.getUniqueUploadPath(requestedPath)

    if (!this.isPathInside(batchDirectory, targetPath)) {
      throw new Error("Invalid upload path.")
    }

    console.log(
      `[phone-relay] Upload starting: ${originalFileName} -> ${targetPath}`
    )
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    const size = await this.writeRequestBodyToFile(request, targetPath)
    const now = new Date().toISOString()
    const payload: Record<string, unknown> = {
      batchId,
      originalFileName,
      savedFileName: path.basename(targetPath),
      relativePath: safeSegments.join("/"),
      savedRelativePath: path.relative(rootDirectory, targetPath),
      savedPath: targetPath,
      savedDirectory: path.dirname(targetPath),
      rootDirectory,
      size,
      mimeType,
      uploadedAt: now,
      source: "android",
    }

    const event = this.appendRelayEvent(device, "file", payload, "mobile")
    console.log(
      `[phone-relay] Upload saved: ${originalFileName} (${size} bytes) -> ${targetPath}`
    )
    return { file: payload, event }
  }

  private getPairedDeviceFromUrl(url: URL): StoredPairingSession {
    const pairingId = String(url.searchParams.get("pairingId") || "").trim()
    const deviceToken = String(url.searchParams.get("deviceToken") || "").trim()
    const device = this.storedData.devices.find(
      (item) => item.id === pairingId && item.deviceToken === deviceToken
    )

    if (!device) {
      throw new Error("This phone is not paired with the desktop.")
    }

    return device
  }

  private async saveCameraFrame(
    request: http.IncomingMessage,
    url: URL
  ): Promise<void> {
    const device = this.getPairedDeviceFromUrl(url)
    const frame = await this.readBinaryBody(request, MAX_CAMERA_FRAME_BYTES)
    if (frame.length < 64) {
      throw new Error("Camera frame is empty.")
    }

    const now = new Date().toISOString()
    const rawFacing = String(url.searchParams.get("facing") || "").trim()
    const facing = rawFacing === "back" || rawFacing === "front" ? rawFacing : null
    const width = clampRemoteNumber(url.searchParams.get("width"), 0, 10000) || null
    const height = clampRemoteNumber(url.searchParams.get("height"), 0, 10000) || null

    device.lastSeenAt = now
    device.updatedAt = now
    this.latestCameraFrame = {
      id: (this.latestCameraFrame?.id || 0) + 1,
      pairingId: device.id,
      mobileDeviceName: device.mobileDeviceName,
      facing,
      width,
      height,
      frameCount:
        this.latestCameraFrame?.pairingId === device.id
          ? this.latestCameraFrame.frameCount + 1
          : 1,
      updatedAt: now,
      data: frame,
    }

    this.persist()
    this.refreshState("ready", null)
  }

  private validateCameraViewer(url: URL): void {
    const token = String(url.searchParams.get("token") || "").trim()
    if (!token || token !== this.cameraViewerToken) {
      throw new Error("Camera stream token is invalid.")
    }
  }

  private sendLatestCameraFrame(response: http.ServerResponse, url: URL): void {
    this.validateCameraViewer(url)
    if (!this.latestCameraFrame) {
      response.statusCode = 404
      response.setHeader("Content-Type", "text/plain; charset=utf-8")
      response.end("No phone camera frame is available.")
      return
    }

    response.statusCode = 200
    response.setHeader("Content-Type", "image/jpeg")
    response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
    response.setHeader("Pragma", "no-cache")
    response.end(this.latestCameraFrame.data)
  }

  private streamCameraFrames(response: http.ServerResponse, url: URL): void {
    this.validateCameraViewer(url)
    response.statusCode = 200
    response.setHeader("Content-Type", "multipart/x-mixed-replace; boundary=sylica-frame")
    response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
    response.setHeader("Pragma", "no-cache")
    response.setHeader("Connection", "close")
    response.flushHeaders?.()

    let lastFrameId = -1
    const writeFrame = () => {
      const frame = this.latestCameraFrame
      if (!frame || frame.id === lastFrameId || response.destroyed) {
        return
      }

      lastFrameId = frame.id
      response.write(
        `--sylica-frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.data.length}\r\n\r\n`
      )
      response.write(frame.data)
      response.write("\r\n")
    }

    writeFrame()
    const timer = setInterval(writeFrame, 125)
    response.on("close", () => clearInterval(timer))
  }

  private async sendDesktopScreenFrame(
    response: http.ServerResponse,
    url: URL
  ): Promise<void> {
    const device = this.getPairedDeviceFromUrl(url)
    const now = new Date().toISOString()
    device.lastSeenAt = now
    device.updatedAt = now
    this.persist()

    const primaryDisplay = screen.getPrimaryDisplay()
    const sourceWidth = Math.max(640, primaryDisplay.bounds.width || 1280)
    const sourceHeight = Math.max(360, primaryDisplay.bounds.height || 720)
    const targetWidth = clampRemoteNumber(url.searchParams.get("width"), 480, 1920) || 1280
    const targetHeight = Math.max(270, Math.round(targetWidth * sourceHeight / sourceWidth))
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: targetWidth,
        height: targetHeight,
      },
      fetchWindowIcons: false,
    })
    const source =
      sources.find((item) => item.display_id === String(primaryDisplay.id)) ||
      sources[0]

    if (!source || source.thumbnail.isEmpty()) {
      throw new Error("Desktop screen capture is not available.")
    }

    const frame = source.thumbnail.toJPEG(DESKTOP_SCREEN_JPEG_QUALITY)
    response.statusCode = 200
    response.setHeader("Content-Type", "image/jpeg")
    response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
    response.setHeader("Pragma", "no-cache")
    response.end(frame)
  }

  private getPhoneUploadRootDirectory(): string {
    return path.join(app.getPath("documents"), "Sylica", "Phone Uploads")
  }

  private getUniqueUploadPath(requestedPath: string): string {
    if (!fs.existsSync(requestedPath)) {
      return requestedPath
    }

    const directory = path.dirname(requestedPath)
    const extension = path.extname(requestedPath)
    const baseName = path.basename(requestedPath, extension)

    for (let index = 1; index < 10000; index += 1) {
      const candidate = path.join(directory, `${baseName} (${index})${extension}`)
      if (!fs.existsSync(candidate)) {
        return candidate
      }
    }

    return path.join(directory, `${baseName}-${createId()}${extension}`)
  }

  private isPathInside(parentPath: string, childPath: string): boolean {
    const relativePath = path.relative(parentPath, childPath)
    return Boolean(relativePath) && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
  }

  private async writeRequestBodyToFile(
    request: http.IncomingMessage,
    targetPath: string
  ): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      let settled = false
      let totalSize = 0
      const output = fs.createWriteStream(targetPath, { flags: "wx" })

      const fail = (error: Error) => {
        if (settled) {
          return
        }
        settled = true
        output.destroy()
        fs.rm(targetPath, { force: true }, () => {})
        reject(error)
      }

      request.setTimeout(120_000, () => {
        fail(new Error("File upload timed out before the phone finished sending data."))
        request.destroy()
      })

      request.on("data", (chunk) => {
        if (settled) {
          return
        }

        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        totalSize += buffer.length
        if (totalSize > MAX_FILE_UPLOAD_BYTES) {
          fail(new Error("File upload is too large. Limit is 512 MB per file."))
          request.destroy()
          return
        }

        if (!output.write(buffer)) {
          request.pause()
          output.once("drain", () => request.resume())
        }
      })

      request.on("end", () => {
        if (settled) {
          return
        }

        output.end(() => {
          settled = true
          resolve(totalSize)
        })
      })

      request.on("aborted", () => fail(new Error("File upload was interrupted.")))
      request.on("error", (error) =>
        fail(error instanceof Error ? error : new Error("File upload failed."))
      )
      output.on("error", (error) =>
        fail(error instanceof Error ? error : new Error("Failed to save uploaded file."))
      )
    })
  }

  private async readBinaryBody(
    request: http.IncomingMessage,
    maxBytes: number
  ): Promise<Buffer> {
    return await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      let totalSize = 0

      request.on("data", (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        totalSize += buffer.length
        if (totalSize > maxBytes) {
          reject(new Error("Camera frame is too large."))
          request.destroy()
          return
        }
        chunks.push(buffer)
      })

      request.on("end", () => resolve(Buffer.concat(chunks)))
      request.on("aborted", () => reject(new Error("Camera frame upload was interrupted.")))
      request.on("error", (error) =>
        reject(error instanceof Error ? error : new Error("Camera frame upload failed."))
      )
    })
  }

  private normalizeEventPayload(
    eventType: LocalPhoneRelayEventType,
    payload: Record<string, unknown>
  ): Record<string, unknown> {
    if (eventType === "desktop_command") {
      const command = normalizeDesktopCommandName(payload.command)
      return {
        ...payload,
        command,
        commandId: String(payload.commandId || "").trim() || createId(),
        requestedAt:
          String(payload.requestedAt || "").trim() || new Date().toISOString(),
        source: String(payload.source || "").trim() || "android",
      }
    }

    if (eventType !== "computer_command") {
      return payload
    }

    const command = String(payload.command || "").trim()
    if (!command) {
      throw new Error("Computer command text is required.")
    }

    if (command.length > 4000) {
      throw new Error("Computer command is too long.")
    }

    return {
      ...payload,
      command,
      commandId: String(payload.commandId || "").trim() || createId(),
      requestedAt:
        String(payload.requestedAt || "").trim() || new Date().toISOString(),
      source: String(payload.source || "").trim() || "android",
    }
  }

  private appendRelayEvent(
    device: StoredPairingSession,
    eventType: LocalPhoneRelayEventType,
    payload: Record<string, unknown>,
    source: "mobile" | "desktop"
  ): LocalPhoneRelayEventSummary {
    const now = new Date().toISOString()

    if (source === "mobile") {
      device.lastSeenAt = now
      device.updatedAt = now
    }

    const event: LocalPhoneRelayEventSummary = {
      id: createId(),
      pairingId: device.id,
      source,
      eventType,
      payload,
      createdAt: now,
      pairing: {
        desktopDeviceName: device.desktopDeviceName,
        mobileDeviceName: device.mobileDeviceName,
      },
    }

    this.storedData.events = [event, ...this.storedData.events].slice(0, MAX_EVENTS)
    this.persist()
    this.refreshState("ready", null)
    return event
  }

  private appendComputerCommandStatus(
    device: StoredPairingSession,
    commandId: string,
    status: string,
    message: string,
    extraPayload: Record<string, unknown> = {}
  ): void {
    this.appendRelayEvent(
      device,
      "computer_command_status",
      {
        commandId,
        status,
        message,
        updatedAt: new Date().toISOString(),
        ...extraPayload,
      },
      "desktop"
    )
  }

  private appendDesktopCommandStatus(
    device: StoredPairingSession,
    commandId: string,
    command: DesktopCommandName,
    status: string,
    message: string,
    extraPayload: Record<string, unknown> = {}
  ): void {
    this.appendRelayEvent(
      device,
      "desktop_command_status",
      {
        commandId,
        command,
        status,
        message,
        updatedAt: new Date().toISOString(),
        ...extraPayload,
      },
      "desktop"
    )
  }

  private startMobileComputerCommand(
    device: StoredPairingSession,
    event: LocalPhoneRelayEventSummary
  ): void {
    const command = String(event.payload.command || "").trim()
    const commandId = String(event.payload.commandId || event.id).trim()

    this.appendComputerCommandStatus(
      device,
      commandId,
      "queued",
      "Queued on the desktop.",
      {
        commandEventId: event.id,
      }
    )

    void (async () => {
      if (!this.deps.startComputerTask) {
        this.appendComputerCommandStatus(
          device,
          commandId,
          "error",
          "Computer Use is not available on this desktop.",
          {
            commandEventId: event.id,
          }
        )
        return
      }

      try {
        const result = await this.deps.startComputerTask(command)
        if (result.success === false) {
          this.appendComputerCommandStatus(
            device,
            commandId,
            "error",
            result.error || "Failed to start the desktop task.",
            {
              commandEventId: event.id,
              authRequired: Boolean(result.authRequired),
            }
          )
          return
        }

        const threadId = result.data.state.threadId || result.data.thread.id
        this.mobileCommandByThreadId.set(threadId, {
          commandId,
          pairingId: device.id,
        })
        this.appendComputerCommandStatus(
          device,
          commandId,
          "running",
          result.data.state.currentAction || "Computer task is running.",
          {
            commandEventId: event.id,
            threadId,
            task: command,
            stepCount: result.data.state.stepCount,
          }
        )
      } catch (error) {
        this.appendComputerCommandStatus(
          device,
          commandId,
          "error",
          error instanceof Error
            ? error.message
            : "Failed to start the desktop task.",
          {
            commandEventId: event.id,
          }
        )
      }
    })()
  }

  private startMobileDesktopCommand(
    device: StoredPairingSession,
    event: LocalPhoneRelayEventSummary
  ): void {
    const command = normalizeDesktopCommandName(event.payload.command)
    const commandId = String(event.payload.commandId || event.id).trim()
    const label = command === "analyze_screen" ? "Analyze screen" : "Reset desktop"

    this.appendDesktopCommandStatus(
      device,
      commandId,
      command,
      "queued",
      `${label} queued on the desktop.`,
      {
        commandEventId: event.id,
      }
    )

    void (async () => {
      const runner =
        command === "analyze_screen" ? this.deps.analyzeScreen : this.deps.resetDesktop

      if (!runner) {
        this.appendDesktopCommandStatus(
          device,
          commandId,
          command,
          "error",
          `${label} is not available on this desktop.`,
          {
            commandEventId: event.id,
          }
        )
        return
      }

      try {
        this.appendDesktopCommandStatus(
          device,
          commandId,
          command,
          "running",
          command === "analyze_screen"
            ? "Capturing and analyzing the desktop screen."
            : "Resetting the desktop workspace.",
          {
            commandEventId: event.id,
          }
        )

        await runner()

        this.appendDesktopCommandStatus(
          device,
          commandId,
          command,
          "completed",
          command === "analyze_screen"
            ? "Screen analysis completed on the desktop."
            : "Desktop reset completed.",
          {
            commandEventId: event.id,
          }
        )
      } catch (error) {
        this.appendDesktopCommandStatus(
          device,
          commandId,
          command,
          "error",
          error instanceof Error ? error.message : `${label} failed.`,
          {
            commandEventId: event.id,
          }
        )
      }
    })()
  }

  private handleComputerUseState(state: ComputerUseState): void {
    if (!state.threadId) {
      return
    }

    const mobileCommand = this.mobileCommandByThreadId.get(state.threadId)
    if (!mobileCommand) {
      return
    }

    const statusKey = [
      state.status,
      state.currentAction,
      state.latestError,
      state.stepCount,
    ].join("|")
    if (this.lastComputerStatusKeys.get(state.threadId) === statusKey) {
      return
    }
    this.lastComputerStatusKeys.set(state.threadId, statusKey)

    const device = this.storedData.devices.find(
      (item) => item.id === mobileCommand.pairingId
    )
    if (!device) {
      this.mobileCommandByThreadId.delete(state.threadId)
      this.lastComputerStatusKeys.delete(state.threadId)
      return
    }

    const message =
      state.latestError ||
      state.currentAction ||
      (state.status === "completed"
        ? "Computer task completed."
        : "Computer task updated.")

    this.appendComputerCommandStatus(
      device,
      mobileCommand.commandId,
      state.status,
      message,
      {
        threadId: state.threadId,
        task: state.task,
        stepCount: state.stepCount,
        currentUrl: state.currentUrl,
        currentTitle: state.currentTitle,
        needsSecretInput: state.needsSecretInput,
      }
    )

    if (state.status === "completed" || state.status === "error") {
      this.mobileCommandByThreadId.delete(state.threadId)
      this.lastComputerStatusKeys.delete(state.threadId)
    }
  }

  private buildManualCode(apiBaseUrl: string, pairing: StoredPairingSession): string {
    return `${apiBaseUrl}|${pairing.id}|${pairing.pairingToken || ""}`
  }

  private buildQrPayload(
    apiBaseUrl: string,
    pairing: StoredPairingSession
  ): LocalPhonePairingQrPayload {
    return {
      type: "sylica-local-phone-relay",
      version: 1,
      apiBaseUrl,
      pairingId: pairing.id,
      pairingToken: pairing.pairingToken || "",
    }
  }

  private getActivePairingResponse(): CreateLocalPhonePairingSessionResponse {
    const activePairing = this.storedData.activePairing
    const apiBaseUrl = this.getApiBaseUrl()

    if (!activePairing || !apiBaseUrl) {
      throw new Error("Local pairing is not available right now.")
    }

    return {
      pairing: toSummary(activePairing),
      manualCode: this.buildManualCode(apiBaseUrl, activePairing),
      qrPayload: this.buildQrPayload(apiBaseUrl, activePairing),
    }
  }

  private getApiBaseUrl(): string | null {
    if (!this.port) {
      return null
    }

    const host = pickLanAddress()
    if (!host) {
      return null
    }

    return `http://${host}:${this.port}`
  }

  private isExpired(value: string | null): boolean {
    if (!value) {
      return false
    }

    return Date.now() >= new Date(value).getTime()
  }

  private expirePendingPairingIfNeeded(): void {
    if (
      this.storedData.activePairing &&
      this.storedData.activePairing.status === "pending" &&
      this.isExpired(this.storedData.activePairing.expiresAt)
    ) {
      this.storedData.activePairing.status = "expired"
      this.storedData.activePairing.updatedAt = new Date().toISOString()
      this.storedData.activePairing = null
      this.persist()
    }
  }

  private applyCorsHeaders(response: http.ServerResponse): void {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type")
  }

  private async readJsonBody(request: http.IncomingMessage): Promise<unknown> {
    return await new Promise<unknown>((resolve, reject) => {
      const chunks: Buffer[] = []

      request.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        const size = chunks.reduce((total, buffer) => total + buffer.length, 0)
        if (size > 256 * 1024) {
          reject(new Error("Request body is too large."))
        }
      })

      request.on("end", () => {
        try {
          const rawValue = Buffer.concat(chunks).toString("utf8").trim()
          resolve(rawValue ? JSON.parse(rawValue) : {})
        } catch (error) {
          reject(new Error("Invalid JSON body."))
        }
      })

      request.on("error", reject)
    }).catch((error) => {
      throw error instanceof Error ? error : new Error("Failed to read request body.")
    })
  }

  private sendJson(
    response: http.ServerResponse,
    statusCode: number,
    payload: unknown
  ): void {
    response.statusCode = statusCode
    response.setHeader("Content-Type", "application/json; charset=utf-8")
    response.end(JSON.stringify(payload))
  }
}
