// ipcHandlers.ts

import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from "electron"
import type WebSocket from "ws"
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
  VoiceRealtimeEvent,
} from "../shared/followUpChat"
import type { LocalPhoneRelayState } from "../shared/localPhoneRelay"
import type { AgentState } from "../shared/agent"

const TEXT_FOLLOW_UP_STREAM_EVENT = "text-follow-up-stream"
const LOCAL_PHONE_RELAY_STATE_EVENT = "local-phone-relay-state"
const VOICE_REALTIME_EVENT = "voice-realtime-event"
const AGENT_STATE_EVENT = "agent-state"
const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime"
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime-2"
const OPENAI_REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE?.trim() || "marin"
const OPENAI_REALTIME_PCM_RATE = 24000
const VOICE_SCREEN_REFRESH_MIN_MS = 2500
const WEBSOCKET_READY_OPEN = 1

type RealtimeSocket = WebSocket

interface VoiceRealtimeSession {
  socket: RealtimeSocket
  startedAt: number
  lastScreenAt: number
  screenRefreshInFlight: boolean
  instructions: string
  assistantTranscript: string
}

function extractRealtimeText(value: unknown): string {
  if (!value) {
    return ""
  }

  if (typeof value === "string") {
    return value
  }

  if (Array.isArray(value)) {
    return value.map(extractRealtimeText).join("")
  }

  if (typeof value !== "object") {
    return ""
  }

  const record = value as Record<string, any>
  return [
    record.delta,
    record.text,
    record.transcript,
    record.content,
    record.item,
    record.output,
    record.response,
  ]
    .map(extractRealtimeText)
    .join("")
}

function getRealtimeWebSocketConstructor(): typeof import("ws") {
  // Electron's main process runs in CommonJS after build; lazy require keeps Vite happy.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const wsModule = require("ws") as typeof import("ws") & {
    WebSocket?: typeof import("ws")
    default?: typeof import("ws")
  }

  return (wsModule.WebSocket || wsModule.default || wsModule) as typeof import("ws")
}

