import { app, BrowserWindow, screen, shell, ipcMain, systemPreferences, desktopCapturer } from "electron"
import path from "path"
import fs from "fs"
import { execFileSync } from "child_process"
import { initializeIpcHandlers } from "./ipcHandlers"
import { ProcessingHelper } from "./ProcessingHelper"
import { ScreenshotHelper } from "./ScreenshotHelper"
import { ShortcutsHelper } from "./shortcuts"
import { initAutoUpdater } from "./autoUpdater"
import { configHelper } from "./ConfigHelper"
import { selectScreenRegion } from "./RegionSelectionOverlay"
import { LiveInterviewHelper } from "./LiveInterviewHelper"
import { BrowserAgentController } from "./BrowserAgentController"
import { AgentController } from "./AgentController"
import { LocalPhoneRelayController } from "./LocalPhoneRelayController"
import { GuideCursorController } from "./GuideCursorController"
import { backendClient } from "./BackendClient"
import * as dotenv from "dotenv"

// Constants
const isDev = process.env.NODE_ENV === "development"
const IS_LOCAL_DESKTOP_TEST =
  process.env.SYLICA_LOCAL_DESKTOP_TEST === "1" ||
  process.argv.includes("--sylica-local-desktop-test")
const APP_NAME = IS_LOCAL_DESKTOP_TEST ? "Sylica AI Local" : "Sylica AI"
const APP_ID = IS_LOCAL_DESKTOP_TEST
  ? "com.sylicaai.desktop.local"
  : "com.sylicaai.desktop"
const APP_PROTOCOL = "sylica-ai"
const LEGACY_APP_PROTOCOL = "cheatbit"
const APP_DATA_DIRECTORY = IS_LOCAL_DESKTOP_TEST
  ? "sylica-ai-local"
  : "sylica-ai"
const LEGACY_APP_DATA_DIRECTORY = "cheatbit"
const SHOW_UNINSTALL_OFFBOARDING_EVENT = "show-uninstall-offboarding"
const AUTH_STATE_UPDATED_EVENT = "auth-state-updated"
const INSTANCE_LOCK_FILE = "instance-lock.json"
const MAIN_WINDOW_MIN_WIDTH = 44
const MAIN_WINDOW_MIN_HEIGHT = 40
const IDLE_ISLAND_MIN_WIDTH = 56
const IDLE_ISLAND_MIN_HEIGHT = 18
const IDLE_ISLAND_TARGET_WIDTH = 88
const IDLE_ISLAND_TARGET_HEIGHT = 28
const IDLE_ISLAND_EDGE_OVERLAP = 10

const shouldUseWindowsOpaqueFallback =
  process.env.SYLICA_FORCE_OPAQUE_WINDOW === "1"

app.setName(APP_NAME)
if (process.platform === "win32") {
  app.setAppUserModelId(APP_ID)
  if (shouldUseWindowsOpaqueFallback) {
    app.disableHardwareAcceleration()
    app.commandLine.appendSwitch("disable-gpu-compositing")
  }
}

