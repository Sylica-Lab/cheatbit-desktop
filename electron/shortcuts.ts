import { globalShortcut, app } from "electron"
import { IShortcutsHelperDeps } from "./main"
import { configHelper } from "./ConfigHelper"
import { backendClient } from "./BackendClient"
import type { UsageAction } from "../shared/backendAuth"

export class ShortcutsHelper {
  private deps: IShortcutsHelperDeps

  constructor(deps: IShortcutsHelperDeps) {
    this.deps = deps
  }

  private adjustOpacity(delta: number): void {
    const mainWindow = this.deps.getMainWindow();
    if (!mainWindow) return;
    
    let currentOpacity = mainWindow.getOpacity();
    let newOpacity = Math.max(0.9, Math.min(1.0, currentOpacity + delta));
    console.log(`Adjusting opacity from ${currentOpacity} to ${newOpacity}`);
    
    mainWindow.setOpacity(newOpacity);
    
    // Save the opacity setting to config without re-initializing the client
    try {
      const config = configHelper.loadConfig();
      config.opacity = newOpacity;
      configHelper.saveConfig(config);
    } catch (error) {
      console.error('Error saving opacity to config:', error);
    }
    
    // If we're making the window visible, also make sure it's shown and interaction is enabled
    if (newOpacity > 0.1 && !this.deps.isVisible()) {
      this.deps.toggleMainWindow();
    }
  }

  private getProcessingAction(): UsageAction {
    return this.deps.getView() === "queue" ? "solve" : "debug"
  }

  private emitUnauthorized(): void {
    const mainWindow = this.deps.getMainWindow()
    if (mainWindow) {
      mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.UNAUTHORIZED)
    }
  }

  private emitUsageError(action: UsageAction, message: string): void {
    const mainWindow = this.deps.getMainWindow()
    if (!mainWindow) return

    if (action === "debug") {
      mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.DEBUG_ERROR, message)
      return
    }

    mainWindow.webContents.send(
      this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
      message
    )
  }

  private hasPendingScreenshots(action: UsageAction): boolean {
    if (action === "debug") {
      return this.deps.getExtraScreenshotQueue().length > 0
    }

    return this.deps.getScreenshotQueue().length > 0
  }

  public registerGlobalShortcuts(): void {
    globalShortcut.register("CommandOrControl+H", async () => {
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow) {
        console.log("Taking screenshot...")
        try {
          const authDecision = await backendClient.consumeUsage("screenshot")
          if (!authDecision.allowed) {
            if (!authDecision.session) {
              this.emitUnauthorized()
            }
            return
          }

          const screenshotPath = await this.deps.takeScreenshot()
          const preview = await this.deps.getImagePreview(screenshotPath)
          mainWindow.webContents.send("screenshot-taken", {
            path: screenshotPath,
            preview
          })

          if (!configHelper.hasApiKey()) {
            mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.API_KEY_INVALID)
            return
          }

          const action = this.getProcessingAction()
          const usageDecision = await backendClient.consumeUsage(action)
          if (!usageDecision.allowed) {
            if (!usageDecision.session) {
              this.emitUnauthorized()
            } else if (usageDecision.error) {
              this.emitUsageError(action, usageDecision.error)
            }
            return
          }

          void this.deps.processingHelper?.processScreenshots().catch((error) => {
            console.error(
              "Error auto-processing screenshots after shortcut capture:",
              error
            )
          })
        } catch (error) {
          console.error("Error capturing screenshot:", error)
        }
      }
    })

    globalShortcut.register("CommandOrControl+Enter", async () => {
      if (!configHelper.hasApiKey()) {
        const mainWindow = this.deps.getMainWindow()
        if (mainWindow) {
          mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.API_KEY_INVALID)
        }
        return
      }

      const action = this.getProcessingAction()
      if (!this.hasPendingScreenshots(action)) {
        const mainWindow = this.deps.getMainWindow()
        if (mainWindow) {
          mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS)
        }
        return
      }

      const usageDecision = await backendClient.consumeUsage(action)
      if (!usageDecision.allowed) {
        if (!usageDecision.session) {
          this.emitUnauthorized()
        } else if (usageDecision.error) {
          this.emitUsageError(action, usageDecision.error)
        }
        return
      }

      await this.deps.processingHelper?.processScreenshots()
    })

    globalShortcut.register("CommandOrControl+R", () => {
      console.log(
        "Command + R pressed. Canceling requests and resetting queues..."
      )

      // Cancel ongoing API requests
      this.deps.processingHelper?.cancelOngoingRequests()

      // Clear both screenshot queues
      this.deps.clearQueues()

      console.log("Cleared queues.")

      // Update the view state to 'queue'
      this.deps.setView("queue")

      // Notify renderer process to switch view to 'queue'
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("reset-view")
        mainWindow.webContents.send("reset")
      }
    })

    // New shortcuts for moving the window
    globalShortcut.register("CommandOrControl+Left", () => {
      console.log("Command/Ctrl + Left pressed. Moving window left.")
      this.deps.moveWindowLeft()
    })

    globalShortcut.register("CommandOrControl+Right", () => {
      console.log("Command/Ctrl + Right pressed. Moving window right.")
      this.deps.moveWindowRight()
    })

    globalShortcut.register("CommandOrControl+Down", () => {
      console.log("Command/Ctrl + down pressed. Moving window down.")
      this.deps.moveWindowDown()
    })

    globalShortcut.register("CommandOrControl+Up", () => {
      console.log("Command/Ctrl + Up pressed. Moving window Up.")
      this.deps.moveWindowUp()
    })

    globalShortcut.register("CommandOrControl+B", () => {
      console.log("Command/Ctrl + B pressed. Toggling window visibility.")
      this.deps.toggleMainWindow()
    })

    globalShortcut.register("CommandOrControl+Q", () => {
      console.log("Command/Ctrl + Q pressed. Quitting application.")
      app.quit()
    })

    // Adjust opacity shortcuts
    globalShortcut.register("CommandOrControl+[", () => {
      console.log("Command/Ctrl + [ pressed. Decreasing opacity.")
      this.adjustOpacity(-0.1)
    })

    globalShortcut.register("CommandOrControl+]", () => {
      console.log("Command/Ctrl + ] pressed. Increasing opacity.")
      this.adjustOpacity(0.1)
    })
    
    // Zoom controls
    globalShortcut.register("CommandOrControl+-", () => {
      console.log("Command/Ctrl + - pressed. Zooming out.")
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow) {
        const currentZoom = mainWindow.webContents.getZoomLevel()
        mainWindow.webContents.setZoomLevel(currentZoom - 0.5)
      }
    })
    
    globalShortcut.register("CommandOrControl+0", () => {
      console.log("Command/Ctrl + 0 pressed. Resetting zoom.")
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow) {
        mainWindow.webContents.setZoomLevel(0)
      }
    })
    
    globalShortcut.register("CommandOrControl+=", () => {
      console.log("Command/Ctrl + = pressed. Zooming in.")
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow) {
        const currentZoom = mainWindow.webContents.getZoomLevel()
        mainWindow.webContents.setZoomLevel(currentZoom + 0.5)
      }
    })
    
    // Delete last screenshot shortcut
    globalShortcut.register("CommandOrControl+L", () => {
      console.log("Command/Ctrl + L pressed. Deleting last screenshot.")
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow) {
        // Send an event to the renderer to delete the last screenshot
        mainWindow.webContents.send("delete-last-screenshot")
      }
    })
    
    // Unregister shortcuts when quitting
    app.on("will-quit", () => {
      globalShortcut.unregisterAll()
    })
  }
}
