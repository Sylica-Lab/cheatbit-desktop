// ipcHandlers.ts

import { ipcMain, shell, dialog } from "electron"
import { IIpcHandlerDeps } from "./main"
import { configHelper } from "./ConfigHelper"
import { backendClient } from "./BackendClient"
import type { UsageAction } from "../shared/backendAuth"
import type { FollowUpChatTurn } from "../shared/followUpChat"

export function initializeIpcHandlers(deps: IIpcHandlerDeps): void {
  console.log("Initializing IPC handlers")

  const getProcessingAction = (): UsageAction =>
    deps.getView() === "queue" ? "solve" : "debug"

  const hasPendingProcessingInputs = (): boolean =>
    deps.getView() === "queue"
      ? deps.getScreenshotQueue().length > 0
      : deps.getExtraScreenshotQueue().length > 0

  const notifyUnauthorized = () => {
    const mainWindow = deps.getMainWindow()
    if (mainWindow) {
      mainWindow.webContents.send(deps.PROCESSING_EVENTS.UNAUTHORIZED)
    }
  }

  const emitUsageError = (action: UsageAction, message: string) => {
    const mainWindow = deps.getMainWindow()
    if (!mainWindow) return

    if (action === "debug") {
      mainWindow.webContents.send(deps.PROCESSING_EVENTS.DEBUG_ERROR, message)
      return
    }

    mainWindow.webContents.send(
      deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
      message
    )
  }

  const ensureAuthenticatedScreenshot = async () => {
    const result = await backendClient.consumeUsage("screenshot")
    if (!result.allowed && !result.session) {
      notifyUnauthorized()
    }

    return result
  }

  const ensureProcessingAllowed = async (action: UsageAction) => {
    const result = await backendClient.consumeUsage(action)
    if (!result.allowed) {
      if (!result.session) {
        notifyUnauthorized()
      } else if (result.error) {
        emitUsageError(action, result.error)
      }
    }

    return result
  }

  const autoProcessAfterScreenshot = () => {
    const action = getProcessingAction()

    void ensureProcessingAllowed(action)
      .then((usageDecision) => {
        if (!usageDecision.allowed) {
          return
        }

        return deps.processingHelper?.processScreenshots()
      })
      .catch((error) => {
        console.error("Error auto-processing screenshots after capture:", error)
      })
  }

  ipcMain.handle("auth:get-state", async () => {
    return backendClient.getAuthState()
  })

  ipcMain.handle("auth:register", async (_event, payload) => {
    const session = await backendClient.register(
      String(payload?.name || ""),
      String(payload?.email || ""),
      String(payload?.password || "")
    )
    return {
      authenticated: true,
      session,
    }
  })

  ipcMain.handle("auth:login", async (_event, payload) => {
    const session = await backendClient.login(
      String(payload?.email || ""),
      String(payload?.password || "")
    )
    return {
      authenticated: true,
      session,
    }
  })

  ipcMain.handle("auth:logout", () => {
    backendClient.logout()
    return { success: true }
  })

  ipcMain.handle("auth:get-dashboard", async () => {
    return backendClient.getAccountDashboard()
  })

  ipcMain.handle("auth:create-checkout-session", async () => {
    return backendClient.createCheckoutSession()
  })

  ipcMain.handle("auth:create-billing-portal-session", async () => {
    return backendClient.createBillingPortalSession()
  })

  ipcMain.handle("submit-text-follow-up", async (_event, payload) => {
    const message = String(payload?.message || "").trim()
    const currentContext = String(payload?.currentContext || "").trim()
    const chatHistory = Array.isArray(payload?.chatHistory)
      ? payload.chatHistory
          .filter(
            (entry: any): entry is FollowUpChatTurn =>
              entry &&
              (entry.role === "user" || entry.role === "assistant") &&
              typeof entry.content === "string"
          )
          .map((entry) => ({
            role: entry.role,
            content: entry.content.trim(),
          }))
          .filter((entry) => entry.content.length > 0)
          .slice(-10)
      : []

    if (!message) {
      return {
        success: false as const,
        error: "Enter a follow-up question first.",
      }
    }

    const usageDecision = await backendClient.consumeUsage("debug")
    if (!usageDecision.allowed) {
      if (!usageDecision.session) {
        notifyUnauthorized()
      }

      return {
        success: false as const,
        error:
          usageDecision.error ||
          "This account cannot send follow-up questions right now.",
      }
    }

    const result = await deps.processingHelper?.processTextFollowUp({
      message,
      currentContext,
      chatHistory,
    })

    if (!result) {
      return {
        success: false as const,
        error: "Failed to generate a follow-up response.",
      }
    }

    if (result.success === false) {
      return {
        success: false as const,
        error: result.error || "Failed to generate a follow-up response.",
      }
    }

    return {
      success: true as const,
      data: result.data,
    }
  })

  // Configuration handlers
  ipcMain.handle("get-config", () => {
    return configHelper.getPublicConfig();
  })

  ipcMain.handle("update-config", (_event, updates) => {
    configHelper.updateConfig(updates);
    return configHelper.getPublicConfig();
  })

  ipcMain.handle("validate-api-key", async (_event, apiKey, provider) => {
    // First check the format
    if (!configHelper.isValidApiKeyFormat(apiKey, provider)) {
      return { 
        valid: false, 
        error: "Invalid API key format for the selected provider." 
      };
    }
    
    const result = await configHelper.testApiKey(apiKey, provider);
    return result;
  })

  // Credits handlers
  ipcMain.handle("set-initial-credits", async (_event, credits: number) => {
    const mainWindow = deps.getMainWindow()
    if (!mainWindow) return

    try {
      // Set the credits in a way that ensures atomicity
      await mainWindow.webContents.executeJavaScript(
        `window.__CREDITS__ = ${credits}`
      )
      mainWindow.webContents.send("credits-updated", credits)
    } catch (error) {
      console.error("Error setting initial credits:", error)
      throw error
    }
  })

  ipcMain.handle("decrement-credits", async () => {
    const mainWindow = deps.getMainWindow()
    if (!mainWindow) return

    try {
      const currentCredits = await mainWindow.webContents.executeJavaScript(
        "window.__CREDITS__"
      )
      if (currentCredits > 0) {
        const newCredits = currentCredits - 1
        await mainWindow.webContents.executeJavaScript(
          `window.__CREDITS__ = ${newCredits}`
        )
        mainWindow.webContents.send("credits-updated", newCredits)
      }
    } catch (error) {
      console.error("Error decrementing credits:", error)
    }
  })

  // Screenshot queue handlers
  ipcMain.handle("get-screenshot-queue", () => {
    return deps.getScreenshotQueue()
  })

  ipcMain.handle("get-extra-screenshot-queue", () => {
    return deps.getExtraScreenshotQueue()
  })

  ipcMain.handle("delete-screenshot", async (event, path: string) => {
    return deps.deleteScreenshot(path)
  })

  ipcMain.handle("get-image-preview", async (event, path: string) => {
    return deps.getImagePreview(path)
  })

  // Screenshot processing handlers
  ipcMain.handle("process-screenshots", async () => {
    // Check for API key before processing
    if (!configHelper.hasApiKey()) {
      const mainWindow = deps.getMainWindow();
      if (mainWindow) {
        mainWindow.webContents.send(deps.PROCESSING_EVENTS.API_KEY_INVALID);
      }
      return;
    }

    if (!hasPendingProcessingInputs()) {
      const mainWindow = deps.getMainWindow()
      if (mainWindow) {
        mainWindow.webContents.send(deps.PROCESSING_EVENTS.NO_SCREENSHOTS)
      }
      return
    }

    const usageDecision = await ensureProcessingAllowed(getProcessingAction())
    if (!usageDecision.allowed) {
      return
    }
    
    await deps.processingHelper?.processScreenshots()
  })

  // Window dimension handlers
  ipcMain.handle(
    "update-content-dimensions",
    async (event, { width, height }: { width: number; height: number }) => {
      if (width && height) {
        deps.setWindowDimensions(width, height)
      }
    }
  )

  ipcMain.handle(
    "set-window-dimensions",
    (event, width: number, height: number) => {
      deps.setWindowDimensions(width, height)
    }
  )

  // Screenshot management handlers
  ipcMain.handle("get-screenshots", async () => {
    try {
      let previews = []
      const currentView = deps.getView()

      if (currentView === "queue") {
        const queue = deps.getScreenshotQueue()
        previews = await Promise.all(
          queue.map(async (path) => ({
            path,
            preview: await deps.getImagePreview(path)
          }))
        )
      } else {
        const extraQueue = deps.getExtraScreenshotQueue()
        previews = await Promise.all(
          extraQueue.map(async (path) => ({
            path,
            preview: await deps.getImagePreview(path)
          }))
        )
      }

      return previews
    } catch (error) {
      console.error("Error getting screenshots:", error)
      throw error
    }
  })

  // Screenshot trigger handlers
  ipcMain.handle("trigger-screenshot", async () => {
    const mainWindow = deps.getMainWindow()
    if (mainWindow) {
      try {
        const authDecision = await ensureAuthenticatedScreenshot()
        if (!authDecision.allowed) {
          return {
            success: false,
            error: authDecision.error || "Please log in before using the app.",
          }
        }

        const screenshotPath = await deps.takeScreenshot()
        const preview = await deps.getImagePreview(screenshotPath)
        mainWindow.webContents.send("screenshot-taken", {
          path: screenshotPath,
          preview
        })
        autoProcessAfterScreenshot()
        return { success: true }
      } catch (error) {
        console.error("Error triggering screenshot:", error)
        return { error: "Failed to trigger screenshot" }
      }
    }
    return { error: "No main window available" }
  })

  ipcMain.handle("take-screenshot", async () => {
    try {
      const authDecision = await ensureAuthenticatedScreenshot()
      if (!authDecision.allowed) {
        return {
          error: authDecision.error || "Please log in before using the app.",
        }
      }

      const screenshotPath = await deps.takeScreenshot()
      const preview = await deps.getImagePreview(screenshotPath)
      return { path: screenshotPath, preview }
    } catch (error) {
      console.error("Error taking screenshot:", error)
      return { error: "Failed to take screenshot" }
    }
  })

  // Auth-related handlers removed

  ipcMain.handle("open-external-url", (event, url: string) => {
    shell.openExternal(url)
  })
  
  // Open external URL handler
  ipcMain.handle("openLink", (event, url: string) => {
    try {
      console.log(`Opening external URL: ${url}`);
      shell.openExternal(url);
      return { success: true };
    } catch (error) {
      console.error(`Error opening URL ${url}:`, error);
      return { success: false, error: `Failed to open URL: ${error}` };
    }
  })

  // Settings portal handler
  ipcMain.handle("open-settings-portal", () => {
    const mainWindow = deps.getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send("show-settings-dialog");
      return { success: true };
    }
    return { success: false, error: "Main window not available" };
  })

  // Window management handlers
  ipcMain.handle("toggle-window", () => {
    try {
      deps.toggleMainWindow()
      return { success: true }
    } catch (error) {
      console.error("Error toggling window:", error)
      return { error: "Failed to toggle window" }
    }
  })

  ipcMain.handle("reset-queues", async () => {
    try {
      deps.clearQueues()
      return { success: true }
    } catch (error) {
      console.error("Error resetting queues:", error)
      return { error: "Failed to reset queues" }
    }
  })

  // Process screenshot handlers
  ipcMain.handle("trigger-process-screenshots", async () => {
    try {
      // Check for API key before processing
      if (!configHelper.hasApiKey()) {
        const mainWindow = deps.getMainWindow();
        if (mainWindow) {
          mainWindow.webContents.send(deps.PROCESSING_EVENTS.API_KEY_INVALID);
        }
        return {
          success: false,
          error: "No built-in API key configured for the selected provider.",
        };
      }

      if (!hasPendingProcessingInputs()) {
        const mainWindow = deps.getMainWindow()
        if (mainWindow) {
          mainWindow.webContents.send(deps.PROCESSING_EVENTS.NO_SCREENSHOTS)
        }
        return { success: false, error: "No screenshots available to process." }
      }

      const usageDecision = await ensureProcessingAllowed(getProcessingAction())
      if (!usageDecision.allowed) {
        return {
          success: false,
          error: usageDecision.error || "Unable to process this request.",
        }
      }
      
      await deps.processingHelper?.processScreenshots()
      return { success: true }
    } catch (error) {
      console.error("Error processing screenshots:", error)
      return { error: "Failed to process screenshots" }
    }
  })

  // Reset handlers
  ipcMain.handle("trigger-reset", () => {
    try {
      // First cancel any ongoing requests
      deps.processingHelper?.cancelOngoingRequests()

      // Clear all queues immediately
      deps.clearQueues()

      // Reset view to queue
      deps.setView("queue")

      // Get main window and send reset events
      const mainWindow = deps.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        // Send reset events in sequence
        mainWindow.webContents.send("reset-view")
        mainWindow.webContents.send("reset")
      }

      return { success: true }
    } catch (error) {
      console.error("Error triggering reset:", error)
      return { error: "Failed to trigger reset" }
    }
  })

  // Window movement handlers
  ipcMain.handle("trigger-move-left", () => {
    try {
      deps.moveWindowLeft()
      return { success: true }
    } catch (error) {
      console.error("Error moving window left:", error)
      return { error: "Failed to move window left" }
    }
  })

  ipcMain.handle("trigger-move-right", () => {
    try {
      deps.moveWindowRight()
      return { success: true }
    } catch (error) {
      console.error("Error moving window right:", error)
      return { error: "Failed to move window right" }
    }
  })

  ipcMain.handle("trigger-move-up", () => {
    try {
      deps.moveWindowUp()
      return { success: true }
    } catch (error) {
      console.error("Error moving window up:", error)
      return { error: "Failed to move window up" }
    }
  })

  ipcMain.handle("trigger-move-down", () => {
    try {
      deps.moveWindowDown()
      return { success: true }
    } catch (error) {
      console.error("Error moving window down:", error)
      return { error: "Failed to move window down" }
    }
  })
  
  // Delete last screenshot handler
  ipcMain.handle("delete-last-screenshot", async () => {
    try {
      const queue = deps.getView() === "queue" 
        ? deps.getScreenshotQueue() 
        : deps.getExtraScreenshotQueue()
      
      if (queue.length === 0) {
        return { success: false, error: "No screenshots to delete" }
      }
      
      // Get the last screenshot in the queue
      const lastScreenshot = queue[queue.length - 1]
      
      // Delete it
      const result = await deps.deleteScreenshot(lastScreenshot)
      
      // Notify the renderer about the change
      const mainWindow = deps.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("screenshot-deleted", { path: lastScreenshot })
      }
      
      return result
    } catch (error) {
      console.error("Error deleting last screenshot:", error)
      return { success: false, error: "Failed to delete last screenshot" }
    }
  })
}