function configureAppPaths(): void {
  const appDataPath = path.join(app.getPath("appData"), APP_DATA_DIRECTORY)
  migrateLegacyAppDataDirectory(appDataPath)

  const sessionPath = path.join(appDataPath, "session")
  const tempPath = path.join(appDataPath, "temp")
  const cachePath = path.join(appDataPath, "cache")
  const diskCachePath = path.join(cachePath, "disk")
  const mediaCachePath = path.join(cachePath, "media")

  for (const dir of [
    appDataPath,
    sessionPath,
    tempPath,
    cachePath,
    diskCachePath,
    mediaCachePath,
  ]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  app.setPath("userData", appDataPath)
  app.setPath("sessionData", sessionPath)
  app.setPath("temp", tempPath)
  app.setPath("cache", cachePath)
  app.commandLine.appendSwitch("disk-cache-dir", diskCachePath)
  app.commandLine.appendSwitch("media-cache-dir", mediaCachePath)

  if (process.platform === "win32") {
    app.commandLine.appendSwitch("disable-gpu-shader-disk-cache")
  }
}

configureAppPaths()

function quoteWindowsCommandArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`
}

function buildAutoStartCommand(launchArgs: string[]): string {
  return [process.execPath, ...launchArgs].map(quoteWindowsCommandArg).join(" ")
}

function writeWindowsAutoStartRegistryFallback(launchArgs: string[]): void {
  if (process.platform !== "win32") {
    return
  }

  const launchCommand = buildAutoStartCommand(launchArgs)
  execFileSync(
    "reg",
    [
      "add",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
      "/v",
      APP_NAME,
      "/t",
      "REG_SZ",
      "/d",
      launchCommand,
      "/f",
    ],
    { windowsHide: true }
  )
  console.log(`[startup] Windows Run entry registered for ${APP_NAME}`)
}

function configureAutoStart(): void {
  if (process.env.SYLICA_DISABLE_AUTO_START === "1") {
    return
  }

  if (process.argv.includes("--uninstall-flow")) {
    return
  }

  if (process.platform !== "win32" && process.platform !== "darwin") {
    return
  }

  try {
    const isDefaultElectronRunner = process.defaultApp || !app.isPackaged
    const launchArgs: string[] = []

    if (isDefaultElectronRunner) {
      const entryPoint = path.resolve(
        process.argv[1] || "dist-electron/electron/main.js"
      )
      launchArgs.push(entryPoint)
    }

    if (IS_LOCAL_DESKTOP_TEST) {
      launchArgs.push("--sylica-local-desktop-test")
    }

    launchArgs.push("--autostart")

    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: false,
      path: process.execPath,
      args: launchArgs,
      name: APP_NAME,
    })

    const settings = app.getLoginItemSettings({
      path: process.execPath,
      args: launchArgs,
    })
    writeWindowsAutoStartRegistryFallback(launchArgs)
    console.log(
      `[startup] auto-start enabled=${settings.openAtLogin} path=${process.execPath}`
    )
  } catch (error) {
    console.warn("Failed to configure startup auto-launch:", error)
  }
}

// Application State
const state = {
  // Window management properties
  mainWindow: null as BrowserWindow | null,
  phoneRelayWindow: null as BrowserWindow | null,
  isWindowVisible: false,
  windowPosition: null as { x: number; y: number } | null,
  windowSize: null as { width: number; height: number } | null,
  isDynamicIsland: false,
  dynamicIslandRestoreBounds: null as Electron.Rectangle | null,
  overlayGuardTimer: null as ReturnType<typeof setInterval> | null,
  screenWidth: 0,
  screenHeight: 0,
  step: 0,
  currentX: 0,
  currentY: 0,

  // Application helpers
  screenshotHelper: null as ScreenshotHelper | null,
  shortcutsHelper: null as ShortcutsHelper | null,
  processingHelper: null as ProcessingHelper | null,
  liveInterviewHelper: null as LiveInterviewHelper | null,
  browserAgentController: null as BrowserAgentController | null,
  agentController: null as AgentController | null,
  localPhoneRelayController: null as LocalPhoneRelayController | null,
  guideCursorController: null as GuideCursorController | null,
  pendingUninstallOffboarding: false,

  // View and state management
  view: "queue" as "queue" | "solutions" | "debug",
  problemInfo: null as any,
  hasDebugged: false,

  // Processing events
  PROCESSING_EVENTS: {
    UNAUTHORIZED: "processing-unauthorized",
    NO_SCREENSHOTS: "processing-no-screenshots",
    OUT_OF_CREDITS: "out-of-credits",
    API_KEY_INVALID: "api-key-invalid",
    INITIAL_START: "initial-start",
    PROBLEM_EXTRACTED: "problem-extracted",
    SOLUTION_SUCCESS: "solution-success",
    INITIAL_SOLUTION_ERROR: "solution-error",
    DEBUG_START: "debug-start",
    DEBUG_SUCCESS: "debug-success",
    DEBUG_ERROR: "debug-error"
  } as const
}

// Add interfaces for helper classes
export interface IProcessingHelperDeps {
  getScreenshotHelper: () => ScreenshotHelper | null
  getMainWindow: () => BrowserWindow | null
  hideMainWindow: () => void
  showMainWindow: () => void
  getView: () => "queue" | "solutions" | "debug"
  setView: (view: "queue" | "solutions" | "debug") => void
  getProblemInfo: () => any
  setProblemInfo: (info: any) => void
  getScreenshotQueue: () => string[]
  getExtraScreenshotQueue: () => string[]
  clearQueues: () => void
  takeScreenshot: () => Promise<string>
  getImagePreview: (filepath: string) => Promise<string>
  deleteScreenshot: (
    path: string
  ) => Promise<{ success: boolean; error?: string }>
  setHasDebugged: (value: boolean) => void
  getHasDebugged: () => boolean
  publishPhoneRelayResult?: (payload: Record<string, unknown>) => void
  PROCESSING_EVENTS: typeof state.PROCESSING_EVENTS
}

export interface IShortcutsHelperDeps {
  getMainWindow: () => BrowserWindow | null
  getView: () => "queue" | "solutions" | "debug"
  getScreenshotQueue: () => string[]
  getExtraScreenshotQueue: () => string[]
  takeScreenshot: () => Promise<string>
  getImagePreview: (filepath: string) => Promise<string>
  processingHelper: ProcessingHelper | null
  clearQueues: () => void
  setView: (view: "queue" | "solutions" | "debug") => void
  isVisible: () => boolean
  toggleMainWindow: () => void
  moveWindowLeft: () => void
  moveWindowRight: () => void
  moveWindowUp: () => void
  moveWindowDown: () => void
  explainHoveredText: () => Promise<void>
  handleGuideShortcutPress: () => Promise<void>
  PROCESSING_EVENTS: typeof state.PROCESSING_EVENTS
}

export interface IIpcHandlerDeps {
  getMainWindow: () => BrowserWindow | null
  openPhoneRelayWindow: () => Promise<void>
  setWindowDimensions: (width: number, height: number) => void
  setDynamicIslandMode: (collapsed: boolean) => void
  getGuideCursorEnabled: () => boolean
  setGuideCursorEnabled: (enabled: boolean) => boolean
  captureVoiceScreenContext: () => Promise<{ data: string; preview: string }>
  requestMicrophoneAccess: () => Promise<{
    granted: boolean
    status: string
    error?: string
  }>
  getScreenshotQueue: () => string[]
  getExtraScreenshotQueue: () => string[]
  deleteScreenshot: (
    path: string
  ) => Promise<{ success: boolean; error?: string }>
  getImagePreview: (filepath: string) => Promise<string>
  processingHelper: ProcessingHelper | null
  liveInterviewHelper: LiveInterviewHelper | null
  browserAgentController: BrowserAgentController | null
  agentController: AgentController | null
  localPhoneRelayController: LocalPhoneRelayController | null
  PROCESSING_EVENTS: typeof state.PROCESSING_EVENTS
  takeScreenshot: () => Promise<string>
  takeRegionScreenshot: () => Promise<string>
  getView: () => "queue" | "solutions" | "debug"
  toggleMainWindow: () => void
  applyScreenRecordingVisibility: () => void
  clearQueues: () => void
  setView: (view: "queue" | "solutions" | "debug") => void
  moveWindowLeft: () => void
  moveWindowRight: () => void
  moveWindowUp: () => void
  moveWindowDown: () => void
}

// Initialize helpers
function initializeHelpers() {
  state.screenshotHelper = new ScreenshotHelper(state.view)
  state.guideCursorController = new GuideCursorController()
  state.processingHelper = new ProcessingHelper({
    getScreenshotHelper,
    getMainWindow,
    hideMainWindow,
    showMainWindow,
    getView,
    setView,
    getProblemInfo,
    setProblemInfo,
    getScreenshotQueue,
    getExtraScreenshotQueue,
    clearQueues,
    takeScreenshot,
    getImagePreview,
    deleteScreenshot,
    setHasDebugged,
    getHasDebugged,
    publishPhoneRelayResult: (payload) => {
      state.localPhoneRelayController?.publishDesktopEvent("screen_result", payload)
    },
    PROCESSING_EVENTS: state.PROCESSING_EVENTS
  } as IProcessingHelperDeps)
  state.shortcutsHelper = new ShortcutsHelper({
    getMainWindow,
    getView,
    getScreenshotQueue,
    getExtraScreenshotQueue,
    takeScreenshot,
    getImagePreview,
    processingHelper: state.processingHelper,
    clearQueues,
    setView,
    isVisible: () => state.isWindowVisible,
    toggleMainWindow,
    moveWindowLeft: () =>
      moveWindowHorizontal((x) =>
        Math.max(-(state.windowSize?.width || 0) / 2, x - state.step)
      ),
    moveWindowRight: () =>
      moveWindowHorizontal((x) =>
        Math.min(
          state.screenWidth - (state.windowSize?.width || 0) / 2,
          x + state.step
        )
      ),
    moveWindowUp: () => moveWindowVertical((y) => y - state.step),
    moveWindowDown: () => moveWindowVertical((y) => y + state.step),
    explainHoveredText: () =>
      state.guideCursorController?.explainHoveredText() || Promise.resolve(),
    handleGuideShortcutPress: () =>
      state.guideCursorController?.handleGuideShortcutPress() || Promise.resolve(),
    PROCESSING_EVENTS: state.PROCESSING_EVENTS
  } as IShortcutsHelperDeps)
  state.liveInterviewHelper = new LiveInterviewHelper({
    getMainWindow,
    getProcessingHelper: () => state.processingHelper,
  })
  state.browserAgentController = new BrowserAgentController({
    getMainWindow,
  })
  state.agentController = new AgentController({
    getMainWindow,
  })
  state.localPhoneRelayController = new LocalPhoneRelayController(APP_NAME, {
    startComputerTask: (task) => {
      if (!state.browserAgentController) {
        return Promise.resolve({
          success: false as const,
          error: "Computer Use is not available right now.",
        })
      }

      return state.browserAgentController.startTask(task)
    },
    analyzeScreen: analyzeScreenFromPhone,
    resetDesktop: async () => resetDesktopFromPhone(),
    handleRemoteInput: async (input) => {
      if (!state.browserAgentController) {
        throw new Error("Remote input is not available right now.")
      }

      await state.browserAgentController.handleRemoteInput(input)
    },
    subscribeToComputerUseState: (listener) => {
      if (!state.browserAgentController) {
        return () => {}
      }

      return state.browserAgentController.subscribe(listener)
    },
  })
}

/**
 * Returns the appropriate always-on-top level for the main window.
 * When stealth is OFF (screen recording visible / demo mode) we drop to
 * "floating" so screen recorders can capture the app normally.
 * When stealth is ON we use "screen-saver" to stay above capture overlays.
 */
function getAlwaysOnTopLevel(): "screen-saver" | "floating" {
  return configHelper.isScreenRecordingVisible() ? "floating" : "screen-saver"
}

/**
 * Apply the user's "visible to screen recordings" preference to a window.
 * When `screenRecordingVisible` is true (demo mode) we drop content protection,
 * lower the z-level to "floating" so recorders see the window, and let macOS
 * Mission Control / app switcher see the window.
 * When false (default stealth mode) we re-enable all anti-capture flags.
 */
function applyScreenRecordingVisibilityToWindow(
  windowRef: BrowserWindow | null
): void {
  if (!windowRef || windowRef.isDestroyed()) {
    return
  }

  const visible = configHelper.isScreenRecordingVisible()

  try {
    windowRef.setContentProtection(!visible)
  } catch (error) {
    console.warn("Failed to update setContentProtection:", error)
  }

  // Lower z-level when stealth is off so screen recorders can capture the window
  try {
    windowRef.setAlwaysOnTop(true, getAlwaysOnTopLevel(), 1)
  } catch (error) {
    console.warn("Failed to update alwaysOnTop level:", error)
  }

  if (process.platform === "darwin") {
    try {
      windowRef.setHiddenInMissionControl(!visible)
    } catch (error) {
      console.warn("Failed to update setHiddenInMissionControl:", error)
    }
  }

  if (visible) {
    try {
      windowRef.setIgnoreMouseEvents(false)
    } catch (error) {
      console.warn("Failed to restore mouse events for demo mode:", error)
    }
  }

  console.log(
    `[stealth] screenRecordingVisible=${visible} contentProtection=${!visible} alwaysOnTopLevel=${getAlwaysOnTopLevel()}`
  )
}

function applyScreenRecordingVisibilityToMainWindow(): void {
  applyScreenRecordingVisibilityToWindow(state.mainWindow)
  state.guideCursorController?.applyScreenRecordingVisibility()
}

function getConfiguredVisibleOpacity(): number {
  const savedOpacity = configHelper.getOpacity()

  if (!Number.isFinite(savedOpacity)) {
    return 1
  }

  return Math.max(0, Math.min(savedOpacity, 1))
}

function shouldKeepWindowHiddenForOpacity(): boolean {
  if (IS_LOCAL_DESKTOP_TEST) {
    return false
  }

  const savedOpacity = configHelper.getOpacity()

  if (!Number.isFinite(savedOpacity)) {
    return false
  }

  return savedOpacity <= 0
}

function resolveWindowIconPath(): string | undefined {
  if (process.platform !== "win32") {
    return undefined
  }

  const candidates = [
    path.join(process.resourcesPath, "icon.ico"),
    path.join(process.cwd(), "assets", "icons", "win", "icon.ico"),
    path.join(__dirname, "..", "assets", "icons", "win", "icon.ico"),
  ]

  return candidates.find((candidate) => fs.existsSync(candidate))
}

function migrateLegacyAppDataDirectory(targetDirectory: string): void {
  const legacyDirectory = path.join(app.getPath("appData"), LEGACY_APP_DATA_DIRECTORY)

  if (!fs.existsSync(legacyDirectory) || fs.existsSync(targetDirectory)) {
    return
  }

  try {
    fs.renameSync(legacyDirectory, targetDirectory)
    console.log(`Migrated app data directory to ${targetDirectory}`)
  } catch (error) {
    try {
      fs.cpSync(legacyDirectory, targetDirectory, { recursive: true })
      console.log(`Copied legacy app data directory to ${targetDirectory}`)
    } catch (copyError) {
      console.warn("Failed to migrate legacy app data directory:", copyError)
    }
  }
}

function configureMediaPermissions(window: BrowserWindow): void {
  const windowSession = window.webContents.session

  windowSession.setPermissionCheckHandler((webContents, permission) => {
    if (webContents?.id !== window.webContents.id) {
      return false
    }

    return permission === "media"
  })

  windowSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      if (webContents.id !== window.webContents.id) {
        callback(false)
        return
      }

      callback(permission === "media" || permission === "display-capture")
    }
  )

  windowSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 0, height: 0 },
      })

      if (sources.length === 0) {
        callback({})
        return
      }

      callback({
        video: sources[0],
        audio: process.platform === "win32" ? "loopback" : undefined,
      })
    } catch (error) {
      console.error("Failed to provide display media source:", error)
      callback({})
    }
  })
}

function buildMicrophoneAccessError(status: string): string {
  if (process.platform === "win32") {
    return "Microphone access is blocked. Turn it on in Windows Settings > Privacy & security > Microphone."
  }

  if (process.platform === "darwin") {
    return "Microphone access is blocked. Turn it on in System Settings > Privacy & Security > Microphone."
  }

  return `Microphone access is unavailable right now (${status}).`
}

async function requestMicrophoneAccess(): Promise<{
  granted: boolean
  status: string
  error?: string
}> {
  try {
    const status = systemPreferences.getMediaAccessStatus("microphone")

    if (status === "granted") {
      return {
        granted: true,
        status,
      }
    }

    if (process.platform === "darwin" && status === "not-determined") {
      const granted = await systemPreferences.askForMediaAccess("microphone")
      return {
        granted,
        status: granted ? "granted" : "denied",
        error: granted ? undefined : buildMicrophoneAccessError("denied"),
      }
    }

    if (status === "denied" || status === "restricted") {
      return {
        granted: false,
        status,
        error: buildMicrophoneAccessError(status),
      }
    }

    return {
      granted: true,
      status,
    }
  } catch (error) {
    return {
      granted: false,
      status: "unknown",
      error:
        error instanceof Error
          ? error.message
          : "Failed to check microphone access.",
    }
  }
}

async function captureVoiceScreenContext(): Promise<{
  data: string
  preview: string
}> {
  const cursorPoint = screen.getCursorScreenPoint()
  const targetDisplay = screen.getDisplayNearestPoint(cursorPoint)
  const scaleFactor = targetDisplay.scaleFactor || 1
  const thumbnailSize = {
    width: Math.max(640, Math.round(targetDisplay.bounds.width * scaleFactor)),
    height: Math.max(360, Math.round(targetDisplay.bounds.height * scaleFactor)),
  }
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize,
  })
  const source =
    sources.find((candidate) => candidate.display_id === String(targetDisplay.id)) ||
    sources[0]

  if (!source || source.thumbnail.isEmpty()) {
    throw new Error("No screen source was available for realtime voice context.")
  }

  const pngBuffer = source.thumbnail.toPNG()
  const base64 = pngBuffer.toString("base64")
  return {
    data: base64,
    preview: `data:image/png;base64,${base64}`,
  }
}

function isAppProtocolUrl(protocolUrl?: string): boolean {
  return Boolean(
    protocolUrl &&
      (protocolUrl.startsWith(`${APP_PROTOCOL}://`) ||
        protocolUrl.startsWith(`${LEGACY_APP_PROTOCOL}://`))
  )
}

