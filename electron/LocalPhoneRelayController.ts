import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { app, clipboard } from "electron"
import type {
  CompleteLocalPhonePairingResponse,
  CreateLocalPhonePairingSessionResponse,
  LocalPhonePairingQrPayload,
  LocalPhonePairingSessionSummary,
  LocalPhoneRelayEventSummary,
  LocalPhoneRelayEventType,
  LocalPhoneRelayState,
} from "../shared/localPhoneRelay"

interface StoredPairingSession extends LocalPhonePairingSessionSummary {
  pairingToken: string | null
  deviceToken: string | null
}

interface StoredLocalPhoneRelayData {
  activePairing: StoredPairingSession | null
  devices: StoredPairingSession[]
  events: LocalPhoneRelayEventSummary[]
}

const PREFERRED_PORTS = [39393, 39394, 39395, 39396, 39397]
const MAX_EVENTS = 40
const PAIRING_TTL_MS = 10 * 60 * 1000

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

  constructor(private readonly desktopDeviceName = "Sylica AI Desktop") {
    this.storePath = path.join(app.getPath("userData"), "local-phone-relay.json")
    this.storedData = this.loadStoredData()
    this.expirePendingPairingIfNeeded()
    this.state = this.buildPublicState("offline", null)
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
    if (!this.server) {
      return
    }

    this.server.close()
    this.server = null
    this.port = null
    this.refreshState("offline", null)
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

      if (request.method === "POST" && url.pathname === "/api/events") {
        const body = await this.readJsonBody(request)
        const result = this.recordEvent(body)
        this.sendJson(response, 200, { event: result })
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

    if (!["clipboard", "otp", "link", "note"].includes(eventType)) {
      throw new Error("Unsupported phone relay event type.")
    }

    const now = new Date().toISOString()
    device.lastSeenAt = now
    device.updatedAt = now

    const event: LocalPhoneRelayEventSummary = {
      id: createId(),
      pairingId: device.id,
      source: "mobile",
      eventType,
      payload,
      createdAt: now,
      pairing: {
        desktopDeviceName: device.desktopDeviceName,
        mobileDeviceName: device.mobileDeviceName,
      },
    }

    if (eventType === "clipboard") {
      const clipboardText = String(payload.text || "").trim()
      if (clipboardText) {
        try {
          clipboard.writeText(clipboardText)
        } catch (error) {
          console.warn("Failed to sync phone clipboard to desktop clipboard:", error)
        }
      }
    }

    this.storedData.events = [event, ...this.storedData.events].slice(0, MAX_EVENTS)
    this.persist()
    this.refreshState("ready", null)
    return event
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
