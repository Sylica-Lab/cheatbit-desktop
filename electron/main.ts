import { app, BrowserWindow, screen, shell, ipcMain, systemPreferences, desktopCapturer } from "electron"
import path from "path"
import fs from "fs"
import { initializeIpcHandlers } from "./ipcHandlers"
import { ProcessingHelper } from "./ProcessingHelper"
import { ScreenshotHelper } from "./ScreenshotHelper"
import { ShortcutsHelper } from "./shortcuts"
import { initAutoUpdater } from "./autoUpdater"
import { configHelper } from "./ConfigHelper"
import { selectScreenRegion } from "./RegionSelectionOverlay"
import { LiveInterviewHelper } from "./LiveInterviewHelper"
import { BrowserAgentController } from "./BrowserAgentController"
import { LocalPhoneRelayController } from "./LocalPhoneRelayController"
import * as dotenv from "dotenv"

// Constants
const isDev = process.env.NODE_ENV === "development"
const IS_LOCAL_DESKTOP_TEST = process.env.SYLICA_LOCAL_DESKTOP_TEST === "1"
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

// Application State
const state = {
  // Window management properties
  mainWindow: null as BrowserWindow | null,
  phoneRelayWindow: null as BrowserWindow | null,
  isWindowVisible: false,
  windowPosition: null as { x: number; y: number } | null,
  windowSize: null as { width: number; height: number } | null,
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
  localPhoneRelayController: null as LocalPhoneRelayController | null,
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
  PROCESSING_EVENTS: typeof state.PROCESSING_EVENTS
}

export interface IIpcHandlerDeps {
  getMainWindow: () => BrowserWindow | null
  openPhoneRelayWindow: () => Promise<void>
  setWindowDimensions: (width: number, height: number) => void
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
  localPhoneRelayController: LocalPhoneRelayController | null
  PROCESSING_EVENTS: typeof state.PROCESSING_EVENTS
  takeScreenshot: () => Promise<string>
  takeRegionScreenshot: () => Promise<string>
  getView: () => "queue" | "solutions" | "debug"
  toggleMainWindow: () => void
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
    PROCESSING_EVENTS: state.PROCESSING_EVENTS
  } as IShortcutsHelperDeps)
  state.liveInterviewHelper = new LiveInterviewHelper({
    getMainWindow,
    getProcessingHelper: () => state.processingHelper,
  })
  state.browserAgentController = new BrowserAgentController({
    getMainWindow,
  })
  state.localPhoneRelayController = new LocalPhoneRelayController(APP_NAME)
}