function getDefaultAppProtocolArgs(): string[] {
  const entryPoint = process.argv.find((arg, index) => {
    if (index === 0 || isAppProtocolUrl(arg) || arg.startsWith("--")) {
      return false
    }

    return /\.(c?js|mjs|ts)$/i.test(arg)
  })

  return entryPoint ? [path.resolve(entryPoint)] : []
}

function registerAppProtocolClient(): void {
  const args = process.defaultApp ? getDefaultAppProtocolArgs() : []
  const registered = process.defaultApp
    ? app.setAsDefaultProtocolClient(APP_PROTOCOL, process.execPath, args)
    : app.setAsDefaultProtocolClient(APP_PROTOCOL)

  if (!registered) {
    console.warn(`[protocol] Failed to register ${APP_PROTOCOL}`)
  }

  const legacyRegistered = process.defaultApp
    ? app.setAsDefaultProtocolClient(LEGACY_APP_PROTOCOL, process.execPath, args)
    : app.setAsDefaultProtocolClient(LEGACY_APP_PROTOCOL)

  if (!legacyRegistered) {
    console.warn(`[protocol] Failed to register ${LEGACY_APP_PROTOCOL}`)
  }
}

function getInstanceLockPath(): string {
  return path.join(app.getPath("userData"), INSTANCE_LOCK_FILE)
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    return false
  }

  try {
    process.kill(pid, 0)
    return true
  } catch (_error) {
    return false
  }
}

function getExistingInstancePid(): number | null {
  const lockPath = getInstanceLockPath()
  if (!fs.existsSync(lockPath)) {
    return null
  }

  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
      pid?: unknown
    }
    const pid = typeof lock.pid === "number" ? lock.pid : 0
    if (isProcessAlive(pid)) {
      return pid
    }
  } catch (_error) {
    // Treat malformed lock files as stale.
  }

  try {
    fs.unlinkSync(lockPath)
  } catch (_error) {
    // Ignore stale lock cleanup races.
  }
  return null
}

