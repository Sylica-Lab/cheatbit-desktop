import { app, BrowserWindow, ipcMain } from "electron"
import log from "electron-log"
import {
  autoUpdater,
  type ProgressInfo,
  type UpdateDownloadedEvent,
  type UpdateInfo,
} from "electron-updater"
import {
  EMPTY_DESKTOP_UPDATE_STATE,
  type DesktopUpdateState,
} from "../shared/desktopUpdates"

const UPDATE_FEED_URL = "https://cheat.trybookai.com/desktop-updates/win"
const UPDATE_STATE_EVENT = "updates:state"
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000

let desktopUpdateState: DesktopUpdateState = {
  ...EMPTY_DESKTOP_UPDATE_STATE,
}
let updateCheckInterval: NodeJS.Timeout | null = null

function isWindowsUpdaterSupported(): boolean {
  return app.isPackaged && process.platform === "win32"
}

function normalizeReleaseNotes(
  releaseNotes: UpdateInfo["releaseNotes"] | UpdateDownloadedEvent["releaseNotes"]
): string | null {
  if (!releaseNotes) {
    return null
  }

  if (typeof releaseNotes === "string") {
    const trimmed = releaseNotes.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  const rendered = releaseNotes
    .map((note) => {
      const version = note.version ? `${note.version}\n` : ""
      return `${version}${note.note}`.trim()
    })
    .filter(Boolean)
    .join("\n\n")
    .trim()

  return rendered.length > 0 ? rendered : null
}

function extractStateFromInfo(
  info?: UpdateInfo | UpdateDownloadedEvent | null
): Partial<DesktopUpdateState> {
  if (!info) {
    return {}
  }

  return {
    version: info.version ?? null,
    releaseName: info.releaseName ?? null,
    releaseNotes: normalizeReleaseNotes(info.releaseNotes),
  }
}

function broadcastUpdateState(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(UPDATE_STATE_EVENT, desktopUpdateState)
  }
}

function setDesktopUpdateState(patch: Partial<DesktopUpdateState>): void {
  desktopUpdateState = {
    ...desktopUpdateState,
    ...patch,
  }
  broadcastUpdateState()
}

async function checkForUpdates(reason: "startup" | "interval"): Promise<void> {
  if (!isWindowsUpdaterSupported()) {
    return
  }

  try {
    log.info(`Checking for updates (${reason})`)
    await autoUpdater.checkForUpdates()
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to check for updates."
    log.error(`Auto updater check failed (${reason}):`, error)
    setDesktopUpdateState({
      status: "error",
      error: message,
      downloadPercent: null,
    })
  }
}

function registerAutoUpdaterEvents(): void {
  autoUpdater.on("checking-for-update", () => {
    log.info("Checking for update")
    if (desktopUpdateState.status === "downloaded") {
      return
    }
    setDesktopUpdateState({
      status: "checking",
      error: null,
      downloadPercent: null,
    })
  })

  autoUpdater.on("update-available", (info) => {
    log.info("Update available", info)
    setDesktopUpdateState({
      status: "available",
      downloadPercent: null,
      error: null,
      ...extractStateFromInfo(info),
    })
  })

  autoUpdater.on("update-not-available", () => {
    log.info("Update not available")
    if (desktopUpdateState.status === "downloaded") {
      return
    }
    setDesktopUpdateState({
      ...EMPTY_DESKTOP_UPDATE_STATE,
    })
  })

  autoUpdater.on("download-progress", (progress: ProgressInfo) => {
    log.info("Update download progress", progress)
    setDesktopUpdateState({
      status: "downloading",
      downloadPercent: Math.max(0, Math.min(100, progress.percent)),
      error: null,
    })
  })

  autoUpdater.on("update-downloaded", (info: UpdateDownloadedEvent) => {
    log.info("Update downloaded", info)
    setDesktopUpdateState({
      status: "downloaded",
      downloadPercent: 100,
      error: null,
      ...extractStateFromInfo(info),
    })
  })

  autoUpdater.on("error", (error) => {
    log.error("Auto updater error", error)
    setDesktopUpdateState({
      status: "error",
      error:
        error instanceof Error ? error.message : "Failed to complete the update.",
      downloadPercent: null,
    })
  })
}

function registerUpdateIpcHandlers(): void {
  ipcMain.handle("updates:get-state", async () => {
    return {
      success: true as const,
      data: {
        state: desktopUpdateState,
      },
    }
  })

  ipcMain.handle("updates:download", async () => {
    if (!isWindowsUpdaterSupported()) {
      return {
        success: false as const,
        error: "Auto-update is available only in the packaged Windows app.",
      }
    }

    if (desktopUpdateState.status === "downloading") {
      return {
        success: false as const,
        error: "An update download is already in progress.",
      }
    }

    if (desktopUpdateState.status === "downloaded") {
      return {
        success: true as const,
        data: {
          state: desktopUpdateState,
        },
      }
    }

    if (desktopUpdateState.status !== "available") {
      return {
        success: false as const,
        error: "No update is ready to download.",
      }
    }

    try {
      setDesktopUpdateState({
        status: "downloading",
        downloadPercent: 0,
        error: null,
      })
      await autoUpdater.downloadUpdate()
      return {
        success: true as const,
        data: {
          state: desktopUpdateState,
        },
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to download update."
      setDesktopUpdateState({
        status: "error",
        error: message,
        downloadPercent: null,
      })
      return {
        success: false as const,
        error: message,
      }
    }
  })

  ipcMain.handle("updates:install", async () => {
    if (!isWindowsUpdaterSupported()) {
      return {
        success: false as const,
        error: "Auto-update is available only in the packaged Windows app.",
      }
    }

    if (desktopUpdateState.status !== "downloaded") {
      return {
        success: false as const,
        error: "No downloaded update is ready to install.",
      }
    }

    log.info("Installing downloaded update")
    autoUpdater.quitAndInstall()
    return {
      success: true as const,
    }
  })
}

export function initAutoUpdater() {
  console.log("Initializing auto-updater...")

  registerUpdateIpcHandlers()

  if (!isWindowsUpdaterSupported()) {
    console.log("Skipping auto-updater in unsupported environment")
    return
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  autoUpdater.setFeedURL({
    provider: "generic",
    url: UPDATE_FEED_URL,
  })

  autoUpdater.logger = log
  log.transports.file.level = "debug"

  registerAutoUpdaterEvents()
  void checkForUpdates("startup")

  if (updateCheckInterval) {
    clearInterval(updateCheckInterval)
  }

  updateCheckInterval = setInterval(() => {
    void checkForUpdates("interval")
  }, UPDATE_CHECK_INTERVAL_MS)
}
