import type { BrowserWindow } from "electron"
import { backendClient } from "./BackendClient"
import { ProcessingHelper } from "./ProcessingHelper"
import { configHelper } from "./ConfigHelper"
import type WebSocket from "ws"
import {
  type ChatThreadSummary,
  type LiveInterviewInstructionData,
  type LiveInterviewStartData,
  type LiveInterviewState,
  type LiveInterviewTranscriptData,
  type PersistedChatMessage,
  EMPTY_LIVE_INTERVIEW_STATE,
} from "../shared/followUpChat"

const LIVE_INTERVIEW_STATE_EVENT = "live-interview-state"
const LIVE_INTERVIEW_REFRESH_DEBOUNCE_MS = 320
const MAX_TRANSCRIPT_CHARS = 6000
const TOGETHER_REALTIME_MODEL = "openai/whisper-large-v3"
const TOGETHER_REALTIME_URL = "wss://api.together.xyz/v1/realtime"
const WEBSOCKET_READY_OPEN = 1

interface LiveInterviewHelperDeps {
  getMainWindow: () => BrowserWindow | null
  getProcessingHelper: () => ProcessingHelper | null
}

type RealtimeSocket = WebSocket

function getRealtimeWebSocketConstructor(): typeof import("ws") {
  process.env.WS_NO_BUFFER_UTIL = "1"
  process.env.WS_NO_UTF_8_VALIDATE = "1"

  const wsModule = require("ws") as typeof import("ws") & {
    WebSocket?: typeof import("ws")
    default?: typeof import("ws")
  }

  return (wsModule.WebSocket || wsModule.default || wsModule) as typeof import("ws")
}

interface ActiveLiveInterviewSession {
  thread: ChatThreadSummary
  instructions: PersistedChatMessage[]
  transcript: string
  partialTranscript: string
  audioChunks: Array<{
    audioBase64: string
    mimeType: string
  }>
  realtimeSocket: RealtimeSocket | null
  realtimeReady: boolean
  latestAnswer: string
  latestTranscript: string
  lastTranscriptHash: string | null
  lastInstructionHash: string | null
  startedAt: string
  lastUpdatedAt: string | null
  isProcessing: boolean
  isStopping: boolean
  immediateRefreshPending: boolean
  timer: NodeJS.Timeout | null
}

export interface LiveInterviewContextSnapshot {
  threadId: string
  status: LiveInterviewState["status"]
  transcript: string
  focusedTranscript: string
  latestAnswer: string
  latestTranscript: string
  instructions: string[]
  startedAt: string
  lastUpdatedAt: string | null
}

export class LiveInterviewHelper {
  private readonly deps: LiveInterviewHelperDeps
  private session: ActiveLiveInterviewSession | null = null
  private state: LiveInterviewState = { ...EMPTY_LIVE_INTERVIEW_STATE }

  constructor(deps: LiveInterviewHelperDeps) {
    this.deps = deps
  }

  public getState(): LiveInterviewState {
    return { ...this.state }
  }

  public hasActiveSession(): boolean {
    return this.session !== null
  }

  public getContextSnapshot(): LiveInterviewContextSnapshot | null {
    const session = this.session
    if (!session) {
      return null
    }

    const transcript = this.getEffectiveTranscript(session)

    return {
      threadId: session.thread.id,
      status: this.state.status,
      transcript,
      focusedTranscript: this.getFocusedRefreshTranscript(transcript),
      latestAnswer: session.latestAnswer,
      latestTranscript: session.latestTranscript,
      instructions: session.instructions
        .map((message) => message.content.trim())
        .filter(Boolean),
      startedAt: session.startedAt,
      lastUpdatedAt: session.lastUpdatedAt,
    }
  }