function writeInstanceLock(): void {
  try {
    fs.writeFileSync(
      getInstanceLockPath(),
      JSON.stringify(
        {
          pid: process.pid,
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      ),
      "utf8"
    )
  } catch (error) {
    console.warn("Failed to write instance lock:", error)
  }
}

function clearInstanceLock(): void {
  const lockPath = getInstanceLockPath()
  if (!fs.existsSync(lockPath)) {
    return
  }

  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
      pid?: unknown
    }
    if (lock.pid === process.pid) {
      fs.unlinkSync(lockPath)
    }
  } catch (_error) {
    try {
      fs.unlinkSync(lockPath)
    } catch (_cleanupError) {
      // Ignore cleanup races.
    }
  }
}

function getPrimaryWorkAreaBounds(): Electron.Rectangle {
  return screen.getPrimaryDisplay().workArea
}

function getDefaultWindowBounds(): Electron.Rectangle {
  const workArea = getPrimaryWorkAreaBounds()
  const width = 320
  const height = 64

  return {
    x: workArea.x + Math.max(0, Math.floor((workArea.width - width) / 2)),
    y: workArea.y + 50,
    width,
    height,
  }
}

function clampWindowBounds(
  bounds: Pick<Electron.Rectangle, "x" | "y" | "width" | "height">
): Electron.Rectangle {
  const workArea = getPrimaryWorkAreaBounds()
  const width = Math.max(MAIN_WINDOW_MIN_WIDTH, Math.min(bounds.width, workArea.width))
  const height = Math.max(MAIN_WINDOW_MIN_HEIGHT, Math.min(bounds.height, workArea.height))

  return {
    x: Math.max(
      workArea.x,
      Math.min(bounds.x, workArea.x + workArea.width - width)
    ),
    y: Math.max(
      workArea.y,
      Math.min(bounds.y, workArea.y + workArea.height - height)
    ),
    width,
    height,
  }
}

function shouldUseTransparentWindow(): boolean {
  return !(process.platform === "win32" && shouldUseWindowsOpaqueFallback)
}

function revealMainWindow(reason: string): void {
  if (!state.mainWindow?.isDestroyed()) {
    const nextBounds = clampWindowBounds(
      state.windowPosition && state.windowSize
        ? {
            ...state.windowPosition,
            ...state.windowSize,
          }
        : state.mainWindow.getBounds()
    )

    state.mainWindow.setBounds(nextBounds)
    state.currentX = nextBounds.x
    state.currentY = nextBounds.y
    state.windowPosition = { x: nextBounds.x, y: nextBounds.y }
    state.windowSize = { width: nextBounds.width, height: nextBounds.height }
    state.mainWindow.setIgnoreMouseEvents(false)
    enforceOverlayTopmost(reason)
    state.mainWindow.showInactive()

    const savedOpacity = getConfiguredVisibleOpacity()
    if (shouldKeepWindowHiddenForOpacity()) {
      state.mainWindow.setOpacity(0)
      state.isWindowVisible = false
      console.log(`[${reason}] Window kept hidden due to saved opacity 0`)
      return
    }

    state.mainWindow.setOpacity(savedOpacity)
    state.isWindowVisible = true
    console.log(
      `[${reason}] Window forced visible at ${nextBounds.width}x${nextBounds.height}, opacity ${savedOpacity}`
    )
  }
}

function enforceOverlayTopmost(reason = "overlay-guard"): void {
  const window = state.mainWindow
  if (!window || window.isDestroyed() || !state.isWindowVisible) {
    return
  }

  try {
    window.setAlwaysOnTop(true, getAlwaysOnTopLevel(), 1)
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
    })

    if (window.isVisible() && !window.isMinimized()) {
      const maybeMoveTop = window as BrowserWindow & { moveTop?: () => void }
      maybeMoveTop.moveTop?.()
    }
  } catch (error) {
    console.warn(`Failed to enforce overlay topmost (${reason}):`, error)
  }
}

function startOverlayGuard(): void {
  if (state.overlayGuardTimer) {
    return
  }

  state.overlayGuardTimer = setInterval(() => {
    enforceOverlayTopmost()
  }, 900)
}

function stopOverlayGuard(): void {
  if (!state.overlayGuardTimer) {
    return
  }

  clearInterval(state.overlayGuardTimer)
  state.overlayGuardTimer = null
}

function showUninstallOffboarding(): void {
  state.pendingUninstallOffboarding = true
  revealMainWindow("uninstall-offboarding")

  if (!state.mainWindow?.isDestroyed()) {
    state.mainWindow.webContents.send(SHOW_UNINSTALL_OFFBOARDING_EVENT)
    state.pendingUninstallOffboarding = false
  }
}

const initialProtocolUrl = process.argv.find((arg) => isAppProtocolUrl(arg))
const existingInstancePid = getExistingInstancePid()
let shouldStartApplication = true

if (
  initialProtocolUrl &&
  existingInstancePid &&
  completeProtocolWebLoginHeadlessly(initialProtocolUrl)
) {
  shouldStartApplication = false
} else {
  writeInstanceLock()

  // Register app protocols without accidentally persisting the callback URL as
  // a launch argument. Packaged Windows protocol launches pass only the URL.
  registerAppProtocolClient()

  // Force Single Instance Lock
  const gotTheLock = app.requestSingleInstanceLock()

  if (!gotTheLock) {
    clearInstanceLock()
    app.quit()
  } else {
    app.on("second-instance", (event, commandLine) => {
      console.log("second-instance event received:", commandLine)

      const protocolUrl = commandLine.find((arg) => isAppProtocolUrl(arg))
      if (protocolUrl) {
        handleProtocolUrl(protocolUrl)
        return
      }

      if (!state.mainWindow) {
        void createWindow()
      } else {
        if (state.mainWindow.isMinimized()) state.mainWindow.restore()
        state.mainWindow.focus()
      }

      if (commandLine.includes("--uninstall-flow")) {
        showUninstallOffboarding()
      }
    })
  }
}

// Auth callback removed as we no longer use Supabase authentication