export function initializeIpcHandlers(deps: IIpcHandlerDeps): void {
  console.log("Initializing IPC handlers")

  deps.localPhoneRelayController?.subscribe((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(LOCAL_PHONE_RELAY_STATE_EVENT, state)
      }
    }
  })

  deps.agentController?.subscribe((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(AGENT_STATE_EVENT, state)
      }
    }
  })

  let voiceRealtimeSession: VoiceRealtimeSession | null = null

  const emitVoiceRealtimeEvent = (payload: VoiceRealtimeEvent): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(VOICE_REALTIME_EVENT, payload)
      }
    }
  }

  const closeVoiceRealtimeSession = (): void => {
    const session = voiceRealtimeSession
    voiceRealtimeSession = null

    if (!session) {
      return
    }

    try {
      session.socket.close()
    } catch (_error) {
      // Ignore close races during app shutdown or renderer reloads.
    }
  }

  const refreshVoiceRealtimeScreen = async (
    session: VoiceRealtimeSession
  ): Promise<void> => {
    if (
      voiceRealtimeSession !== session ||
      session.screenRefreshInFlight ||
      Date.now() - session.lastScreenAt < VOICE_SCREEN_REFRESH_MIN_MS ||
      session.socket.readyState !== WEBSOCKET_READY_OPEN
    ) {
      return
    }

    session.screenRefreshInFlight = true
    try {
      const capture = await deps.captureVoiceScreenContext()
      session.lastScreenAt = Date.now()

      if (voiceRealtimeSession !== session || session.socket.readyState !== WEBSOCKET_READY_OPEN) {
        return
      }

      session.socket.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  "Current screen context. Use this only when it is relevant. Do not mention screenshots or tools.",
              },
              {
                type: "input_image",
                image_url: `data:image/png;base64,${capture.data}`,
              },
            ],
          },
        })
      )
    } catch (error) {
      console.warn("Voice realtime screen context capture failed:", error)
    } finally {
      session.screenRefreshInFlight = false
    }
  }

  const sendVoiceRealtimeSessionUpdate = (
    session: VoiceRealtimeSession,
    instructions: string,
    voice: string
  ): void => {
    session.instructions = instructions
    session.socket.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          model: OPENAI_REALTIME_MODEL,
          instructions,
          output_modalities: ["audio"],
          audio: {
            input: {
              format: {
                type: "audio/pcm",
                rate: OPENAI_REALTIME_PCM_RATE,
              },
              noise_reduction: {
                type: "near_field",
              },
              transcription: {
                model: "gpt-4o-mini-transcribe",
                language: "en",
              },
              turn_detection: {
                type: "server_vad",
                threshold: 0.45,
                prefix_padding_ms: 260,
                silence_duration_ms: 420,
                create_response: true,
                interrupt_response: true,
              },
            },
            output: {
              format: {
                type: "audio/pcm",
                rate: OPENAI_REALTIME_PCM_RATE,
              },
              voice,
            },
          },
        },
      })
    )
  }

  const handleVoiceRealtimeMessage = (
    session: VoiceRealtimeSession,
    rawMessage: string
  ): void => {
    if (voiceRealtimeSession !== session) {
      return
    }

    let payload: Record<string, any>
    try {
      payload = JSON.parse(rawMessage) as Record<string, any>
    } catch (error) {
      console.error("Failed to parse voice realtime message:", error)
      return
    }

    const messageType = String(payload.type || "")
    if (messageType === "session.created") {
      emitVoiceRealtimeEvent({ type: "ready" })
      void refreshVoiceRealtimeScreen(session)
      return
    }

    if (messageType === "session.updated") {
      emitVoiceRealtimeEvent({ type: "session_updated" })
      return
    }

    if (messageType === "input_audio_buffer.speech_started") {
      emitVoiceRealtimeEvent({ type: "speech_started" })
      void refreshVoiceRealtimeScreen(session)
      return
    }

    if (messageType === "input_audio_buffer.speech_stopped") {
      emitVoiceRealtimeEvent({ type: "speech_stopped" })
      return
    }

    if (messageType === "conversation.item.input_audio_transcription.delta") {
      const delta = String(payload.delta || "")
      if (delta) {
        emitVoiceRealtimeEvent({ type: "input_transcript_delta", delta })
      }
      return
    }

    if (messageType === "conversation.item.input_audio_transcription.completed") {
      const transcript = String(payload.transcript || "").trim()
      if (transcript) {
        emitVoiceRealtimeEvent({ type: "input_transcript", transcript })
      }
      return
    }

    if (
      messageType === "response.output_audio.delta" ||
      messageType === "response.audio.delta"
    ) {
      const audio = String(payload.delta || "").trim()
      if (audio) {
        emitVoiceRealtimeEvent({ type: "audio_delta", audio })
      }
      return
    }

    if (
      messageType === "response.output_audio_transcript.delta" ||
      messageType === "response.audio_transcript.delta" ||
      messageType === "response.audio.transcript.delta" ||
      messageType === "response.content_part.delta" ||
      messageType === "response.output_item.delta" ||
      messageType === "response.output_text.delta" ||
      messageType === "response.text.delta"
    ) {
      const text = extractRealtimeText(payload.delta || payload)
      if (text) {
        session.assistantTranscript += text
        emitVoiceRealtimeEvent({ type: "text_delta", text })
      }
      return
    }

    if (
      messageType === "response.output_audio_transcript.done" ||
      messageType === "response.audio_transcript.done" ||
      messageType === "response.audio.transcript.done" ||
      messageType === "response.output_text.done" ||
      messageType === "response.text.done"
    ) {
      const completedText = extractRealtimeText(payload.transcript || payload.text || payload)
      if (completedText && !session.assistantTranscript.endsWith(completedText)) {
        const nextText = session.assistantTranscript
          ? completedText.replace(session.assistantTranscript, "")
          : completedText
        if (nextText) {
          session.assistantTranscript += nextText
          emitVoiceRealtimeEvent({ type: "text_delta", text: nextText })
        }
      }
      return
    }

    if (messageType === "response.done" || messageType === "response.completed") {
      const completedText = extractRealtimeText(payload.response || payload.output || payload)
      if (completedText && !session.assistantTranscript.endsWith(completedText)) {
        const nextText = session.assistantTranscript
          ? completedText.replace(session.assistantTranscript, "")
          : completedText
        if (nextText) {
          session.assistantTranscript += nextText
          emitVoiceRealtimeEvent({ type: "text_delta", text: nextText })
        }
      }
      emitVoiceRealtimeEvent({ type: "response_done" })
      session.assistantTranscript = ""
      return
    }

    if (messageType === "error") {
      const errorMessage = String(
        payload.error?.message || payload.message || "Realtime voice failed."
      ).trim()
      emitVoiceRealtimeEvent({ type: "error", error: errorMessage })
    }
  }

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
        : rawMode === "agent"
          ? "agent"
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

  ipcMain.handle("auth:start-web-login", async () => {
    try {
      await shell.openExternal(backendClient.getWebLoginUrl())
      return { success: true as const }
    } catch (error) {
      return {
        success: false as const,
        error:
          error instanceof Error
            ? error.message
            : "Failed to open the Sylica login page.",
      }
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

  ipcMain.handle("voice:transcribe-audio", async (_event, payload) => {
    const helper = deps.processingHelper
    if (!helper) {
      return {
        success: false as const,
        error: "Voice transcription is not available right now.",
      }
    }

    const audioBase64 = String(payload?.audioBase64 || "").trim()
    const mimeType = String(payload?.mimeType || "audio/pcm").trim()
    if (!audioBase64) {
      return {
        success: false as const,
        error: "Audio data is required.",
      }
    }

    try {
      const transcript = await helper.transcribeLiveInterviewAudioChunk(
        audioBase64,
        mimeType
      )
      return {
        success: true as const,
        data: { transcript },
      }
    } catch (error) {
      return {
        success: false as const,
        error:
          error instanceof Error
            ? error.message
            : "Failed to transcribe voice audio.",
      }
    }
  })

  ipcMain.handle("voice-realtime:start", async (_event, payload) => {
    const apiKey = configHelper.getConfiguredApiKey("openai")
    if (!apiKey) {
      return {
        success: false as const,
        error: "OpenAI API key not configured for realtime voice.",
      }
    }

    const instructions = String(payload?.instructions || "").trim()
    const voice = String(payload?.voice || OPENAI_REALTIME_VOICE).trim() || OPENAI_REALTIME_VOICE
    if (!instructions) {
      return {
        success: false as const,
        error: "Voice instructions are required.",
      }
    }

    closeVoiceRealtimeSession()

    const RealtimeWebSocket = getRealtimeWebSocketConstructor()
    const socketUrl = `${OPENAI_REALTIME_URL}?model=${encodeURIComponent(
      OPENAI_REALTIME_MODEL
    )}`
    const socket = new RealtimeWebSocket(socketUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    }) as RealtimeSocket
    const session: VoiceRealtimeSession = {
      socket,
      startedAt: Date.now(),
      lastScreenAt: 0,
      screenRefreshInFlight: false,
      instructions,
      assistantTranscript: "",
    }
    voiceRealtimeSession = session

    return new Promise<
      { success: true; data: { model: string } } | { success: false; error: string }
    >((resolve) => {
      let settled = false
      let lastServerError = ""
      const timeout = setTimeout(() => {
        if (settled) {
          return
        }

        settled = true
        closeVoiceRealtimeSession()
        resolve({
          success: false as const,
          error: "Timed out starting realtime voice.",
        })
      }, 9000)

      const settle = (
        result:
          | { success: true; data: { model: string } }
          | { success: false; error: string }
      ) => {
        if (settled) {
          return
        }

        settled = true
        clearTimeout(timeout)
        resolve(result)
      }

      socket.on("open", () => {
        try {
          sendVoiceRealtimeSessionUpdate(session, instructions, voice)
          settle({
            success: true as const,
            data: { model: OPENAI_REALTIME_MODEL },
          })
        } catch (error) {
          closeVoiceRealtimeSession()
          settle({
            success: false as const,
            error:
              error instanceof Error
                ? error.message
                : "Failed to configure realtime voice.",
          })
        }
      })

      socket.on("message", (data) => {
        const rawData = typeof data === "string" ? data : data.toString("utf8")
        try {
          const parsed = JSON.parse(rawData) as Record<string, any>
          if (String(parsed.type || "") === "error") {
            lastServerError = String(
              parsed.error?.message || parsed.message || "Realtime voice failed."
            ).trim()
          }
        } catch (_error) {
          // Parsed again in the main handler; ignore pre-parse failures here.
        }

        handleVoiceRealtimeMessage(session, rawData)
      })

      socket.on("close", (code, reason) => {
        const closeMessage =
          lastServerError ||
          `Realtime voice connection closed (${code}${
            reason?.length ? `: ${reason.toString("utf8")}` : ""
          }).`

        if (!settled) {
          settle({
            success: false as const,
            error: closeMessage,
          })
          return
        }

        if (voiceRealtimeSession === session) {
          voiceRealtimeSession = null
          emitVoiceRealtimeEvent({ type: "error", error: closeMessage })
        }
      })

      socket.on("error", (error) => {
        const errorMessage =
          lastServerError ||
          (error instanceof Error && error.message.trim()
            ? error.message
            : "Could not connect realtime voice.")

        if (!settled) {
          settle({
            success: false as const,
            error: errorMessage,
          })
          return
        }

        if (voiceRealtimeSession === session) {
          emitVoiceRealtimeEvent({ type: "error", error: errorMessage })
        }
      })
    })
  })

  ipcMain.handle("voice-realtime:append-audio", async (_event, payload) => {
    const audioBase64 = String(payload?.audioBase64 || "").trim()
    const session = voiceRealtimeSession
    if (!session || session.socket.readyState !== WEBSOCKET_READY_OPEN) {
      return {
        success: false as const,
        error: "Realtime voice is not connected.",
      }
    }

    if (!audioBase64) {
      return {
        success: false as const,
        error: "Audio data is required.",
      }
    }

    session.socket.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: audioBase64,
      })
    )

    return { success: true as const }
  })

  ipcMain.handle("voice-realtime:update-instructions", async (_event, payload) => {
    const instructions = String(payload?.instructions || "").trim()
    const voice = String(payload?.voice || OPENAI_REALTIME_VOICE).trim() || OPENAI_REALTIME_VOICE
    const session = voiceRealtimeSession
    if (!session || session.socket.readyState !== WEBSOCKET_READY_OPEN) {
      return {
        success: false as const,
        error: "Realtime voice is not connected.",
      }
    }

    if (!instructions) {
      return {
        success: false as const,
        error: "Voice instructions are required.",
      }
    }

    sendVoiceRealtimeSessionUpdate(session, instructions, voice)
    return { success: true as const }
  })

  ipcMain.handle("voice-realtime:request-response", async (_event, payload) => {
    const session = voiceRealtimeSession
    if (!session || session.socket.readyState !== WEBSOCKET_READY_OPEN) {
      return {
        success: false as const,
        error: "Realtime voice is not connected.",
      }
    }

    const directive = String(payload?.directive || "").trim()
    if (directive) {
      session.socket.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: directive,
              },
            ],
          },
        })
      )
    }

    session.socket.send(
      JSON.stringify({
        type: "response.create",
        response: {
          output_modalities: ["audio"],
        },
      })
    )

    return { success: true as const }
  })

  ipcMain.handle("voice-realtime:stop", async () => {
    closeVoiceRealtimeSession()
    return { success: true as const }
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
        error: "Enter a computer task first.",
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

  ipcMain.handle("agent:get-state", async () => {
    const controller = deps.agentController
    if (!controller) {
      return {
        success: false as const,
        error: "Agent Mode is not available right now.",
      }
    }

    return {
      success: true as const,
      data: {
        state: controller.getState() as AgentState,
      },
    }
  })

  ipcMain.handle("agent:select-workspace", async () => {
    try {
      const mainWindow = deps.getMainWindow()
      const options: OpenDialogOptions = {
        title: "Choose Sylica Agent workspace",
        properties: ["openDirectory", "createDirectory"],
      }
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options)

      if (result.canceled || !result.filePaths[0]) {
        return {
          success: false as const,
          error: "No workspace selected.",
        }
      }

      return {
        success: true as const,
        data: {
          workspacePath: result.filePaths[0],
        },
      }
    } catch (error) {
      return {
        success: false as const,
        error:
          error instanceof Error
            ? error.message
            : "Failed to choose an Agent workspace.",
      }
    }
  })

  ipcMain.handle("agent:start-task", async (_event, payload) => {
    const controller = deps.agentController
    if (!controller) {
      return {
        success: false as const,
        error: "Agent Mode is not available right now.",
      }
    }

    const result = await controller.startTask({
      prompt: String(payload?.prompt || ""),
      workspacePath: String(payload?.workspacePath || "") || undefined,
    })

    if ("error" in result) {
      if (result.authRequired) {
        notifyUnauthorized()
      }

      return {
        success: false as const,
        error: result.error,
      }
    }

    return result
  })

  ipcMain.handle("agent:approve-phase", async (_event, payload) => {
    const controller = deps.agentController
    if (!controller) {
      return {
        success: false as const,
        error: "Agent Mode is not available right now.",
      }
    }

    return controller.approvePhase({
      taskId: String(payload?.taskId || ""),
      phaseId: String(payload?.phaseId || ""),
    })
  })

  ipcMain.handle("agent:reject-phase", async (_event, payload) => {
    const controller = deps.agentController
    if (!controller) {
      return {
        success: false as const,
        error: "Agent Mode is not available right now.",
      }
    }

    return controller.rejectPhase({
      taskId: String(payload?.taskId || ""),
      phaseId: String(payload?.phaseId || ""),
      reason: String(payload?.reason || ""),
    })
  })

  ipcMain.handle("agent:stop", async () => {
    const controller = deps.agentController
    if (!controller) {
      return {
        success: false as const,
        error: "Agent Mode is not available right now.",
      }
    }

    return controller.stop()
  })

  ipcMain.handle("agent:open-artifact", async (_event, payload) => {
    const controller = deps.agentController
    if (!controller) {
      return {
        success: false as const,
        error: "Agent Mode is not available right now.",
      }
    }

    return controller.openArtifact(String(payload?.artifactId || ""))
  })

  ipcMain.handle("agent:open-workspace", async () => {
    const controller = deps.agentController
    if (!controller) {
      return {
        success: false as const,
        error: "Agent Mode is not available right now.",
      }
    }

    return controller.openWorkspace()
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
    const previous = configHelper.getPublicConfig();
    configHelper.updateConfig(updates);
    const next = configHelper.getPublicConfig();

    // If the user flipped the "visible to screen recordings" toggle, apply it
    // to the live window immediately so demos can switch state on the fly.
    if (
      updates &&
      Object.prototype.hasOwnProperty.call(updates, "screenRecordingVisible") &&
      previous.screenRecordingVisible !== next.screenRecordingVisible
    ) {
      try {
        deps.applyScreenRecordingVisibility();
      } catch (error) {
        console.warn("Failed to apply screen recording visibility:", error);
      }
    }

    return next;
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

  ipcMain.handle("app:set-dynamic-island-mode", (_event, payload) => {
    try {
      deps.setDynamicIslandMode(Boolean(payload?.collapsed))
      return { success: true as const }
    } catch (error) {
      console.error("Error updating dynamic island mode:", error)
      return {
        success: false as const,
        error:
          error instanceof Error
            ? error.message
            : "Failed to update dynamic island mode.",
      }
    }
  })

  ipcMain.handle("app:get-guide-cursor-state", () => {
    try {
      return {
        success: true as const,
        data: {
          enabled: deps.getGuideCursorEnabled(),
        },
      }
    } catch (error) {
      console.error("Error reading guide cursor state:", error)
      return {
        success: false as const,
        error:
          error instanceof Error
            ? error.message
            : "Failed to read guide cursor state.",
      }
    }
  })

  ipcMain.handle("app:set-guide-cursor-enabled", (_event, payload) => {
    try {
      const enabled = deps.setGuideCursorEnabled(Boolean(payload?.enabled))
      return {
        success: true as const,
        data: {
          enabled,
        },
      }
    } catch (error) {
      console.error("Error updating guide cursor state:", error)
      return {
        success: false as const,
        error:
          error instanceof Error
            ? error.message
            : "Failed to update guide cursor state.",
      }
    }
  })

  ipcMain.handle("app:set-mouse-passthrough", (_event, enabled) => {
    try {
      const window = deps.getMainWindow()
      if (!window || window.isDestroyed()) {
        return { success: false as const, error: "Main window is not available." }
      }

      window.setIgnoreMouseEvents(Boolean(enabled), { forward: true })
      return { success: true as const }
    } catch (error) {
      console.error("Error updating mouse passthrough:", error)
      return {
        success: false as const,
        error:
          error instanceof Error
            ? error.message
            : "Failed to update mouse passthrough.",
      }
    }
  })

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

  ipcMain.handle("open-local-path", async (_event, rawPath: string) => {
    try {
      const targetPath = String(rawPath || "").trim()
      if (!targetPath) {
        return { success: false as const, error: "Missing file path." }
      }

      const resolvedPath = path.resolve(targetPath)
      if (!fs.existsSync(resolvedPath)) {
        return { success: false as const, error: "That file no longer exists." }
      }

      const openError = await shell.openPath(resolvedPath)
      if (openError) {
        return { success: false as const, error: openError }
      }

      return { success: true as const }
    } catch (error) {
      return {
        success: false as const,
        error:
          error instanceof Error
            ? error.message
            : "Failed to open the local file.",
      }
    }
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
