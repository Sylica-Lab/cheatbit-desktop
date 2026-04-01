// ipcHandlers.ts

import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { app, BrowserWindow, ipcMain, shell } from "electron"
import { IIpcHandlerDeps } from "./main"
import { configHelper } from "./ConfigHelper"
import { backendClient } from "./BackendClient"
import type { UsageAction } from "../shared/backendAuth"
import type {
  AssistantChatMode,
  ChatThreadSummary,
  ComputerUseResumeData,
  ComputerUseStartData,
  ComputerUseState,
  FollowUpRole,
  FollowUpChatTurn,
  LiveInterviewInstructionData,
  LiveInterviewStartData,
  LiveInterviewState,
  LiveInterviewTranscriptData,
  TextFollowUpStreamEvent,
} from "../shared/followUpChat"
import type { LocalPhoneRelayState } from "../shared/localPhoneRelay"

const TEXT_FOLLOW_UP_STREAM_EVENT = "text-follow-up-stream"
const LOCAL_PHONE_RELAY_STATE_EVENT = "local-phone-relay-state"

export function initializeIpcHandlers(deps: IIpcHandlerDeps): void {
  console.log("Initializing IPC handlers")

  deps.localPhoneRelayController?.subscribe((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(LOCAL_PHONE_RELAY_STATE_EVENT, state)
      }
    }
  })

  const openExternalUrl = async (
    rawUrl: string
  ): Promise<{ success: boolean; error?: string }> => {
    const url = String(rawUrl || "").trim()
    if (!url) {
      return { success: false, error: "Missing URL." }
    }

    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch (_error) {
      return { success: false, error: "Invalid URL." }
    }

    const allowedProtocols = new Set(["http:", "https:", "mailto:"])
    if (!allowedProtocols.has(parsedUrl.protocol)) {
      return { success: false, error: "Unsupported URL protocol." }
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const command =
          process.platform === "win32"
            ? process.env.ComSpec || process.env.COMSPEC || "cmd.exe"
            : process.platform === "darwin"
              ? "open"
              : "xdg-open"

        const args =
          process.platform === "win32"
            ? ["/c", "start", "", url]
            : [url]

        const child = spawn(command, args, {
          stdio: "ignore",
          windowsHide: true,
        })

        child.once("error", reject)
        child.once("close", (code) => {
          if (code === 0) {
            resolve()
            return
          }

          reject(new Error(`External opener exited with code ${code ?? -1}.`))
        })
      })

      return { success: true }
    } catch (nativeError) {
      console.warn(
        "Native browser launch failed, falling back to Electron shell.",
        nativeError
      )
    }

    try {
      await shell.openExternal(url)
      return { success: true }
    } catch (error) {
      console.error(`Error opening URL ${url}:`, error)
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to open external URL.",
      }
    }
  }

  const beginWindowsUninstall = async (): Promise<{
    success: boolean
    error?: string
  }> => {
    if (process.platform !== "win32") {
      return {
        success: false,
        error: "Uninstall handoff is supported only on Windows.",
      }
    }

    const exePath = app.getPath("exe")
    const installDir = path.dirname(exePath)
    const uninstallerCandidates = fs
      .readdirSync(installDir)
      .filter(
        (fileName) =>
          /^Uninstall .*\.exe$/i.test(fileName) || /^Uninstall\.exe$/i.test(fileName)
      )
      .map((fileName) => path.join(installDir, fileName))

    const fallbackPath = path.join(installDir, `Uninstall ${app.getName()}.exe`)
    const uninstallerPath =
      uninstallerCandidates.find((candidate) => fs.existsSync(candidate)) ||
      (fs.existsSync(fallbackPath) ? fallbackPath : null)

    if (!uninstallerPath) {
      return {
        success: false,
        error: "Could not find the Sylica AI uninstaller.",
      }
    }

    try {
      const child = spawn(uninstallerPath, ["--skip-offboarding"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      })
      child.unref()
      setTimeout(() => {
        app.quit()
      }, 150)
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to start the Windows uninstaller.",
      }
    }
  }

  const getProcessingAction = (): UsageAction =>
    deps.getView() === "queue" ? "solve" : "debug"

  const resolveChatMode = (rawMode: unknown): AssistantChatMode =>
    rawMode === "follow_up"
      ? "follow_up"
      : rawMode === "live_interview"
        ? "live_interview"
        : rawMode === "computer_use"
          ? "computer_use"
          : "general"

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

  const isAuthenticationError = (error: unknown) => {
    if (!(error instanceof Error)) {
      return false
    }

    const message = error.message.toLowerCase()
    return (
      message.includes("log in") ||
      message === "authentication required." ||
      message === "user session is no longer valid."
    )
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

  ipcMain.handle("app:begin-uninstall", async () => {
    return beginWindowsUninstall()
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

  ipcMain.handle("auth:list-integrations", async () => {
    return backendClient.listIntegrations()
  })

  ipcMain.handle("auth:create-integration-connect-session", async (_event, payload) => {
    return backendClient.createIntegrationConnectSession(
      payload?.provider === "notion" ? "notion" : "google"
    )
  })

  ipcMain.handle("auth:disconnect-integration", async (_event, payload) => {
    await backendClient.disconnectIntegration(
      payload?.provider === "notion" ? "notion" : "google"
    )
    return { success: true as const }
  })

  ipcMain.handle("auth:create-phone-pairing-session", async (_event, payload) => {
    try {
      const response = await backendClient.createPhonePairingSession({
        desktopDeviceName: String(payload?.desktopDeviceName || "").trim(),
      })
      return {
        success: true as const,
        data: response,
      }
    } catch (error) {
      if (isAuthenticationError(error)) {
        notifyUnauthorized()
      }

      return {
        success: false as const,
        error:
          error instanceof Error
            ? error.message
            : "Failed to start phone pairing.",
      }
    }
  })

  ipcMain.handle("local-phone-relay:get-state", async () => {
    try {
      if (!deps.localPhoneRelayController) {
        return {
          success: false as const,
          error: "Local phone relay is not available.",
        }
      }

      await deps.localPhoneRelayController.ensureStarted()
      return {
        success: true as const,
        data: {
          state: deps.localPhoneRelayController.getState(),
        },
      }
    } catch (error) {
      return {
        success: false as const,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load local phone relay state.",
      }
    }
  })

  ipcMain.handle("local-phone-relay:create-pairing-session", async (_event, payload) => {
    try {
      if (!deps.localPhoneRelayController) {
        return {
          success: false as const,
          error: "Local phone relay is not available.",
        }
      }

      const pairing = await deps.localPhoneRelayController.createPairingSession({
        desktopDeviceName: String(payload?.desktopDeviceName || "").trim(),
      })

      return {
        success: true as const,
        data: {
          pairing,
          state: deps.localPhoneRelayController.getState(),
        },
      }
    } catch (error) {
      return {
        success: false as const,
        error:
          error instanceof Error
            ? error.message
            : "Failed to start local phone pairing.",
      }
    }
  })

  ipcMain.handle("app:open-phone-relay-window", async () => {
    try {
      await deps.openPhoneRelayWindow()
      return { success: true as const }
    } catch (error) {
      return {
        success: false as const,
        error:
          error instanceof Error
            ? error.message
            : "Failed to open the phone relay window.",
      }
    }
  })

  ipcMain.handle("auth:get-phone-pairing-session", async (_event, payload) => {
    try {
      const pairing = await backendClient.getPhonePairingSession(
        String(payload?.pairingId || "").trim()
      )
      return {
        success: true as const,
        data: { pairing },
      }
    } catch (error) {
      if (isAuthenticationError(error)) {
        notifyUnauthorized()
      }

      return {
        success: false as const,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load phone pairing session.",
      }
    }
  })

  ipcMain.handle("auth:list-phone-devices", async () => {
    try {
      const devices = await backendClient.listPhoneDevices()
      return {
        success: true as const,
        data: { devices },
      }
    } catch (error) {
      if (isAuthenticationError(error)) {
        notifyUnauthorized()
      }

      return {
        success: false as const,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load paired phones.",
      }
    }
  })

  ipcMain.handle("auth:list-phone-events", async (_event, payload) => {
    try {
      const events = await backendClient.listPhoneEvents({
        pairingId: String(payload?.pairingId || "").trim() || undefined,
        after: String(payload?.after || "").trim() || undefined,
      })
      return {
        success: true as const,
        data: { events },
      }
    } catch (error) {
      if (isAuthenticationError(error)) {
        notifyUnauthorized()
      }

      return {
        success: false as const,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load phone relay events.",
      }
    }
  })

  ipcMain.handle("permissions:request-microphone", async () => {
    return deps.requestMicrophoneAccess()
  })

  ipcMain.handle("chat:list-threads", async (_event, payload) => {
    const mode = resolveChatMode(payload?.mode)

    try {
      const threads = await backendClient.listChatThreads(mode)
      return {
        success: true as const,
        data: { threads },
      }
    } catch (error) {
      if (isAuthenticationError(error)) {
        notifyUnauthorized()
      }

      return {
        success: false as const,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load chat history.",
      }
    }
  })

  ipcMain.handle("chat:create-thread", async (_event, payload) => {
    const mode = resolveChatMode(payload?.mode)
    const title = String(payload?.title || "").trim()

    try {
      const thread = await backendClient.createChatThread(mode, title)
      return {
        success: true as const,
        data: { thread },
      }
    } catch (error) {
      if (isAuthenticationError(error)) {
        notifyUnauthorized()
      }

      return {
        success: false as const,
        error:
          error instanceof Error
            ? error.message
            : "Failed to create a new chat.",
      }
    }
  })

  ipcMain.handle("live:get-state", async () => {
    const helper = deps.liveInterviewHelper
    if (!helper) {
      return {
        success: false as const,
        error: "Live interview is not available right now.",
      }
    }

    return {
      success: true as const,
      data: {
        state: helper.getState() as LiveInterviewState,
      },
    }
  })

  ipcMain.handle("live:start", async () => {
    const helper = deps.liveInterviewHelper
    if (!helper) {
      return {
        success: false as const,
        error: "Live interview is not available right now.",
      }
    }

    const result = await helper.startSession()
    if ("error" in result) {
      if (result.authRequired) {
        notifyUnauthorized()
      }

      return {
        success: false as const,
        error: result.error,
      }
    }

    return {
      success: true as const,
      data: result.data as LiveInterviewStartData,
    }
  })

  ipcMain.handle("live:stop", async () => {
    const helper = deps.liveInterviewHelper
    if (!helper) {
      return {
        success: false as const,
        error: "Live interview is not available right now.",
      }
    }

    return helper.stopSession()
  })

  ipcMain.handle("live:add-instruction", async (_event, payload) => {
    const helper = deps.liveInterviewHelper
    if (!helper) {
      return {
        success: false as const,
        error: "Live interview is not available right now.",
      }
    }

    const content = String(payload?.content || "").trim()
    if (!content) {
      return {
        success: false as const,
        error: "Enter an instruction first.",
      }
    }

    const result = await helper.addInstruction(content)
    if ("error" in result) {
      if (result.authRequired) {
        notifyUnauthorized()
      }

      return {
        success: false as const,
        error: result.error,
      }
    }

    return {
      success: true as const,
      data: result.data as LiveInterviewInstructionData,
    }
  })

  ipcMain.handle("live:add-transcript", async (_event, payload) => {
    const helper = deps.liveInterviewHelper
    if (!helper) {
      return {
        success: false as const,
        error: "Live interview is not available right now.",
      }
    }

    const content = String(payload?.content || "").trim()
    if (!content) {
      return {
        success: false as const,
        error: "Transcript text is required.",
      }
    }

    const result = await helper.addTranscript(content)
    if ("error" in result) {
      return {
        success: false as const,
        error: result.error,
      }
    }

    return {
      success: true as const,
      data: result.data as LiveInterviewTranscriptData,
    }
  })

  ipcMain.handle("live:add-audio-chunk", async (_event, payload) => {
    const helper = deps.liveInterviewHelper
    if (!helper) {
      return {
        success: false as const,
        error: "Live interview is not available right now.",
      }
    }

    const audioBase64 = String(payload?.audioBase64 || "").trim()
    const mimeType = String(payload?.mimeType || "audio/webm").trim()
    if (!audioBase64) {
      return {
        success: false as const,
        error: "Audio data is required.",
      }
    }

    const result = await helper.addAudioChunk(audioBase64, mimeType)
    if ("error" in result) {
      return {
        success: false as const,
        error: result.error,
      }
    }

    return {
      success: true as const,
      data: result.data as LiveInterviewTranscriptData,
    }
  })

  ipcMain.handle("computer-use:get-state", async () => {
    const controller = deps.browserAgentController
    if (!controller) {
      return {
        success: false as const,
        error: "Computer Use is not available right now.",
      }
    }

    return {
      success: true as const,
      data: {
        state: controller.getState() as ComputerUseState,
      },
    }
  })

  ipcMain.handle("computer-use:start-task", async (_event, payload) => {
    const controller = deps.browserAgentController
    if (!controller) {
      return {
        success: false as const,
        error: "Computer Use is not available right now.",
      }
    }

    const task = String(payload?.task || "").trim()
    if (!task) {
      return {
        success: false as const,
        error: "Enter a browser task first.",
      }
    }

    const result = await controller.startTask(task)
    if ("error" in result) {
      if (result.authRequired) {
        notifyUnauthorized()
      }

      return {
        success: false as const,
        error: result.error,
      }
    }

    return {
      success: true as const,
      data: result.data as ComputerUseStartData,
    }
  })

  ipcMain.handle("computer-use:stop-task", async () => {
    const controller = deps.browserAgentController
    if (!controller) {
      return {
        success: false as const,
        error: "Computer Use is not available right now.",
      }
    }

    return controller.stopTask()
  })

  ipcMain.handle("computer-use:resume-after-secret", async () => {
    const controller = deps.browserAgentController
    if (!controller) {
      return {
        success: false as const,
        error: "Computer Use is not available right now.",
      }
    }

    const result = await controller.resumeAfterSecret()
    if ("error" in result) {
      return {
        success: false as const,
        error: result.error,
      }
    }

    return {
      success: true as const,
      data: result.data as ComputerUseResumeData,
    }
  })

  ipcMain.handle("chat:get-messages", async (_event, payload) => {
    const threadId = String(payload?.threadId || "").trim()
    if (!threadId) {
      return {
        success: false as const,
        error: "Chat thread ID is required.",
      }
    }

    try {
      const data = await backendClient.getChatMessages(threadId)
      return {
        success: true as const,
        data,
      }
    } catch (error) {
      if (isAuthenticationError(error)) {
        notifyUnauthorized()
      }

      return {
        success: false as const,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load chat messages.",
      }
    }
  })

  ipcMain.handle("chat:append-message", async (_event, payload) => {
    const threadId = String(payload?.threadId || "").trim()
    const role: FollowUpRole | null =
      payload?.role === "assistant" || payload?.role === "user"
        ? payload.role
        : null
    const content = String(payload?.content || "").trim()

    if (!threadId || !role || !content) {
      return {
        success: false as const,
        error: "A valid thread, role, and message are required.",
      }
    }

    try {
      const data = await backendClient.appendChatMessage({
        threadId,
        role,
        content,
      })
      return {
        success: true as const,
        data,
      }
    } catch (error) {
      if (isAuthenticationError(error)) {
        notifyUnauthorized()
      }

      return {
        success: false as const,
        error:
          error instanceof Error
            ? error.message
            : "Failed to save the chat message.",
      }
    }
  })

  ipcMain.handle("submit-text-follow-up", async (event, payload) => {
    const message = String(payload?.message || "").trim()
    const currentContext = String(payload?.currentContext || "").trim()
    const requestId = String(payload?.requestId || "").trim()
    const mode: AssistantChatMode =
      payload?.mode === "general" ? "general" : "follow_up"
    const chatHistory = Array.isArray(payload?.chatHistory)
      ? payload.chatHistory
          .filter(
            (entry: unknown): entry is FollowUpChatTurn => {
              if (!entry || typeof entry !== "object") {
                return false
              }

              const candidate = entry as {
                role?: unknown
                content?: unknown
              }

              return (
                (candidate.role === "user" ||
                  candidate.role === "assistant") &&
                typeof candidate.content === "string"
              )
            }
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

    const usageDecision = await backendClient.consumeUsage(
      mode === "general" ? "solve" : "debug"
    )
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

    const emitStreamEvent = (streamEvent: TextFollowUpStreamEvent) => {
      event.sender.send(TEXT_FOLLOW_UP_STREAM_EVENT, streamEvent)
    }

    if (
      mode === "general" &&
      backendClient.looksLikeIntegrationAssistantRequest(message)
    ) {
      try {
        const integrationResult = await backendClient.runIntegrationAssistantAction({
          message,
          chatHistory,
        })

        if (integrationResult.handled) {
          if (requestId) {
            emitStreamEvent({
              requestId,
              content: integrationResult.reply,
              done: true,
            })
          }

          return {
            success: true as const,
            data: {
              reply: integrationResult.reply,
            },
          }
        }
      } catch (error) {
        console.error("Integration assistant action failed:", error)
      }
    }

    const result = await deps.processingHelper?.processTextFollowUp(
      {
        requestId,
        message,
        currentContext,
        chatHistory,
        mode,
      },
      {
        onStream:
          requestId.length > 0
            ? (content) => {
                emitStreamEvent({
                  requestId,
                  content,
                  done: false,
                })
              }
            : undefined,
      }
    )

    if (!result) {
      if (requestId) {
        emitStreamEvent({
          requestId,
          content: "",
          done: true,
          error: "Failed to generate a follow-up response.",
        })
      }
      return {
        success: false as const,
        error: "Failed to generate a follow-up response.",
      }
    }

    if (result.success === false) {
      if (requestId) {
        emitStreamEvent({
          requestId,
          content: "",
          done: true,
          error: result.error || "Failed to generate a follow-up response.",
        })
      }
      return {
        success: false as const,
        error: result.error || "Failed to generate a follow-up response.",
      }
    }

    if (requestId) {
      emitStreamEvent({
        requestId,
        content: result.data.reply,
        done: true,
      })
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
        const queue = [...deps.getScreenshotQueue(), ...extraQueue]
        previews = await Promise.all(
          queue.map(async (path) => ({
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

  ipcMain.handle("trigger-region-screenshot", async () => {
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

        const screenshotPath = await deps.takeRegionScreenshot()
        if (!screenshotPath) {
          return { success: true, canceled: true }
        }

        const preview = await deps.getImagePreview(screenshotPath)
        mainWindow.webContents.send("screenshot-taken", {
          path: screenshotPath,
          preview
        })
        autoProcessAfterScreenshot()
        return { success: true }
      } catch (error) {
        console.error("Error triggering region screenshot:", error)
        return { error: "Failed to capture selected area" }
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

  ipcMain.handle("open-external-url", async (_event, url: string) => {
    return openExternalUrl(url)
  })
  
  // Open external URL handler
  ipcMain.handle("openLink", async (_event, url: string) => {
    console.log(`Opening external URL: ${url}`)
    return openExternalUrl(url)
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

  ipcMain.handle("quit-app", () => {
    try {
      app.quit()
      return { success: true }
    } catch (error) {
      console.error("Error quitting app:", error)
      return { error: "Failed to quit app" }
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
      const queue =
        deps.getView() === "queue"
          ? deps.getScreenshotQueue()
          : deps.getExtraScreenshotQueue().length > 0
            ? deps.getExtraScreenshotQueue()
            : deps.getScreenshotQueue()
      
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