// Window management functions
async function createWindow(): Promise<void> {
  if (state.mainWindow) {
    if (state.mainWindow.isMinimized()) state.mainWindow.restore()
    state.mainWindow.focus()
    return
  }

  const primaryDisplay = screen.getPrimaryDisplay()
  const workArea = primaryDisplay.workArea
  state.screenWidth = workArea.width
  state.screenHeight = workArea.height
  state.step = 60
  const defaultBounds = getDefaultWindowBounds()
  const useTransparentWindow = shouldUseTransparentWindow()
  state.currentX = defaultBounds.x
  state.currentY = defaultBounds.y

  const windowSettings: Electron.BrowserWindowConstructorOptions = {
    width: defaultBounds.width,
    height: defaultBounds.height,
    minWidth: MAIN_WINDOW_MIN_WIDTH,
    minHeight: MAIN_WINDOW_MIN_HEIGHT,
    x: defaultBounds.x,
    y: defaultBounds.y,
    alwaysOnTop: true,
    useContentSize: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: isDev
        ? path.join(__dirname, "../dist-electron/preload.js")
        : path.join(__dirname, "preload.js"),
      scrollBounce: true
    },
    show: false,
    frame: false,
    transparent: useTransparentWindow,
    fullscreenable: false,
    hasShadow: false,
    opacity: 1.0,  // Start with full opacity
    backgroundColor: useTransparentWindow ? "#00000000" : "#101315",
    focusable: true,
    skipTaskbar: true,
    paintWhenInitiallyHidden: true,
    titleBarStyle: "hidden",
    enableLargerThanScreen: true,
    movable: true,
    icon: resolveWindowIconPath()
  }

  if (process.platform === "darwin") {
    windowSettings.type = "panel"
  }

  state.mainWindow = new BrowserWindow(windowSettings)
  configureMediaPermissions(state.mainWindow)

  // Add more detailed logging for window events
  state.mainWindow.webContents.on("did-finish-load", () => {
    console.log("Window finished loading")
    revealMainWindow("did-finish-load")
    if (state.pendingUninstallOffboarding) {
      state.mainWindow?.webContents.send(SHOW_UNINSTALL_OFFBOARDING_EVENT)
      state.pendingUninstallOffboarding = false
    }
  })
  state.mainWindow.webContents.on("did-start-loading", () => {
    if (state.liveInterviewHelper?.hasActiveSession()) {
      void state.liveInterviewHelper.stopSession()
    }
    if (state.browserAgentController?.hasActiveSession()) {
      void state.browserAgentController.stopTask()
    }
  })
  state.mainWindow.webContents.on(
    "did-fail-load",
    async (event, errorCode, errorDescription) => {
      console.error("Window failed to load:", errorCode, errorDescription)
      if (isDev) {
        // In development, retry loading after a short delay
        console.log("Retrying to load development server...")
        setTimeout(() => {
          state.mainWindow?.loadURL("http://localhost:54321").catch((error) => {
            console.error("Failed to load dev server on retry:", error)
          })
        }, 1000)
      }
    }
  )

  if (isDev) {
    // In development, load from the dev server
    console.log("Loading from development server: http://localhost:54321")
    state.mainWindow.loadURL("http://localhost:54321").catch((error) => {
      console.error("Failed to load dev server, falling back to local file:", error)
      // Fallback to local file if dev server is not available
      try {
        const indexPath = resolveRendererIndexPath()
        console.log("Falling back to:", indexPath)
        state.mainWindow.loadFile(indexPath)
      } catch (rendererPathError) {
        console.error("Could not find index.html in dist folder", rendererPathError)
      }
    })
  } else {
    // In production, load from the built files
    try {
      const indexPath = resolveRendererIndexPath()
      console.log("Loading production build:", indexPath)
      state.mainWindow.loadFile(indexPath)
    } catch (error) {
      console.error("Could not find index.html in dist folder", error)
    }
  }

  // Configure window behavior
  state.mainWindow.webContents.setZoomFactor(1)
  if (isDev) {
    state.mainWindow.webContents.openDevTools()
  }
  state.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.log("Attempting to open URL:", url)
    try {
      const parsedURL = new URL(url);
      const hostname = parsedURL.hostname;
      const allowedHosts = ["google.com", "supabase.co"];
      if (allowedHosts.includes(hostname) || hostname.endsWith(".google.com") || hostname.endsWith(".supabase.co")) {
        shell.openExternal(url);
        return { action: "deny" }; // Do not open this URL in a new Electron window
      }
    } catch (error) {
      console.error("Invalid URL %d in setWindowOpenHandler: %d" , url , error);
      return { action: "deny" }; // Deny access as URL string is malformed or invalid
    }
    return { action: "allow" };
  })

  // Enhanced screen capture resistance (driven by user config so the dashboard
  // toggle can flip stealth on/off live for demos).
  applyScreenRecordingVisibilityToWindow(state.mainWindow)

  state.mainWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true
  })
  state.mainWindow.setAlwaysOnTop(true, getAlwaysOnTopLevel(), 1)

  // Additional screen capture resistance settings
  if (process.platform === "darwin") {
    state.mainWindow.setWindowButtonVisibility(false)
    state.mainWindow.setBackgroundColor("#00000000")
    state.mainWindow.setSkipTaskbar(true)
    state.mainWindow.setHasShadow(false)
  }

  // Prevent the window from being captured by screen recording
  state.mainWindow.webContents.setBackgroundThrottling(false)
  state.mainWindow.webContents.setFrameRate(60)

  // Set up window listeners
  state.mainWindow.on("move", handleWindowMove)
  state.mainWindow.on("resize", handleWindowResize)
  state.mainWindow.on("show", () => enforceOverlayTopmost("show"))
  state.mainWindow.on("focus", () => enforceOverlayTopmost("focus"))
  state.mainWindow.on("blur", () => enforceOverlayTopmost("blur"))
  state.mainWindow.on("restore", () => enforceOverlayTopmost("restore"))
  state.mainWindow.on("closed", handleWindowClosed)
  startOverlayGuard()

  // Initialize window state
  const bounds = clampWindowBounds(state.mainWindow.getBounds())
  state.mainWindow.setBounds(bounds)
  state.windowPosition = { x: bounds.x, y: bounds.y }
  state.windowSize = { width: bounds.width, height: bounds.height }
  state.currentX = bounds.x
  state.currentY = bounds.y
  state.isWindowVisible = true
  
  // Set opacity based on user preferences or hide initially
  // Ensure the window is visible for the first launch or if opacity > 0.1
  const savedOpacity = getConfiguredVisibleOpacity();
  console.log(`Initial opacity from config: ${savedOpacity}`);
  
  if (shouldKeepWindowHiddenForOpacity()) {
    console.log('Initial opacity too low, keeping startup window hidden until toggled');
    state.mainWindow.setOpacity(0);
    state.isWindowVisible = false;
  } else {
    console.log(`Preparing startup opacity ${savedOpacity}`);
    state.mainWindow.setOpacity(savedOpacity);
    state.isWindowVisible = true;
  }

  state.mainWindow.once("ready-to-show", () => {
    revealMainWindow("ready-to-show")
  })

  setTimeout(() => {
    revealMainWindow("startup-fallback")
  }, 1500)
}

function getRendererUrl(query?: Record<string, string>): string {
  const queryString =
    query && Object.keys(query).length > 0
      ? `?${new URLSearchParams(query).toString()}`
      : ""

  if (isDev) {
    return `http://localhost:54321/${queryString}`
  }

  return queryString
}

function resolveRendererIndexPath(): string {
  const candidatePaths = [
    path.resolve(__dirname, "../../dist/index.html"),
    path.resolve(__dirname, "../dist/index.html"),
    path.resolve(process.cwd(), "dist/index.html"),
  ]

  for (const candidatePath of candidatePaths) {
    if (fs.existsSync(candidatePath)) {
      return candidatePath
    }
  }

  throw new Error("Could not find index.html in dist folder")
}

async function loadRendererWindow(
  window: BrowserWindow,
  query?: Record<string, string>
): Promise<void> {
  if (isDev) {
    await window.loadURL(getRendererUrl(query))
    return
  }

  const indexPath = resolveRendererIndexPath()

  await window.loadFile(indexPath, { query })
}

async function createPhoneRelayWindow(): Promise<void> {
  if (state.phoneRelayWindow && !state.phoneRelayWindow.isDestroyed()) {
    state.phoneRelayWindow.show()
    state.phoneRelayWindow.focus()
    return
  }

  await state.localPhoneRelayController?.ensureStarted()

  const window = new BrowserWindow({
    width: 560,
    height: 760,
    minWidth: 500,
    minHeight: 620,
    autoHideMenuBar: true,
    title: "Sylica AI Relay Manager",
    show: false,
    frame: true,
    backgroundColor: "#edf7ff",
    icon: resolveWindowIconPath(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: isDev
        ? path.join(__dirname, "../dist-electron/preload.js")
        : path.join(__dirname, "preload.js"),
      scrollBounce: true,
    },
  })

  state.phoneRelayWindow = window

  window.webContents.on("did-finish-load", () => {
    window.show()
  })

  window.on("closed", () => {
    state.phoneRelayWindow = null
  })

  try {
    await loadRendererWindow(window, { phoneRelay: "1" })
  } catch (error) {
    console.error("Failed to load phone relay window:", error)
    window.close()
  }
}

function handleWindowMove(): void {
  if (!state.mainWindow) return
  if (state.isDynamicIsland) return
  const bounds = state.mainWindow.getBounds()
  state.windowPosition = { x: bounds.x, y: bounds.y }
  state.currentX = bounds.x
  state.currentY = bounds.y
}

function handleWindowResize(): void {
  if (!state.mainWindow) return
  if (state.isDynamicIsland) return
  const bounds = state.mainWindow.getBounds()
  state.windowSize = { width: bounds.width, height: bounds.height }
}