function getConfiguredVisibleOpacity(): number {
  const savedOpacity = configHelper.getOpacity()

  if (!Number.isFinite(savedOpacity)) {
    return 1
  }

  return Math.max(0.9, Math.min(savedOpacity, 1))
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

function isAppProtocolUrl(protocolUrl?: string): boolean {
  return Boolean(
    protocolUrl &&
      (protocolUrl.startsWith(`${APP_PROTOCOL}://`) ||
        protocolUrl.startsWith(`${LEGACY_APP_PROTOCOL}://`))
  )
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
  const width = Math.max(320, Math.min(bounds.width, workArea.width))
  const height = Math.max(56, Math.min(bounds.height, workArea.height))

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
    state.mainWindow.showInactive()

    const rawSavedOpacity = configHelper.getOpacity()
    const savedOpacity = getConfiguredVisibleOpacity()
    if (rawSavedOpacity <= 0.1) {
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

function showUninstallOffboarding(): void {
  state.pendingUninstallOffboarding = true
  revealMainWindow("uninstall-offboarding")

  if (!state.mainWindow?.isDestroyed()) {
    state.mainWindow.webContents.send(SHOW_UNINSTALL_OFFBOARDING_EVENT)
    state.pendingUninstallOffboarding = false
  }
}

// Auth callback handler

// Register the Sylica AI protocol
if (process.platform === "darwin") {
  app.setAsDefaultProtocolClient(APP_PROTOCOL)
} else {
  app.setAsDefaultProtocolClient(APP_PROTOCOL, process.execPath, [
    path.resolve(process.argv[1] || "")
  ])
}

// Handle the protocol. In this case, we choose to show an Error Box.
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(APP_PROTOCOL, process.execPath, [
    path.resolve(process.argv[1])
  ])
}

// Force Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on("second-instance", (event, commandLine) => {
    console.log("second-instance event received:", commandLine)

    if (!state.mainWindow) {
      void createWindow()
    } else {
      if (state.mainWindow.isMinimized()) state.mainWindow.restore()
      state.mainWindow.focus()
    }

    const protocolUrl = commandLine.find((arg) => isAppProtocolUrl(arg))
    handleProtocolUrl(protocolUrl)

    if (commandLine.includes("--uninstall-flow")) {
      showUninstallOffboarding()
    }
  })
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
    minWidth: 320,
    minHeight: 56,
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
      const indexPath = path.join(__dirname, "../dist/index.html")
      console.log("Falling back to:", indexPath)
      if (fs.existsSync(indexPath)) {
        state.mainWindow.loadFile(indexPath)
      } else {
        console.error("Could not find index.html in dist folder")
      }
    })
  } else {
    // In production, load from the built files
    const indexPath = path.join(__dirname, "../dist/index.html")
    console.log("Loading production build:", indexPath)
    
    if (fs.existsSync(indexPath)) {
      state.mainWindow.loadFile(indexPath)
    } else {
      console.error("Could not find index.html in dist folder")
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

  // Enhanced screen capture resistance
  state.mainWindow.setContentProtection(true)

  state.mainWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true
  })
  state.mainWindow.setAlwaysOnTop(true, "screen-saver", 1)

  // Additional screen capture resistance settings
  if (process.platform === "darwin") {
    // Prevent window from being captured in screenshots
    state.mainWindow.setHiddenInMissionControl(true)
    state.mainWindow.setWindowButtonVisibility(false)
    state.mainWindow.setBackgroundColor("#00000000")

    // Prevent window from being included in window switcher
    state.mainWindow.setSkipTaskbar(true)

    // Disable window shadow
    state.mainWindow.setHasShadow(false)
  }

  // Prevent the window from being captured by screen recording
  state.mainWindow.webContents.setBackgroundThrottling(false)
  state.mainWindow.webContents.setFrameRate(60)

  // Set up window listeners
  state.mainWindow.on("move", handleWindowMove)
  state.mainWindow.on("resize", handleWindowResize)
  state.mainWindow.on("closed", handleWindowClosed)

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
  const rawSavedOpacity = configHelper.getOpacity();
  const savedOpacity = getConfiguredVisibleOpacity();
  console.log(`Initial opacity from config: ${savedOpacity}`);
  
  if (rawSavedOpacity <= 0.1) {
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

async function loadRendererWindow(
  window: BrowserWindow,
  query?: Record<string, string>
): Promise<void> {
  if (isDev) {
    await window.loadURL(getRendererUrl(query))
    return
  }

  const indexPath = path.join(__dirname, "../dist/index.html")
  if (!fs.existsSync(indexPath)) {
    throw new Error("Could not find index.html in dist folder")
  }

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
  const bounds = state.mainWindow.getBounds()
  state.windowPosition = { x: bounds.x, y: bounds.y }
  state.currentX = bounds.x
  state.currentY = bounds.y
}

function handleWindowResize(): void {
  if (!state.mainWindow) return
  const bounds = state.mainWindow.getBounds()
  state.windowSize = { width: bounds.width, height: bounds.height }
}

function handleWindowClosed(): void {
  state.liveInterviewHelper?.shutdown()
  state.browserAgentController?.shutdown()
  state.localPhoneRelayController?.shutdown()
  state.mainWindow = null
  state.phoneRelayWindow = null
  state.isWindowVisible = false
  state.windowPosition = null
  state.windowSize = null
}

// Window visibility functions
function hideMainWindow(): void {
  if (!state.mainWindow?.isDestroyed()) {
    const bounds = state.mainWindow.getBounds();
    state.windowPosition = { x: bounds.x, y: bounds.y };
    state.windowSize = { width: bounds.width, height: bounds.height };
    state.mainWindow.setIgnoreMouseEvents(true, { forward: true });
    state.mainWindow.setOpacity(0);
    state.isWindowVisible = false;
    console.log('Window hidden, opacity set to 0');
  }
}

function showMainWindow(): void {
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
    state.mainWindow.setIgnoreMouseEvents(false);
    state.mainWindow.setAlwaysOnTop(true, "screen-saver", 1);
    state.mainWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true
    });
    state.mainWindow.setContentProtection(true);
    state.mainWindow.setOpacity(0); // Set opacity to 0 before showing
    state.mainWindow.showInactive(); // Use showInactive instead of show+focus
    const visibleOpacity = getConfiguredVisibleOpacity();
    state.mainWindow.setOpacity(visibleOpacity);
    state.isWindowVisible = true;
    console.log(
      `Window shown with showInactive(), opacity set to ${visibleOpacity}`
    );
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
  if (!state.mainWindow?.isDestroyed()) {
    const [currentX, currentY] = state.mainWindow.getPosition()
    const currentBounds = state.mainWindow.getBounds()
    const targetDisplay = screen.getDisplayMatching({
      x: currentX,
      y: currentY,
      width: currentBounds.width,
      height: currentBounds.height,
    })
    const workArea = targetDisplay.workArea
    const clampedWidth = Math.max(1, Math.min(Math.ceil(width), workArea.width))
    const clampedHeight = Math.max(
      1,
      Math.min(Math.ceil(height), workArea.height)
    )
    const nextX = Math.max(
      workArea.x,
      Math.min(currentX, workArea.x + workArea.width - clampedWidth)
    )
    const nextY = Math.max(
      workArea.y,
      Math.min(currentY, workArea.y + workArea.height - clampedHeight)
    )

    state.mainWindow.setBounds({
      x: nextX,
      y: nextY,
      width: clampedWidth,
      height: clampedHeight
    })
    state.currentX = nextX
    state.currentY = nextY
  }
}