  public async startSession(): Promise<
    | { success: true; data: LiveInterviewStartData }
    | { success: false; error: string; authRequired?: boolean }
  > {
    if (this.session) {
      return {
        success: false,
        error: "A live interview session is already running.",
      }
    }

    const processingHelper = this.deps.getProcessingHelper()
    if (!processingHelper) {
      return {
        success: false,
        error: "Live interview is not available right now.",
      }
    }

    try {
      const usageDecision = await backendClient.consumeUsage("live_interview")
      if (!usageDecision.allowed) {
        return {
          success: false,
          error:
            usageDecision.error ||
            "Live Interview is available on the Pro plan.",
          authRequired: !usageDecision.session,
        }
      }

      const thread = await backendClient.createChatThread(
        "live_interview",
        this.buildThreadTitle()
      )
      const startedAt = new Date().toISOString()

      this.session = {
        thread,
        instructions: [],
        transcript: "",
        partialTranscript: "",
        audioChunks: [],
        realtimeSocket: null,
        realtimeReady: false,
        latestAnswer: "",
        latestTranscript: "",
        lastTranscriptHash: null,
        lastInstructionHash: null,
        startedAt,
        lastUpdatedAt: null,
        isProcessing: false,
        isStopping: false,
        immediateRefreshPending: false,
        timer: null,
      }

      await this.connectRealtimeTranscription(this.session)

      this.updateState({
        status: "running",
        threadId: thread.id,
        startedAt,
        lastUpdatedAt: null,
        isProcessing: false,
        latestTranscript: "",
        latestAnswer: "",
      })

      return {
        success: true,
        data: {
          thread,
          state: this.getState(),
        },
      }
    } catch (error) {
      this.shutdown()
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to start the live interview session.",
      }
    }
  }

  public async stopSession(): Promise<
    | { success: true; data: { state: LiveInterviewState } }
    | { success: false; error: string }
  > {
    try {
      await this.stopInternal(true)
      return {
        success: true,
        data: { state: this.getState() },
      }
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to stop the live interview session.",
      }
    }
  }

  public async addInstruction(
    content: string
  ): Promise<
    | { success: true; data: LiveInterviewInstructionData }
    | { success: false; error: string; authRequired?: boolean }
  > {
    const session = this.session
    if (!session) {
      return {
        success: false,
        error: "Start Live Interview before sending instructions.",
      }
    }

    const trimmedContent = content.trim()
    if (!trimmedContent) {
      return {
        success: false,
        error: "Enter an instruction first.",
      }
    }

    try {
      const data = await backendClient.appendChatMessage({
        threadId: session.thread.id,
        role: "user",
        content: trimmedContent,
      })

      if (this.session?.thread.id !== session.thread.id) {
        return {
          success: false,
          error: "Live interview session changed before the instruction was saved.",
        }
      }

      this.session.thread = data.thread
      this.session.instructions = [...this.session.instructions, data.message]
      if (this.getEffectiveTranscript(this.session)) {
        this.requestImmediateRefresh(this.session)
      }
      this.emitState()

      return {
        success: true,
        data: {
          thread: data.thread,
          message: data.message,
          state: this.getState(),
        },
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to save the live instruction."
      return {
        success: false,
        error: message,
        authRequired: message.toLowerCase().includes("log in"),
      }
    }
  }

  public async addTranscript(
    content: string
  ): Promise<
    | { success: true; data: LiveInterviewTranscriptData }
    | { success: false; error: string }
  > {
    const session = this.session
    if (!session) {
      return {
        success: false,
        error: "Start Live Interview before streaming audio.",
      }
    }

    const trimmedContent = content.trim()
    if (!trimmedContent) {
      return {
        success: false,
        error: "Transcript text is required.",
      }
    }

    const normalizedTranscript = this.normalizeTranscript(
      session.transcript,
      trimmedContent
    )
    if (normalizedTranscript === session.transcript) {
      return {
        success: true,
        data: { state: this.getState() },
      }
    }

    session.transcript = normalizedTranscript
    session.latestTranscript = normalizedTranscript.slice(-280)
    this.updateState({
      latestTranscript: session.latestTranscript,
    })
    this.requestImmediateRefresh(session)

    return {
      success: true,
      data: { state: this.getState() },
    }
  }

  public async addAudioChunk(
    audioBase64: string,
    mimeType: string
  ): Promise<
    | { success: true; data: LiveInterviewTranscriptData }
    | { success: false; error: string }
  > {
    const session = this.session
    if (!session) {
      return {
        success: false,
        error: "Start Live Interview before streaming audio.",
      }
    }

    if (!audioBase64.trim()) {
      return {
        success: false,
        error: "Audio data is required.",
      }
    }

    session.audioChunks.push({
      audioBase64,
      mimeType: mimeType.trim() || "audio/pcm;rate=16000;encoding=s16le",
    })
    this.flushRealtimeAudio(session)

    return {
      success: true,
      data: { state: this.getState() },
    }
  }

  public shutdown(): void {
    const processingHelper = this.deps.getProcessingHelper()
    if (processingHelper) {
      processingHelper.cancelLiveInterviewRequest()
    }

    if (this.session?.timer) {
      clearTimeout(this.session.timer)
    }

    if (this.session?.realtimeSocket) {
      this.session.realtimeSocket.close()
    }

    this.session = null
    this.state = { ...EMPTY_LIVE_INTERVIEW_STATE }
    this.emitState()
  }

  private buildThreadTitle(): string {
    const timestamp = new Date().toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })

    return `Live Interview · ${timestamp}`
  }

  private normalizeTranscript(existingTranscript: string, nextChunk: string): string {
    const normalizedChunk = nextChunk.trim().replace(/\s+/g, " ")
    const normalizedExisting = existingTranscript.trim()

    if (!normalizedChunk) {
      return normalizedExisting
    }

    if (
      normalizedExisting === normalizedChunk ||
      normalizedExisting.endsWith(normalizedChunk)
    ) {
      return normalizedExisting
    }

    const merged = `${normalizedExisting} ${normalizedChunk}`.trim()
    if (merged.length <= MAX_TRANSCRIPT_CHARS) {
      return merged
    }

    return merged.slice(merged.length - MAX_TRANSCRIPT_CHARS).trimStart()
  }

  private getEffectiveTranscript(session: ActiveLiveInterviewSession): string {
    return [session.transcript, session.partialTranscript].filter(Boolean).join(" ").trim()
  }

  private getFocusedRefreshTranscript(transcript: string): string {
    const normalizedTranscript = transcript.trim().replace(/\s+/g, " ")
    if (!normalizedTranscript) {
      return ""
    }

    const questionCuePattern =
      /\b(explain|implement|design|difference|walk me through|tell me about|what|why|how|when|can you|could you|would you|should you|describe)\b/gi
    let lastCueIndex = -1
    for (const match of normalizedTranscript.matchAll(questionCuePattern)) {
      if (typeof match.index === "number") {
        lastCueIndex = match.index
      }
    }

    if (lastCueIndex >= 0) {
      const cueWindow = normalizedTranscript.slice(lastCueIndex).trim()
      if (cueWindow.split(/\s+/).filter(Boolean).length >= 6) {
        return cueWindow
      }
    }

    const sentenceParts = normalizedTranscript
      .split(/(?<=[.?!])\s+/)
      .map((part) => part.trim())
      .filter(Boolean)
    if (sentenceParts.length >= 2) {
      return sentenceParts.slice(-2).join(" ")
    }

    const words = normalizedTranscript.split(/\s+/).filter(Boolean)
    return words.slice(-55).join(" ")
  }

  private hasEnoughTranscriptForRefresh(transcript: string): boolean {
    const normalizedTranscript = transcript.trim().toLowerCase()
    if (!normalizedTranscript) {
      return false
    }

    const wordCount = normalizedTranscript.split(/\s+/).filter(Boolean).length
    if (wordCount >= 5) {
      return true
    }

    return (
      normalizedTranscript.includes("?") ||
      /\b(explain|implement|design|difference|walk me through|tell me about|what|why|how|when|can you|could you|array|string|tree|graph|database|api|project|experience|bug|algorithm)\b/.test(
        normalizedTranscript
      )
    )
  }

  private emitState(): void {
    const mainWindow = this.deps.getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) {
      return
    }

    mainWindow.webContents.send(LIVE_INTERVIEW_STATE_EVENT, this.getState())
  }

  private updateState(partial: Partial<LiveInterviewState>): void {
    this.state = {
      ...this.state,
      ...partial,
    }
    this.emitState()
  }

  private scheduleRefresh(
    session: ActiveLiveInterviewSession,
    delayMs: number = LIVE_INTERVIEW_REFRESH_DEBOUNCE_MS
  ): void {
    if (this.session?.thread.id !== session.thread.id || session.isStopping) {
      return
    }

    if (session.timer) {
      clearTimeout(session.timer)
    }

    session.timer = setTimeout(() => {
      session.timer = null
      void this.runTurn(session)
    }, delayMs)
  }

  private requestImmediateRefresh(session: ActiveLiveInterviewSession): void {
    if (this.session?.thread.id !== session.thread.id || session.isStopping) {
      return
    }

    if (session.timer) {
      clearTimeout(session.timer)
      session.timer = null
    }

    if (session.isProcessing) {
      session.immediateRefreshPending = true
      return
    }

    this.scheduleRefresh(session)
  }

  private async connectRealtimeTranscription(
    session: ActiveLiveInterviewSession
  ): Promise<void> {
    const apiKey = configHelper.getConfiguredApiKey("together")
    if (!apiKey) {
      throw new Error("Together AI key not configured for live transcription.")
    }

    const RealtimeWebSocket = getRealtimeWebSocketConstructor()

    const url = new URL(TOGETHER_REALTIME_URL)
    url.searchParams.set("model", TOGETHER_REALTIME_MODEL)
    url.searchParams.set("input_audio_format", "pcm_s16le_16000")
    url.searchParams.set("intent", "transcription")

    const socket = new RealtimeWebSocket(url.toString(), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }) as RealtimeSocket

    session.realtimeSocket = socket

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true
          try {
            socket.close()
          } catch (_error) {
            // Ignore close errors.
          }
          reject(new Error("Timed out starting realtime transcription."))
        }
      }, 8000)

      const handleOpen = () => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        session.realtimeReady = true
        this.flushRealtimeAudio(session)
        resolve()
      }

      const handleError = () => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        reject(new Error("Could not connect to Together realtime transcription."))
      }

      socket.once("open", handleOpen)
      socket.once("error", handleError)
    })

    socket.on("message", (data) => {
      const rawData = typeof data === "string" ? data : data.toString("utf8")
      this.handleRealtimeMessage(session, rawData)
    })

    socket.on("close", () => {
      if (this.session?.thread.id !== session.thread.id || session.isStopping) {
        return
      }

      session.realtimeReady = false
      this.updateState({
        latestTranscript:
          session.latestTranscript || "Realtime transcription connection closed.",
      })
    })

    socket.on("error", () => {
      if (this.session?.thread.id !== session.thread.id || session.isStopping) {
        return
      }

      session.realtimeReady = false
      this.updateState({
        latestTranscript:
          session.latestTranscript || "Realtime transcription connection failed.",
      })
    })
  }

  private flushRealtimeAudio(session: ActiveLiveInterviewSession): void {
    if (
      this.session?.thread.id !== session.thread.id ||
      session.isStopping ||
      !session.realtimeReady ||
      !session.realtimeSocket ||
      session.realtimeSocket.readyState !== WEBSOCKET_READY_OPEN
    ) {
      return
    }

    while (session.audioChunks.length > 0) {
      const nextChunk = session.audioChunks.shift()
      if (!nextChunk) {
        return
      }

      session.realtimeSocket.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: nextChunk.audioBase64,
        })
      )
      session.realtimeSocket.send(
        JSON.stringify({
          type: "input_audio_buffer.commit",
        })
      )
    }
  }

  private handleRealtimeMessage(
    session: ActiveLiveInterviewSession,
    rawMessage: string
  ): void {
    if (this.session?.thread.id !== session.thread.id || session.isStopping) {
      return
    }

    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(rawMessage) as Record<string, unknown>
    } catch (error) {
      console.error("Failed to parse realtime transcription message:", error)
      return
    }

    const messageType = String(payload.type || "")
    if (messageType === "session.created") {
      session.realtimeReady = true
      this.flushRealtimeAudio(session)
      return
    }

    if (messageType === "conversation.item.input_audio_transcription.delta") {
      const delta = String(payload.delta || "").trim()
      if (!delta) {
        return
      }

      session.partialTranscript = this.normalizeTranscript(
        session.partialTranscript,
        delta
      )
      const combinedTranscript = this.getEffectiveTranscript(session)
      session.latestTranscript = combinedTranscript.slice(-280)
      this.updateState({
        latestTranscript: session.latestTranscript,
      })

      return
    }

    if (messageType === "conversation.item.input_audio_transcription.completed") {
      const transcript = String(
        payload.transcript || payload.text || payload.delta || ""
      ).trim()
      if (!transcript) {
        return
      }

      const normalizedTranscript = this.normalizeTranscript(
        session.transcript,
        transcript
      )
      if (
        normalizedTranscript === session.transcript &&
        !session.partialTranscript.trim()
      ) {
        return
      }

      session.transcript = normalizedTranscript
      session.partialTranscript = ""
      session.latestTranscript = normalizedTranscript.slice(-280)
      this.updateState({
        latestTranscript: session.latestTranscript,
      })
      this.requestImmediateRefresh(session)
      return
    }

    if (
      messageType === "conversation.item.input_audio_transcription.failed" ||
      messageType === "error"
    ) {
      const errorMessage = String(
        (payload.error as { message?: string } | undefined)?.message ||
          payload.message ||
          "Realtime transcription failed."
      ).trim()

      this.updateState({
        latestTranscript: errorMessage,
      })
    }
  }

  private async runTurn(
    session: ActiveLiveInterviewSession
  ): Promise<{ success: true } | { success: false; error: string }> {
    if (this.session?.thread.id !== session.thread.id || session.isStopping) {
      return { success: false, error: "Live interview session is no longer active." }
    }

    const processingHelper = this.deps.getProcessingHelper()
    if (!processingHelper) {
      return {
        success: false,
        error: "Live interview is not available right now.",
      }
    }

    const effectiveTranscript = this.getEffectiveTranscript(session)
    const focusedTranscript = this.getFocusedRefreshTranscript(effectiveTranscript)
    if (!focusedTranscript) {
      return { success: true }
    }

    session.isProcessing = true
    session.immediateRefreshPending = false
    this.updateState({
      status: "running",
      threadId: session.thread.id,
      startedAt: session.startedAt,
      lastUpdatedAt: session.lastUpdatedAt,
      isProcessing: true,
      latestTranscript: session.latestTranscript,
      latestAnswer: session.latestAnswer,
    })

    const result = await processingHelper.processLiveAudioInterviewTurn({
      transcript: focusedTranscript,
      instructions: session.instructions.map((instruction) => instruction.content),
      lastAnswer: session.latestAnswer,
      lastTranscriptHash: session.lastTranscriptHash,
      lastInstructionHash: session.lastInstructionHash,
    })

    if (this.session?.thread.id !== session.thread.id || session.isStopping) {
      return { success: true }
    }

    session.isProcessing = false
    session.lastTranscriptHash = result.contentHash
    session.lastInstructionHash = result.instructionHash

    if (!result.success) {
      this.updateState({
        status: "running",
        threadId: session.thread.id,
        startedAt: session.startedAt,
        lastUpdatedAt: session.lastUpdatedAt,
        isProcessing: false,
        latestTranscript: session.latestTranscript,
        latestAnswer: session.latestAnswer,
      })

      if (session.immediateRefreshPending) {
        this.requestImmediateRefresh(session)
      }

      return { success: true }
    }

    if (result.updated) {
      session.latestAnswer = result.answer
      session.lastUpdatedAt = result.lastUpdatedAt || new Date().toISOString()
    }

    this.updateState({
      status: "running",
      threadId: session.thread.id,
      startedAt: session.startedAt,
      lastUpdatedAt: session.lastUpdatedAt,
      isProcessing: false,
      latestTranscript: session.latestTranscript,
      latestAnswer: session.latestAnswer,
    })

    if (session.immediateRefreshPending) {
      this.requestImmediateRefresh(session)
    }

    return { success: true }
  }

  private async stopInternal(persistFinalAnswer: boolean): Promise<void> {
    const session = this.session
    if (!session) {
      this.state = { ...EMPTY_LIVE_INTERVIEW_STATE }
      this.emitState()
      return
    }

    session.isStopping = true
    if (session.timer) {
      clearTimeout(session.timer)
      session.timer = null
    }
    session.audioChunks = []
    session.partialTranscript = ""
    session.realtimeReady = false

    if (session.realtimeSocket) {
      try {
        if (session.realtimeSocket.readyState === WEBSOCKET_READY_OPEN) {
          session.realtimeSocket.send(
            JSON.stringify({
              type: "input_audio_buffer.commit",
            })
          )
        }
        session.realtimeSocket.close()
      } catch (_error) {
        // Ignore websocket shutdown errors.
      }
      session.realtimeSocket = null
    }

    this.updateState({
      status: "stopping",
      threadId: session.thread.id,
      startedAt: session.startedAt,
      lastUpdatedAt: session.lastUpdatedAt,
      isProcessing: false,
      latestTranscript: session.latestTranscript,
      latestAnswer: session.latestAnswer,
    })

    const processingHelper = this.deps.getProcessingHelper()
    if (processingHelper) {
      processingHelper.cancelLiveInterviewRequest()
    }

    this.session = null

    try {
      if (persistFinalAnswer && session.latestAnswer.trim()) {
        await backendClient.appendChatMessage({
          threadId: session.thread.id,
          role: "assistant",
          content: session.latestAnswer.trim(),
        })
      }
    } finally {
      this.state = { ...EMPTY_LIVE_INTERVIEW_STATE }
      this.emitState()
    }
  }
}

export { LIVE_INTERVIEW_STATE_EVENT }