function handleWindowClosed(): void {
  stopOverlayGuard()
  state.liveInterviewHelper?.shutdown()
  state.browserAgentController?.shutdown()
  state.localPhoneRelayController?.shutdown()
  state.mainWindow = null
  state.phoneRelayWindow = null
  state.isWindowVisible = false
  state.windowPosition = null
  state.windowSize = null
  state.isDynamicIsland = false
  state.dynamicIslandRestoreBounds = null
}

// Window visibility functions
function hideMainWindow(): void {
  if (!state.mainWindow?.isDestroyed()) {
    const bounds = state.mainWindow.getBounds();
    const restoreBounds = state.dynamicIslandRestoreBounds || bounds
    state.windowPosition = { x: restoreBounds.x, y: restoreBounds.y };
    state.windowSize = {
      width: restoreBounds.width,
      height: restoreBounds.height,
    };
    state.isDynamicIsland = false
    state.dynamicIslandRestoreBounds = null
    state.mainWindow.setMinimumSize(
      MAIN_WINDOW_MIN_WIDTH,
      MAIN_WINDOW_MIN_HEIGHT
    )
    state.mainWindow.setIgnoreMouseEvents(true, { forward: true });
    state.mainWindow.setOpacity(0);
    // Move off-screen to eliminate any residual invisible hit-area on Windows
    state.mainWindow.setBounds({
      x: -9999,
      y: -9999,
      width: restoreBounds.width,
      height: restoreBounds.height,
    });
    state.isWindowVisible = false;
    console.log('Window hidden, moved off-screen');
  }
}

function showMainWindow(): void {
  if (!state.mainWindow?.isDestroyed()) {
    state.isDynamicIsland = false
    state.dynamicIslandRestoreBounds = null
    state.mainWindow.setMinimumSize(
      MAIN_WINDOW_MIN_WIDTH,
      MAIN_WINDOW_MIN_HEIGHT
    )
    const nextBounds = clampWindowBounds(
      state.windowPosition && state.windowSize
        ? {
            ...state.windowPosition,
            ...state.windowSize,
          }
        : state.mainWindow.getBounds()
    )
    state.mainWindow.setBounds(nextBounds)
    state.mainWindow.setIgnoreMouseEvents(false);
    state.mainWindow.setAlwaysOnTop(true, getAlwaysOnTopLevel(), 1);
    state.mainWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true
    });
    applyScreenRecordingVisibilityToWindow(state.mainWindow);
    state.mainWindow.setOpacity(0); // Set opacity to 0 before showing
    state.mainWindow.showInactive(); // Use showInactive instead of show+focus
    const visibleOpacity = getConfiguredVisibleOpacity();
    state.mainWindow.setOpacity(visibleOpacity);
    state.isWindowVisible = true;
    enforceOverlayTopmost("show-main-window")
    console.log(
      `Window shown with showInactive(), opacity set to ${visibleOpacity}`
    );
  }
}

function hideMainWindowForRegionSelection(): void {
  if (!state.mainWindow?.isDestroyed()) {
    const bounds = state.mainWindow.getBounds()
    state.windowPosition = { x: bounds.x, y: bounds.y }
    state.windowSize = { width: bounds.width, height: bounds.height }
    state.mainWindow.setIgnoreMouseEvents(true, { forward: true })
    state.mainWindow.hide()
    state.mainWindow.setOpacity(getConfiguredVisibleOpacity())
    state.isWindowVisible = false
    console.log("Window hidden for region selection")
  }
}

function restoreMainWindowAfterRegionSelection(): void {
  if (!state.mainWindow?.isDestroyed()) {
    const nextBounds = clampWindowBounds(
      state.windowPosition && state.windowSize
        ? {
            ...state.windowPosition,
            ...state.windowSize,
          }
        : state.mainWindow.getBounds()
    )
    state.mainWindow.setBounds(nextBounds)
    state.currentX = nextBounds.x
    state.currentY = nextBounds.y
    state.windowPosition = { x: nextBounds.x, y: nextBounds.y }
    state.windowSize = { width: nextBounds.width, height: nextBounds.height }
    state.mainWindow.setIgnoreMouseEvents(false)
    state.mainWindow.setAlwaysOnTop(true, getAlwaysOnTopLevel(), 1)
    state.mainWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true
    })
    applyScreenRecordingVisibilityToWindow(state.mainWindow)

    if (shouldKeepWindowHiddenForOpacity()) {
      state.mainWindow.setOpacity(0)
      state.isWindowVisible = false
      return
    }

    state.mainWindow.setOpacity(getConfiguredVisibleOpacity())
    state.mainWindow.showInactive()
    state.isWindowVisible = true
    enforceOverlayTopmost("region-restore")
    console.log("Window restored after region selection")
  }
}

function toggleMainWindow(): void {
  console.log(`Toggling window. Current state: ${state.isWindowVisible ? 'visible' : 'hidden'}`);
  if (state.isWindowVisible) {
    hideMainWindow();
  } else {
    showMainWindow();
  }
}

// Window movement functions
function moveWindowHorizontal(updateFn: (x: number) => number): void {
  if (!state.mainWindow) return
  state.currentX = updateFn(state.currentX)
  state.mainWindow.setPosition(
    Math.round(state.currentX),
    Math.round(state.currentY)
  )
}

function moveWindowVertical(updateFn: (y: number) => number): void {
  if (!state.mainWindow) return

  const newY = updateFn(state.currentY)
  // Allow window to go 2/3 off screen in either direction
  const maxUpLimit = (-(state.windowSize?.height || 0) * 2) / 3
  const maxDownLimit =
    state.screenHeight + ((state.windowSize?.height || 0) * 2) / 3

  // Log the current state and limits
  console.log({
    newY,
    maxUpLimit,
    maxDownLimit,
    screenHeight: state.screenHeight,
    windowHeight: state.windowSize?.height,
    currentY: state.currentY
  })

  // Only update if within bounds
  if (newY >= maxUpLimit && newY <= maxDownLimit) {
    state.currentY = newY
    state.mainWindow.setPosition(
      Math.round(state.currentX),
      Math.round(state.currentY)
    )
  }
}

// Window dimension functions
function setWindowDimensions(width: number, height: number): void {
  // Dynamic island manages its own bounds — ignore React-driven dimension updates
  if (state.isDynamicIsland) {
    return
  }
  if (!state.mainWindow?.isDestroyed()) {
    const [currentX, currentY] = state.mainWindow.getPosition()
    const currentBounds = state.mainWindow.getBounds()
    const targetDisplay = screen.getDisplayMatching({
      x: currentX,
      y: currentY,
      width: currentBounds.width,
      height: currentBounds.height,
    })
    const allowedBounds = state.isDynamicIsland
      ? {
          ...targetDisplay.bounds,
          y: targetDisplay.bounds.y - IDLE_ISLAND_EDGE_OVERLAP,
          height: targetDisplay.bounds.height + IDLE_ISLAND_EDGE_OVERLAP,
        }
      : targetDisplay.workArea
    const clampedWidth = Math.max(
      1,
      Math.min(Math.ceil(width), allowedBounds.width)
    )
    const clampedHeight = Math.max(
      1,
      Math.min(Math.ceil(height), allowedBounds.height)
    )
    const nextX = Math.max(
      allowedBounds.x,
      Math.min(currentX, allowedBounds.x + allowedBounds.width - clampedWidth)
    )
    const nextY = Math.max(
      allowedBounds.y,
      Math.min(currentY, allowedBounds.y + allowedBounds.height - clampedHeight)
    )

    state.mainWindow.setBounds({
      x: nextX,
      y: nextY,
      width: clampedWidth,
      height: clampedHeight
    })
    enforceOverlayTopmost("set-window-dimensions")
    state.currentX = nextX
    state.currentY = nextY
    state.windowPosition = { x: nextX, y: nextY }
    state.windowSize = { width: clampedWidth, height: clampedHeight }
  }
}