// Environment setup
function loadEnvVariables() {
  if (isDev) {
    console.log("Loading env variables from:", path.join(process.cwd(), ".env"))
    dotenv.config({ path: path.join(process.cwd(), ".env") })
  } else {
    console.log(
      "Loading env variables from:",
      path.join(process.resourcesPath, ".env")
    )
    dotenv.config({ path: path.join(process.resourcesPath, ".env") })
  }
  console.log("Environment variables loaded for open-source version")
}

// Initialize application
async function initializeApp() {
  try {
    loadEnvVariables()
    
    // Ensure a configuration file exists
    if (!configHelper.hasApiKey()) {
      console.log("No built-in API key found. Add one in electron/builtInApiKeys.ts.")
    }
    
    initializeHelpers()
    initializeIpcHandlers({
      getMainWindow,
      openPhoneRelayWindow: createPhoneRelayWindow,
      setWindowDimensions,
      requestMicrophoneAccess,
      getScreenshotQueue,
      getExtraScreenshotQueue,
      deleteScreenshot,
      getImagePreview,
      processingHelper: state.processingHelper,
      liveInterviewHelper: state.liveInterviewHelper,
      browserAgentController: state.browserAgentController,
      localPhoneRelayController: state.localPhoneRelayController,
      PROCESSING_EVENTS: state.PROCESSING_EVENTS,
      takeScreenshot,
      takeRegionScreenshot,
      getView,
      toggleMainWindow,
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
    await createWindow()
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

// Auth callback handling removed - no longer needed
app.on("open-url", (event, url) => {
  console.log("open-url event received:", url)
  event.preventDefault()
  handleProtocolUrl(url)
})

app.on("window-all-closed", () => {
  state.liveInterviewHelper?.shutdown()
  state.browserAgentController?.shutdown()
  state.localPhoneRelayController?.shutdown()
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
  state.liveInterviewHelper?.shutdown()
  state.browserAgentController?.shutdown()
  state.localPhoneRelayController?.shutdown()
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
  setView("queue")
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

  hideMainWindow()
  await new Promise((resolve) => setTimeout(resolve, 120))

  let selection = null
  try {
    selection = await selectScreenRegion(state.mainWindow)
  } catch (error) {
    showMainWindow()
    throw error
  }

  if (!selection) {
    showMainWindow()
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
    state.screenshotHelper?.takeRegionScreenshot(selection, () => showMainWindow()) ||
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

app.whenReady().then(initializeApp)