function setDynamicIslandMode(collapsed: boolean): void {
  const window = state.mainWindow
  if (!window || window.isDestroyed()) {
    return
  }

  if (!collapsed) {
    if (!state.isDynamicIsland && !state.dynamicIslandRestoreBounds) {
      return
    }

    const restoreBounds = state.dynamicIslandRestoreBounds
    state.isDynamicIsland = false
    state.dynamicIslandRestoreBounds = null
    window.setMinimumSize(MAIN_WINDOW_MIN_WIDTH, MAIN_WINDOW_MIN_HEIGHT)

    if (restoreBounds) {
      const nextBounds = clampWindowBounds(restoreBounds)
      window.setBounds(nextBounds)
      state.currentX = nextBounds.x
      state.currentY = nextBounds.y
      state.windowPosition = { x: nextBounds.x, y: nextBounds.y }
      state.windowSize = {
        width: nextBounds.width,
        height: nextBounds.height,
      }
      enforceOverlayTopmost("dynamic-island-expand")
    }

    return
  }

  if (!state.isWindowVisible || shouldKeepWindowHiddenForOpacity()) {
    return
  }

  const currentBounds = window.getBounds()
  if (!state.isDynamicIsland) {
    state.dynamicIslandRestoreBounds = currentBounds
  }

  state.isDynamicIsland = true
  window.setMinimumSize(IDLE_ISLAND_MIN_WIDTH, IDLE_ISLAND_MIN_HEIGHT)
  window.setIgnoreMouseEvents(false)
  window.setAlwaysOnTop(true, getAlwaysOnTopLevel(), 1)

  const displayBounds = screen.getDisplayMatching(currentBounds).bounds
  const targetWidth = Math.min(IDLE_ISLAND_TARGET_WIDTH, displayBounds.width)
  const targetHeight = Math.min(IDLE_ISLAND_TARGET_HEIGHT, displayBounds.height)
  const nextBounds = {
    x:
      displayBounds.x +
      Math.max(0, Math.floor((displayBounds.width - targetWidth) / 2)),
    y: displayBounds.y - IDLE_ISLAND_EDGE_OVERLAP,
    width: targetWidth,
    height: targetHeight,
  }

  window.setBounds(nextBounds)
  state.currentX = nextBounds.x
  state.currentY = nextBounds.y
  enforceOverlayTopmost("dynamic-island-collapse")
}

// Environment setup
function loadEnvVariables() {
  const scriptDir = path.dirname(path.resolve(process.argv[1] || __dirname))
  const candidatePaths = isDev
    ? [path.join(process.cwd(), ".env")]
    : Array.from(new Set([
        path.join(process.resourcesPath, ".env"),
        path.join(process.cwd(), ".env"),
        path.join(scriptDir, ".env"),
        path.resolve(scriptDir, "../.env"),
        path.resolve(scriptDir, "../../.env"),
      ]))

  for (const envPath of candidatePaths) {
    if (!fs.existsSync(envPath)) {
      continue
    }

    console.log("Loading env variables from:", envPath)
    dotenv.config({ path: envPath, override: false })
  }

  console.log("Environment variables loaded for open-source version")
}

// Initialize application
async function initializeApp() {
  try {
    loadEnvVariables()
    
    // Ensure a configuration file exists
    if (!configHelper.hasApiKey()) {
      console.log("No API key configured yet. Add one in Settings or set OPENAI_API_KEY.")
    }
    
    initializeHelpers()
    initializeIpcHandlers({
      getMainWindow,
      openPhoneRelayWindow: createPhoneRelayWindow,
      setWindowDimensions,
      setDynamicIslandMode,
      getGuideCursorEnabled: () =>
        state.guideCursorController?.isEnabled() ??
        configHelper.isGuideCursorEnabled(),
      setGuideCursorEnabled: (enabled) => {
        configHelper.setGuideCursorEnabled(enabled)
        state.guideCursorController?.setEnabled(enabled)
        return enabled
      },
      captureVoiceScreenContext,
      requestMicrophoneAccess,
      getScreenshotQueue,
      getExtraScreenshotQueue,
      deleteScreenshot,
      getImagePreview,
      processingHelper: state.processingHelper,
      liveInterviewHelper: state.liveInterviewHelper,
      browserAgentController: state.browserAgentController,
      agentController: state.agentController,
      localPhoneRelayController: state.localPhoneRelayController,
      PROCESSING_EVENTS: state.PROCESSING_EVENTS,
      takeScreenshot,
      takeRegionScreenshot,
      getView,
      toggleMainWindow,
      applyScreenRecordingVisibility: applyScreenRecordingVisibilityToMainWindow,
      clearQueues,
      setView,
      moveWindowLeft: () =>
        moveWindowHorizontal((x) =>
          Math.max(-(state.windowSize?.width || 0) / 2, x - state.step)
        ),
      moveWindowRight: () =>
        moveWindowHorizontal((x) =>
          Math.min(
            state.screenWidth - (state.windowSize?.width || 0) / 2,
            x + state.step
          )
        ),
      moveWindowUp: () => moveWindowVertical((y) => y - state.step),
      moveWindowDown: () => moveWindowVertical((y) => y + state.step)
    })
    configureAutoStart()
    await createWindow()
    state.guideCursorController?.setEnabled(configHelper.isGuideCursorEnabled())
    handleProtocolUrl(process.argv.find((arg) => isAppProtocolUrl(arg)))
    state.shortcutsHelper?.registerGlobalShortcuts()

    // Initialize auto-updater regardless of environment
    initAutoUpdater()
    console.log(
      "Auto-updater initialized in",
      isDev ? "development" : "production",
      "mode"
    )

    if (process.argv.includes("--uninstall-flow")) {
      showUninstallOffboarding()
    }
  } catch (error) {
    console.error("Failed to initialize application:", error)
    app.quit()
  }
}

function sendAuthStateUpdated(payload: {
  authenticated: boolean
  session: Awaited<ReturnType<typeof backendClient.completeWebLogin>> | null
  error?: string
}): void {
  if (!state.mainWindow?.isDestroyed()) {
    state.mainWindow.webContents.send(AUTH_STATE_UPDATED_EVENT, payload)
  }
}

function getProtocolErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to complete website login."
}

function getAuthTokenFromProtocolUrl(protocolUrl: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(protocolUrl)
  } catch (_error) {
    return null
  }

  if (parsed.hostname !== "auth") {
    return null
  }

  return parsed.searchParams.get("token")?.trim() || null
}

function completeProtocolWebLoginHeadlessly(protocolUrl: string): boolean {
  const token = getAuthTokenFromProtocolUrl(protocolUrl)
  if (!token) {
    return false
  }

  loadEnvVariables()
  void backendClient
    .completeWebLogin(token)
    .catch((error) => {
      console.error("Failed to complete headless website login:", error)
    })
    .finally(() => {
      app.exit(0)
    })

  return true
}

function completeProtocolWebLogin(token: string): void {
  void backendClient
    .completeWebLogin(token)
    .then((session) => {
      sendAuthStateUpdated({
        authenticated: true,
        session,
      })
    })
    .catch((error) => {
      console.error("Failed to complete website login:", error)
      sendAuthStateUpdated({
        authenticated: false,
        session: null,
        error: getProtocolErrorMessage(error),
      })
    })
}

function handleProtocolUrl(protocolUrl?: string): void {
  if (!isAppProtocolUrl(protocolUrl)) {
    return
  }

  let parsed: URL
  try {
    parsed = new URL(protocolUrl)
  } catch (error) {
    console.error("Failed to parse protocol URL:", protocolUrl, error)
    return
  }

  if (parsed.hostname === "auth") {
    const token = getAuthTokenFromProtocolUrl(protocolUrl)
    if (!token) {
      sendAuthStateUpdated({
        authenticated: false,
        session: null,
        error: "Website login did not return a desktop token.",
      })
      return
    }

    const finishLogin = async () => {
      revealMainWindow("auth-callback")

      // Ensure window is focused and ready before completing login
      if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        state.mainWindow.focus()

        // Reset window to default dock size (not compact/idle island size)
        const defaultBounds = getDefaultWindowBounds()
        const restoreBounds = clampWindowBounds(defaultBounds)
        state.mainWindow.setBounds(restoreBounds)
        state.windowPosition = { x: restoreBounds.x, y: restoreBounds.y }
        state.windowSize = { width: restoreBounds.width, height: restoreBounds.height }
        state.currentX = restoreBounds.x
        state.currentY = restoreBounds.y

        // Wait for webContents to be ready before sending auth update
        if (state.mainWindow.webContents.isLoading()) {
          await new Promise<void>((resolve) => {
            state.mainWindow?.webContents.once('did-finish-load', () => resolve())
          })
        }
      }

      completeProtocolWebLogin(token)
    }

    if (!state.mainWindow) {
      void createWindow().then(() => finishLogin())
      return
    }

    if (state.mainWindow.isMinimized()) {
      state.mainWindow.restore()
    }
    void finishLogin()
    return
  }

  if (parsed.hostname !== "billing") {
    return
  }

  const notifyRenderer = () => {
    if (!state.mainWindow?.isDestroyed()) {
      state.mainWindow.webContents.send("subscription-updated")
    }
  }

  if (!state.mainWindow) {
    void createWindow().then(() => {
      notifyRenderer()
    })
    return
  }

  if (state.mainWindow.isMinimized()) {
    state.mainWindow.restore()
  }
  state.mainWindow.focus()
  notifyRenderer()
}

// Module-level protocol URL tracking (outside state object)
let lastProtocolUrl: string | null = null
let lastProtocolUrlTime = 0

// Auth callback handling removed - no longer needed
app.on("open-url", (event, url) => {
  console.log("open-url event received:", url)
  event.preventDefault()

  // Debounce: ignore if we just handled a protocol URL (prevents duplicate handling with second-instance)
  const now = Date.now()
  if (lastProtocolUrl === url && now - lastProtocolUrlTime < 2000) {
    console.log("Ignoring duplicate protocol URL:", url)
    return
  }
  lastProtocolUrl = url
  lastProtocolUrlTime = now

  handleProtocolUrl(url)
})

app.on("window-all-closed", () => {
  state.liveInterviewHelper?.shutdown()
  state.browserAgentController?.shutdown()
  state.localPhoneRelayController?.shutdown()
  state.guideCursorController?.stop()
  if (process.platform !== "darwin") {
    app.quit()
    state.mainWindow = null
    state.phoneRelayWindow = null
  }
})

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.on("before-quit", () => {
  clearInstanceLock()
  state.liveInterviewHelper?.shutdown()
  state.browserAgentController?.shutdown()
  state.localPhoneRelayController?.shutdown()
  state.guideCursorController?.stop()
})

// State getter/setter functions
function getMainWindow(): BrowserWindow | null {
  return state.mainWindow
}

function getView(): "queue" | "solutions" | "debug" {
  return state.view
}

function setView(view: "queue" | "solutions" | "debug"): void {
  state.view = view
  state.screenshotHelper?.setView(view)
}

function getScreenshotHelper(): ScreenshotHelper | null {
  return state.screenshotHelper
}

function getProblemInfo(): any {
  return state.problemInfo
}

function setProblemInfo(problemInfo: any): void {
  state.problemInfo = problemInfo
}

function getScreenshotQueue(): string[] {
  return state.screenshotHelper?.getScreenshotQueue() || []
}

function getExtraScreenshotQueue(): string[] {
  return state.screenshotHelper?.getExtraScreenshotQueue() || []
}

function clearQueues(): void {
  state.screenshotHelper?.clearQueues()
  state.problemInfo = null
  state.hasDebugged = false
  setView("queue")
}

function resetDesktopFromPhone(): void {
  state.processingHelper?.cancelOngoingRequests()
  clearQueues()

  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    state.mainWindow.webContents.send("reset-view")
    state.mainWindow.webContents.send("reset")
  }
}

async function analyzeScreenFromPhone(): Promise<void> {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) {
    throw new Error("No main window available.")
  }

  if (!state.processingHelper) {
    throw new Error("Screen analysis is not available right now.")
  }

  if (!configHelper.hasApiKey()) {
    state.mainWindow.webContents.send(state.PROCESSING_EVENTS.API_KEY_INVALID)
    throw new Error("OpenAI API key not configured.")
  }

  const screenshotPath = await takeScreenshot()
  if (!screenshotPath) {
    throw new Error("Failed to capture the desktop screen.")
  }

  const preview = await getImagePreview(screenshotPath)
  state.mainWindow.webContents.send("screenshot-taken", {
    path: screenshotPath,
    preview,
  })

  await state.processingHelper.processScreenshots()
}

async function takeScreenshot(): Promise<string> {
  if (!state.mainWindow) throw new Error("No main window available")

  const shouldStartFreshQuestion =
    state.view !== "queue" || state.problemInfo !== null || state.hasDebugged

  if (shouldStartFreshQuestion) {
    state.processingHelper?.cancelOngoingRequests(false)
    clearQueues()
    state.hasDebugged = false

    if (!state.mainWindow.isDestroyed()) {
      state.mainWindow.webContents.send("reset-view")
      state.mainWindow.webContents.send("reset")
    }
  }

  return (
    state.screenshotHelper?.takeScreenshot(
      () => hideMainWindow(),
      () => showMainWindow()
    ) || ""
  )
}

async function takeRegionScreenshot(): Promise<string> {
  if (!state.mainWindow) throw new Error("No main window available")

  hideMainWindowForRegionSelection()
  await new Promise((resolve) => setTimeout(resolve, 80))

  let selection = null
  try {
    selection = await selectScreenRegion(state.mainWindow)
  } catch (error) {
    restoreMainWindowAfterRegionSelection()
    throw error
  }

  if (!selection) {
    restoreMainWindowAfterRegionSelection()
    return ""
  }

  const shouldStartFreshQuestion =
    state.view !== "queue" || state.problemInfo !== null || state.hasDebugged

  if (shouldStartFreshQuestion) {
    state.processingHelper?.cancelOngoingRequests(false)
    clearQueues()
    state.hasDebugged = false

    if (!state.mainWindow.isDestroyed()) {
      state.mainWindow.webContents.send("reset-view")
      state.mainWindow.webContents.send("reset")
    }
  }

  return (
    state.screenshotHelper?.takeRegionScreenshot(
      selection,
      () => restoreMainWindowAfterRegionSelection()
    ) ||
    ""
  )
}

async function getImagePreview(filepath: string): Promise<string> {
  return state.screenshotHelper?.getImagePreview(filepath) || ""
}

async function deleteScreenshot(
  path: string
): Promise<{ success: boolean; error?: string }> {
  return (
    state.screenshotHelper?.deleteScreenshot(path) || {
      success: false,
      error: "Screenshot helper not initialized"
    }
  )
}

function setHasDebugged(value: boolean): void {
  state.hasDebugged = value
}

function getHasDebugged(): boolean {
  return state.hasDebugged
}

// Export state and functions for other modules
export {
  state,
  createWindow,
  hideMainWindow,
  showMainWindow,
  toggleMainWindow,
  setWindowDimensions,
  moveWindowHorizontal,
  moveWindowVertical,
  getMainWindow,
  getView,
  setView,
  getScreenshotHelper,
  getProblemInfo,
  setProblemInfo,
  getScreenshotQueue,
  getExtraScreenshotQueue,
  clearQueues,
  takeScreenshot,
  takeRegionScreenshot,
  getImagePreview,
  deleteScreenshot,
  setHasDebugged,
  getHasDebugged
}

if (shouldStartApplication) {
  app.whenReady().then(initializeApp)
}
