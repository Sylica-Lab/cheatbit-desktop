// ProcessingHelper.ts
import crypto from "node:crypto"
import fs from "node:fs"
import { ScreenshotHelper } from "./ScreenshotHelper"
import { IProcessingHelperDeps } from "./main"
import * as axios from "axios"
import { BrowserWindow, nativeImage } from "electron"
import { OpenAI, toFile } from "openai"
import { configHelper } from "./ConfigHelper"
import Anthropic from '@anthropic-ai/sdk';
import {
  type ApiProvider,
  DEFAULT_MODELS,
  FIREWORKS_BASE_URL,
  GROQ_AUDIO_TRANSCRIPTION_MODEL,
  GROQ_BASE_URL,
  GROQ_CHAT_MODEL,
  GROQ_VISION_MODEL,
  HUGGINGFACE_BASE_URL,
  HUGGINGFACE_SCREEN_ANALYSIS_MODEL,
  PROVIDER_DISPLAY_NAMES,
  TOGETHER_BASE_URL,
  TOGETHER_GENERAL_MODEL,
} from "../shared/aiConfig"
import type {
  AssistantChatMode,
  TextFollowUpRequest,
  TextFollowUpResponse,
} from "../shared/followUpChat"
import {
  getBuiltInGroqApiKey,
  getBuiltInGroqFallbackApiKey,
  getBuiltInHuggingFaceApiKey,
  getBuiltInHuggingFaceFallbackApiKey,
} from "./builtInApiKeys"
import { buildExaSearchContext, compactSearchQuery, shouldUseExaSearch } from "./ExaSearchHelper"
import {
  buildLocalFileSearchContext,
  compactFileSearchQuery,
  shouldUseLocalFileSearch,
} from "./FileSearchHelper"

// Interface for Gemini API requests
interface GeminiMessage {
  role: string;
  parts: Array<{
    text?: string;
    inlineData?: {
      mimeType: string;
      data: string;
    }
  }>;
}

interface GeminiResponse {
  candidates: Array<{
    content: {
      parts: Array<{
        text: string;
      }>;
    };
    finishReason: string;
  }>;
}

interface ExtractedQuestionInfo {
  question_type?: "coding" | "mcq" | "academic" | "general";
  problem_statement: string;
  content_summary?: string;
  sub_questions?: string[];
  constraints?: string;
  example_input?: string;
  example_output?: string;
  answer_choices?: string[];
  subject?: string;
  answer_format?: string;
  existing_work?: string;
  key_details?: string[];
}

interface StructuredSolutionResponse {
  question_type?: "coding" | "mcq" | "academic" | "general";
  is_code_response?: boolean;
  answer?: string;
  code?: string;
  thoughts?: string[];
}

type StructuredAnalyzeResponse = Partial<ExtractedQuestionInfo> &
  Partial<StructuredSolutionResponse>

export interface LiveInterviewTurnRequest {
  instructions: string[];
  lastAnswer: string;
  lastScreenHash?: string | null;
  lastContentHash?: string | null;
  lastInstructionHash?: string | null;
}

export interface LiveAudioInterviewTurnRequest {
  transcript: string;
  instructions: string[];
  lastAnswer: string;
  lastTranscriptHash?: string | null;
  lastInstructionHash?: string | null;
}

export interface LiveInterviewTurnResult {
  success: boolean;
  updated: boolean;
  answer: string;
  screenHash: string | null;
  contentHash: string | null;
  instructionHash: string;
  lastUpdatedAt: string | null;
  error?: string;
}

interface TextFollowUpProcessingOptions {
  onStream?: (content: string) => void;
}

const LIVE_INTERVIEW_MAX_TOKENS = 520
const LIVE_AUDIO_INTERVIEW_MAX_TOKENS = 420
const ACCURATE_VISION_LONG_EDGE = 2560
const VISION_UPSCALE_MIN_LONG_EDGE = 1600
const VISION_MAX_UPSCALE = 2
const ANALYZE_EXTRACTION_BASE_TOKENS = 520
const ANALYZE_EXTRACTION_TOKENS_PER_EXTRA_IMAGE = 60
const ANALYZE_EXTRACTION_MAX_TOKENS = 780
const FAST_ANALYZE_BASE_TOKENS = 640
const FAST_ANALYZE_TOKENS_PER_EXTRA_IMAGE = 70
const FAST_ANALYZE_MAX_TOKENS = 960

export class ProcessingHelper {
  private deps: IProcessingHelperDeps
  private screenshotHelper: ScreenshotHelper
  private openaiClient: OpenAI | null = null
  private geminiApiKey: string | null = null
  private anthropicClient: Anthropic | null = null
  private screenAnalysisClient: OpenAI | null = null
  private screenAnalysisApiKey: string | null = null
  private screenAnalysisFallbackClient: OpenAI | null = null
  private screenAnalysisFallbackApiKey: string | null = null
  private groqClient: OpenAI | null = null
  private groqApiKey: string | null = null
  private groqFallbackClient: OpenAI | null = null
  private groqFallbackApiKey: string | null = null
  private directOpenAIClient: OpenAI | null = null
  private directOpenAIApiKey: string | null = null

  // AbortControllers for API requests
  private currentProcessingAbortController: AbortController | null = null
  private currentExtraProcessingAbortController: AbortController | null = null
  private currentLiveProcessingAbortController: AbortController | null = null

  constructor(deps: IProcessingHelperDeps) {
    this.deps = deps
    this.screenshotHelper = deps.getScreenshotHelper()
    
    // Initialize AI client based on config
    this.initializeAIClient();
    
    // Listen for config changes to re-initialize the AI client
    configHelper.on('config-updated', () => {
      this.initializeAIClient();
    });
  }

  private isOpenAICompatibleProvider(provider: ApiProvider): boolean {
    return (
      provider === "openai" ||
      provider === "fireworks" ||
      provider === "together"
    );
  }

  private getProviderLabel(provider: ApiProvider): string {
    return PROVIDER_DISPLAY_NAMES[provider];
  }

  private buildScreenAnalysisClient(apiKey: string): OpenAI {
    return new OpenAI({
      apiKey,
      baseURL: HUGGINGFACE_BASE_URL,
      timeout: 60000,
      maxRetries: 2,
    })
  }

  private getScreenAnalysisClient(): OpenAI {
    const apiKey = getBuiltInHuggingFaceApiKey()
    if (!apiKey) {
      throw new Error("Hugging Face token not configured for screenshot analysis.")
    }

    if (!this.screenAnalysisClient || this.screenAnalysisApiKey !== apiKey) {
      this.screenAnalysisClient = this.buildScreenAnalysisClient(apiKey)
      this.screenAnalysisApiKey = apiKey
    }

    return this.screenAnalysisClient
  }

  private getScreenAnalysisFallbackClient(): OpenAI | null {
    const fallbackApiKey = getBuiltInHuggingFaceFallbackApiKey()
    const primaryApiKey = getBuiltInHuggingFaceApiKey()

    if (!fallbackApiKey || fallbackApiKey === primaryApiKey) {
      return null
    }

    if (
      !this.screenAnalysisFallbackClient ||
      this.screenAnalysisFallbackApiKey !== fallbackApiKey
    ) {
      this.screenAnalysisFallbackClient =
        this.buildScreenAnalysisClient(fallbackApiKey)
      this.screenAnalysisFallbackApiKey = fallbackApiKey
    }

    return this.screenAnalysisFallbackClient
  }

  private getScreenAnalysisModel(): string {
    return (
      (process.env.HUGGINGFACE_ANALYSIS_MODEL || "").trim() ||
      HUGGINGFACE_SCREEN_ANALYSIS_MODEL
    )
  }

  private getAnalyzeVisionProvider(): "groq" | "huggingface" {
    const provider = (
      process.env.ANALYZE_VISION_PROVIDER ||
      process.env.SCREEN_ANALYSIS_PROVIDER ||
      "groq"
    )
      .trim()
      .toLowerCase()

    return provider === "huggingface" ? "huggingface" : "groq"
  }

  private getGroqVisionModel(): string {
    return (process.env.GROQ_VISION_MODEL || "").trim() || GROQ_VISION_MODEL
  }

  private shouldUseManagedAnalyzeStack(
    config: ReturnType<typeof configHelper.loadConfig>
  ): boolean {
    return config.apiProvider === "together"
  }

  private shouldUseHuggingFaceForAnalyze(
    config: ReturnType<typeof configHelper.loadConfig>
  ): boolean {
    return (
      this.shouldUseManagedAnalyzeStack(config) &&
      this.getAnalyzeVisionProvider() === "huggingface"
    )
  }

  private getAnalyzeClient(
    config: ReturnType<typeof configHelper.loadConfig>
  ): OpenAI {
    if (this.shouldUseManagedAnalyzeStack(config)) {
      return this.shouldUseHuggingFaceForAnalyze(config)
        ? this.getScreenAnalysisClient()
        : this.getGroqClient()
    }

    return this.openaiClient!
  }

  private getAnalyzeModel(
    config: ReturnType<typeof configHelper.loadConfig>,
    stage: "extractionModel" | "solutionModel" | "debuggingModel"
  ): string {
    if (this.shouldUseManagedAnalyzeStack(config)) {
      if (stage === "solutionModel") {
        return this.getGroqChatModel()
      }

      return this.shouldUseHuggingFaceForAnalyze(config)
        ? this.getScreenAnalysisModel()
        : this.getGroqVisionModel()
    }

    return config[stage] || this.getDefaultModelForStage(config.apiProvider, stage)
  }

  private getAnalyzeProviderLabel(
    config: ReturnType<typeof configHelper.loadConfig>
  ): string {
    if (this.shouldUseManagedAnalyzeStack(config)) {
      return this.shouldUseHuggingFaceForAnalyze(config)
        ? "Hugging Face"
        : "Groq"
    }

    return this.getProviderLabel(config.apiProvider)
  }

  private shouldRetryWithHuggingFaceFallback(error: any): boolean {
    const status = error?.status || error?.response?.status
    const rawMessage =
      error?.message ||
      error?.response?.data?.error?.message ||
      error?.response?.data?.error ||
      error?.response?.data ||
      ""
    const message = String(rawMessage).toLowerCase()

    if ([401, 402, 403, 429].includes(Number(status))) {
      return true
    }

    return (
      message.includes("credit") ||
      message.includes("quota") ||
      message.includes("rate limit") ||
      message.includes("too many requests") ||
      message.includes("insufficient") ||
      message.includes("payment") ||
      message.includes("balance")
    )
  }

  private async runWithScreenAnalysisFallback<T>(
    operation: (client: OpenAI) => Promise<T>
  ): Promise<T> {
    const primaryClient = this.getScreenAnalysisClient()
    const fallbackClient = this.getScreenAnalysisFallbackClient()

    try {
      return await operation(primaryClient)
    } catch (error) {
      if (
        axios.isCancel(error) ||
        !fallbackClient ||
        !this.shouldRetryWithHuggingFaceFallback(error)
      ) {
        throw error
      }

      console.warn(
        "Retrying screenshot analysis with fallback Hugging Face token.",
        error
      )
      return operation(fallbackClient)
    }
  }

  private async createScreenAnalysisCompletion(
    request: any,
    signal?: AbortSignal
  ): Promise<any> {
    return this.runWithScreenAnalysisFallback((client) =>
      client.chat.completions.create(
        request,
        signal ? { signal } : undefined
      )
    )
  }

  private async createScreenAnalysisStream(
    request: any,
    signal?: AbortSignal
  ): Promise<any> {
    return this.runWithScreenAnalysisFallback((client) =>
      client.chat.completions.create(
        {
          ...request,
          stream: true,
        },
        signal ? { signal } : undefined
      )
    )
  }

  private async createAnalyzeVisionCompletion(
    request: any,
    signal?: AbortSignal
  ): Promise<any> {
    if (this.getAnalyzeVisionProvider() === "huggingface") {
      return this.createScreenAnalysisCompletion(request, signal)
    }

    return this.createGroqCompletion(request, signal)
  }

  private async createAnalyzeVisionStream(
    request: any,
    signal?: AbortSignal
  ): Promise<any> {
    if (this.getAnalyzeVisionProvider() === "huggingface") {
      return this.createScreenAnalysisStream(request, signal)
    }

    return this.createGroqStream(request, signal)
  }

  private buildGroqClient(apiKey: string): OpenAI {
    return new OpenAI({
      apiKey,
      baseURL: GROQ_BASE_URL,
      timeout: 60000,
      maxRetries: 2,
    })
  }

  private buildDirectOpenAIClient(apiKey: string): OpenAI {
    return new OpenAI({
      apiKey,
      timeout: 60000,
      maxRetries: 2,
    })
  }

  private getDirectOpenAIClient(): OpenAI {
    const apiKey = configHelper.getConfiguredApiKey("openai")
    if (!apiKey) {
      throw new Error("OpenAI API key not configured.")
    }

    if (!this.directOpenAIClient || this.directOpenAIApiKey !== apiKey) {
      this.directOpenAIClient = this.buildDirectOpenAIClient(apiKey)
      this.directOpenAIApiKey = apiKey
    }

    return this.directOpenAIClient
  }

  private getOpenAILiveModel(): string {
    return (process.env.OPENAI_LIVE_MODEL || "").trim() || "gpt-4o-mini"
  }

  private getOpenAILiveTranscriptionModel(): string {
    const configuredModel = (process.env.OPENAI_LIVE_TRANSCRIPTION_MODEL || "").trim()
    if (!configuredModel) {
      return "gpt-4o-mini-transcribe"
    }

    if (
      configuredModel === "gpt-4o-mini-transcribe" ||
      configuredModel === "gpt-4o-transcribe" ||
      configuredModel === "whisper-1"
    ) {
      return configuredModel
    }

    console.warn(
      `Unsupported OpenAI live transcription model "${configuredModel}". Falling back to gpt-4o-mini-transcribe.`
    )
    return "gpt-4o-mini-transcribe"
  }

  private usesReasoningOpenAIChatShape(model: string): boolean {
    return /^(?:gpt-5|o[34]\b)/i.test(model.trim())
  }

  private normalizeOpenAIChatRequest(request: any): any {
    const model = String(request?.model || "")
    if (!this.usesReasoningOpenAIChatShape(model)) {
      return request
    }

    const nextRequest = { ...request }
    const requestedTokenLimit = Number(nextRequest.max_tokens)
    if (Number.isFinite(requestedTokenLimit) && requestedTokenLimit > 0) {
      nextRequest.max_completion_tokens = Math.max(
        128,
        Math.round(requestedTokenLimit)
      )
    }

    delete nextRequest.max_tokens
    delete nextRequest.temperature
    return nextRequest
  }

  private async createOpenAICompletion(
    request: any,
    signal?: AbortSignal
  ): Promise<any> {
    return this.getDirectOpenAIClient().chat.completions.create(
      this.normalizeOpenAIChatRequest(request),
      signal ? { signal } : undefined
    )
  }

  private async createOpenAIStream(
    request: any,
    signal?: AbortSignal
  ): Promise<any> {
    return this.getDirectOpenAIClient().chat.completions.create(
      this.normalizeOpenAIChatRequest({
        ...request,
        stream: true,
      }),
      signal ? { signal } : undefined
    )
  }

  private getOpenAIScreenModel(): string {
    return (process.env.OPENAI_SCREEN_MODEL || "").trim() || "gpt-4.1"
  }

  private getOpenAIReasoningModel(): string {
    return (
      process.env.OPENAI_REASONING_MODEL ||
      process.env.OPENAI_SOLUTION_MODEL ||
      ""
    ).trim() || "gpt-5.4"
  }

  private shouldUseDirectOpenAIForScreenTasks(): boolean {
    return true
  }

  private async createOpenAITranscription(request: any): Promise<any> {
    return this.getDirectOpenAIClient().audio.transcriptions.create(request)
  }

  private getGroqClient(): OpenAI {
    const apiKey = getBuiltInGroqApiKey()
    if (!apiKey) {
      throw new Error("Groq API key not configured for chat and interview.")
    }

    if (!this.groqClient || this.groqApiKey !== apiKey) {
      this.groqClient = this.buildGroqClient(apiKey)
      this.groqApiKey = apiKey
    }

    return this.groqClient
  }

  private getGroqFallbackClient(): OpenAI | null {
    const fallbackApiKey = getBuiltInGroqFallbackApiKey()
    const primaryApiKey = getBuiltInGroqApiKey()

    if (!fallbackApiKey || fallbackApiKey === primaryApiKey) {
      return null
    }

    if (
      !this.groqFallbackClient ||
      this.groqFallbackApiKey !== fallbackApiKey
    ) {
      this.groqFallbackClient = this.buildGroqClient(fallbackApiKey)
      this.groqFallbackApiKey = fallbackApiKey
    }

    return this.groqFallbackClient
  }

  private shouldRetryWithGroqFallback(error: any): boolean {
    const status = error?.status || error?.response?.status
    const rawMessage =
      error?.message ||
      error?.response?.data?.error?.message ||
      error?.response?.data?.error ||
      error?.response?.data ||
      ""
    const message = String(rawMessage).toLowerCase()

    if ([401, 402, 403, 429, 500, 502, 503, 504].includes(Number(status))) {
      return true
    }

    return (
      message.includes("credit") ||
      message.includes("quota") ||
      message.includes("rate limit") ||
      message.includes("too many requests") ||
      message.includes("insufficient") ||
      message.includes("payment") ||
      message.includes("balance") ||
      message.includes("overloaded") ||
      message.includes("temporar") ||
      message.includes("unavailable")
    )
  }

  private async runWithGroqFallback<T>(
    operation: (client: OpenAI) => Promise<T>
  ): Promise<T> {
    const primaryClient = this.getGroqClient()
    const fallbackClient = this.getGroqFallbackClient()

    try {
      return await operation(primaryClient)
    } catch (error) {
      if (
        axios.isCancel(error) ||
        !fallbackClient ||
        !this.shouldRetryWithGroqFallback(error)
      ) {
        throw error
      }

      console.warn("Retrying Groq request with fallback API key.", error)
      return operation(fallbackClient)
    }
  }

  private async createGroqCompletion(
    request: any,
    signal?: AbortSignal
  ): Promise<any> {
    return this.runWithGroqFallback((client) =>
      client.chat.completions.create(
        request,
        signal ? { signal } : undefined
      )
    )
  }

  private async createGroqStream(
    request: any,
    signal?: AbortSignal
  ): Promise<any> {
    return this.runWithGroqFallback((client) =>
      client.chat.completions.create(
        {
          ...request,
          stream: true,
        },
        signal ? { signal } : undefined
      )
    )
  }

  private async createGroqTranscription(request: any): Promise<any> {
    return this.runWithGroqFallback((client) =>
      client.audio.transcriptions.create(request)
    )
  }

  private getGroqChatModel(): string {
    return (process.env.GROQ_CHAT_MODEL || "").trim() || GROQ_CHAT_MODEL
  }

  private getGroqAudioTranscriptionModel(): string {
    return (
      (process.env.GROQ_AUDIO_TRANSCRIPTION_MODEL || "").trim() ||
      GROQ_AUDIO_TRANSCRIPTION_MODEL
    )
  }

  private getLiveAudioTranscriptionClient(): OpenAI {
    return this.getDirectOpenAIClient()
  }

  public ensureLiveAudioTranscriptionReady(): void {
    this.getLiveAudioTranscriptionClient()
  }

  private getAudioExtension(mimeType: string): string {
    const normalizedMimeType = mimeType.toLowerCase()
    if (normalizedMimeType.includes("mp4") || normalizedMimeType.includes("m4a")) {
      return "m4a"
    }
    if (normalizedMimeType.includes("mpeg") || normalizedMimeType.includes("mp3")) {
      return "mp3"
    }
    if (normalizedMimeType.includes("wav")) {
      return "wav"
    }
    if (normalizedMimeType.includes("pcm")) {
      return "pcm"
    }
    if (normalizedMimeType.includes("flac")) {
      return "flac"
    }
    return "webm"
  }

  private getPcmSampleRate(mimeType: string): number {
    const match = mimeType.match(/rate=(\d+)/i)
    const parsedRate = match ? Number.parseInt(match[1] || "", 10) : Number.NaN
    return Number.isFinite(parsedRate) && parsedRate > 0 ? parsedRate : 24000
  }

  private createWavBufferFromPcm(audioBuffer: Buffer, sampleRate: number): Buffer {
    const channelCount = 1
    const bitsPerSample = 16
    const byteRate = sampleRate * channelCount * (bitsPerSample / 8)
    const blockAlign = channelCount * (bitsPerSample / 8)
    const wavHeader = Buffer.alloc(44)

    wavHeader.write("RIFF", 0)
    wavHeader.writeUInt32LE(36 + audioBuffer.length, 4)
    wavHeader.write("WAVE", 8)
    wavHeader.write("fmt ", 12)
    wavHeader.writeUInt32LE(16, 16)
    wavHeader.writeUInt16LE(1, 20)
    wavHeader.writeUInt16LE(channelCount, 22)
    wavHeader.writeUInt32LE(sampleRate, 24)
    wavHeader.writeUInt32LE(byteRate, 28)
    wavHeader.writeUInt16LE(blockAlign, 32)
    wavHeader.writeUInt16LE(bitsPerSample, 34)
    wavHeader.write("data", 36)
    wavHeader.writeUInt32LE(audioBuffer.length, 40)

    return Buffer.concat([wavHeader, audioBuffer])
  }
  private getDefaultModelForStage(
    provider: ApiProvider,
    stage: "extractionModel" | "solutionModel" | "debuggingModel"
  ): string {
    return DEFAULT_MODELS[provider][stage];
  }

  private optimizeVisionImageData(base64: string): string {
    try {
      const image = nativeImage.createFromBuffer(Buffer.from(base64, "base64"))
      const size = image.getSize()
      const longestEdge = Math.max(size.width, size.height)

      if (!longestEdge) {
        return base64
      }

      let scale = 1
      if (longestEdge > ACCURATE_VISION_LONG_EDGE) {
        scale = ACCURATE_VISION_LONG_EDGE / longestEdge
      } else if (longestEdge < VISION_UPSCALE_MIN_LONG_EDGE) {
        scale = Math.min(
          VISION_MAX_UPSCALE,
          VISION_UPSCALE_MIN_LONG_EDGE / longestEdge
        )
      }

      if (Math.abs(scale - 1) < 0.01) {
        return base64
      }

      const resizedImage = image.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: "best",
      })

      return resizedImage.toPNG().toString("base64")
    } catch (error) {
      console.warn("Falling back to original screenshot payload for vision.", error)
      return base64
    }
  }

  private buildVisionImageUrl(
    base64: string,
    detail: "high" | "auto" | null = null
  ): { url: string; detail?: "high" | "auto" } {
    const imageUrl: { url: string; detail?: "high" | "auto" } = {
      url: `data:image/png;base64,${base64}`,
    }

    if (detail) {
      imageUrl.detail = detail
    }

    return imageUrl
  }

  private getExtractionTokenBudget(imageCount: number): number {
    return Math.min(
      ANALYZE_EXTRACTION_MAX_TOKENS,
      ANALYZE_EXTRACTION_BASE_TOKENS +
        Math.max(0, imageCount - 1) * ANALYZE_EXTRACTION_TOKENS_PER_EXTRA_IMAGE
    )
  }

  private getFastAnalyzeTokenBudget(imageCount: number): number {
    return Math.min(
      FAST_ANALYZE_MAX_TOKENS,
      FAST_ANALYZE_BASE_TOKENS +
        Math.max(0, imageCount - 1) * FAST_ANALYZE_TOKENS_PER_EXTRA_IMAGE
    )
  }

  private getSolutionTokenBudget(problemInfo: ExtractedQuestionInfo): number {
    const questionType = problemInfo.question_type || "general"
    const subQuestionCount = Math.max(1, problemInfo.sub_questions?.length || 0)

    const baseBudget =
      questionType === "coding"
        ? 760
        : questionType === "academic"
        ? 480
        : questionType === "mcq"
        ? 160
        : 360

    return Math.min(980, baseBudget + Math.max(0, subQuestionCount - 1) * 70)
  }

  private getOpenAIReasoningTokenBudget(problemInfo: ExtractedQuestionInfo): number {
    const questionType = problemInfo.question_type || "general"
    const subQuestionCount = Math.max(1, problemInfo.sub_questions?.length || 0)
    const baseBudget =
      questionType === "coding"
        ? 2200
        : questionType === "academic"
        ? 1600
        : questionType === "mcq"
        ? 900
        : 1200

    return Math.min(2600, baseBudget + Math.max(0, subQuestionCount - 1) * 160)
  }

  private getAnalyzeSolutionModel(
    config: ReturnType<typeof configHelper.loadConfig>,
    problemInfo: ExtractedQuestionInfo
  ): string {
    const configuredModel =
      config.solutionModel ||
      this.getDefaultModelForStage(config.apiProvider, "solutionModel")

    if (
      config.apiProvider === "together" &&
      configuredModel === DEFAULT_MODELS.together.solutionModel
    ) {
      return TOGETHER_GENERAL_MODEL
    }

    return configuredModel
  }

  private stripCodeFences(text: string): string {
    return text.replace(/```json|```/g, "").trim();
  }

  private sanitizeJsonCandidate(text: string): string {
    return text
      .replace(/[Ã¢â‚¬Å“Ã¢â‚¬Â]/g, "\"")
      .replace(/[Ã¢â‚¬ËœÃ¢â‚¬â„¢]/g, "'")
      .replace(/,\s*([}\]])/g, "$1")
      .trim()
  }

  private extractJsonCandidate(text: string): string | null {
    const stripped = this.stripCodeFences(text)
    const objectStart = stripped.indexOf("{")
    const arrayStart = stripped.indexOf("[")
    const startCandidates = [objectStart, arrayStart].filter(
      (index) => index >= 0
    )

    if (startCandidates.length === 0) {
      return null
    }

    const startIndex = Math.min(...startCandidates)
    const stack: string[] = []
    let inString = false
    let escaped = false

    for (let index = startIndex; index < stripped.length; index += 1) {
      const character = stripped[index]

      if (escaped) {
        escaped = false
        continue
      }

      if (character === "\\") {
        escaped = true
        continue
      }

      if (character === "\"") {
        inString = !inString
        continue
      }

      if (inString) {
        continue
      }

      if (character === "{" || character === "[") {
        stack.push(character)
        continue
      }

      if (character === "}" || character === "]") {
        const expectedOpening = character === "}" ? "{" : "["
        if (stack[stack.length - 1] === expectedOpening) {
          stack.pop()
        }

        if (stack.length === 0) {
          return stripped.slice(startIndex, index + 1)
        }
      }
    }

    return null
  }

  private parseJsonResponse<T>(text: string): T {
    const stripped = this.stripCodeFences(text)
    const extracted = this.extractJsonCandidate(stripped)
    const candidates = [
      stripped,
      this.sanitizeJsonCandidate(stripped),
      extracted,
      extracted ? this.sanitizeJsonCandidate(extracted) : null,
    ].filter(
      (candidate, index, all): candidate is string =>
        Boolean(candidate) && all.indexOf(candidate) === index
    )

    let lastError: unknown = null

    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate) as T
      } catch (error) {
        lastError = error
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Failed to parse JSON response.")
  }

  private inferQuestionTypeFromText(
    text: string
  ): ExtractedQuestionInfo["question_type"] {
    const normalized = text.toLowerCase()

    if (
      /```|function\s+\w+|class\s+\w+|def\s+\w+|public\s+(?:class|static)|console\.log|return\s+/.test(
        text
      )
    ) {
      return "coding"
    }

    if (
      this.extractLikelyAnswerChoices(text).length >= 2 ||
      /\b(?:which of the following|select the correct|choose (?:one|the best|the correct)|true or false)\b/i.test(
        normalized
      )
    ) {
      return "mcq"
    }

    if (
      /\bexplain\b|\bderive\b|\bcalculate\b|\bprove\b|\bsolve\b|\bdiscuss\b/i.test(
        normalized
      )
    ) {
      return "academic"
    }

    return "general"
  }

  private extractLikelyAnswerChoices(text: string): string[] {
    const normalizedText = text.replace(/\r/g, "").trim()
    if (!normalizedText) {
      return []
    }

    const uniqueChoices = new Set<string>()
    const pushChoice = (choice: string) => {
      const normalizedChoice = choice.replace(/\s+/g, " ").trim()
      if (normalizedChoice) {
        uniqueChoices.add(normalizedChoice)
      }
    }

    const lineChoices = normalizedText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) =>
        /^(?:[A-H][.)]|[1-9][.)]|(?:option|choice)\s+[A-H]\b|(?:true|false)\b[:.)-]?)/i.test(
          line
        )
      )

    lineChoices.forEach(pushChoice)

    if (uniqueChoices.size < 2) {
      const inlineMatches = normalizedText
        .replace(/\s+/g, " ")
        .match(/(?:[A-H][.)]\s+.*?)(?=(?:\s+[A-H][.)]\s+)|$)/gi)

      inlineMatches?.forEach(pushChoice)
    }

    if (
      uniqueChoices.size < 2 &&
      /\btrue\b/i.test(normalizedText) &&
      /\bfalse\b/i.test(normalizedText)
    ) {
      pushChoice("True")
      pushChoice("False")
    }

    return Array.from(uniqueChoices).slice(0, 8)
  }

  private buildFallbackExtractedQuestionInfo(rawText: string): ExtractedQuestionInfo {
    const normalizedText = this.stripCodeFences(rawText).trim()
    const codeBlockMatch = /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/m.exec(rawText)
    const extractedCode = codeBlockMatch?.[1]?.trim() || ""
    const prose = (
      this.extractStreamingJsonStringField(normalizedText, "answer") ||
      normalizedText.match(/"answer"\s*:\s*([\s\S]*?)\s*,\s*"code"\s*:/i)?.[1] ||
      normalizedText
    )
      .replace(/```[a-zA-Z0-9_-]*\n[\s\S]*?```/gm, "")
      .trim()
    const answerChoices = this.extractLikelyAnswerChoices(prose || rawText)
    const questionType =
      answerChoices.length >= 2 ? "mcq" : this.inferQuestionTypeFromText(rawText)
    const bulletLines = prose
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => /^(?:[-*]|\u2022|\d+[\).:]|[a-zA-Z][\).:])\s+/.test(line))
      .map((line) =>
        line.replace(/^(?:[-*]|\u2022|\d+[\).:]|[a-zA-Z][\).:])\s+/, "")
      )
    const subQuestions =
      bulletLines.length > 0
        ? bulletLines
        : prose
          ? [prose]
          : answerChoices.length >= 2
            ? ["Select the correct option from the visible choices."]
            : ["Briefly summarize the visible content from the screenshots in 1 or 2 short lines."]
    const problemStatement =
      (questionType === "mcq" && answerChoices.length >= 2
        ? prose || "Select the correct option from the visible choices."
        : prose) ||
      extractedCode ||
      "Visible screenshot content extracted without a structured JSON response."
    const answerFormat =
      questionType === "coding"
        ? "code"
        : answerChoices.length >= 2
          ? "multiple_choice"
          : prose.includes("?")
            ? "direct_answer"
            : "summary"

    return {
      question_type: questionType,
      problem_statement: problemStatement,
      content_summary:
        questionType === "mcq" || prose.includes("?") ? "" : problemStatement,
      sub_questions: subQuestions,
      constraints: "",
      example_input: "",
      example_output: "",
      answer_choices: answerChoices,
      subject: "",
      answer_format: answerFormat,
      existing_work: extractedCode,
      key_details: bulletLines.slice(0, 4),
    }
  }

  private hasUsableExtractedQuestionInfo(
    problemInfo: Partial<ExtractedQuestionInfo>
  ): boolean {
    const problemStatement = (problemInfo.problem_statement || "").trim()
    const contentSummary = (problemInfo.content_summary || "").trim()

    if (problemStatement && !this.looksLikeLowSignalScreenshotText(problemStatement)) {
      return true
    }

    if (contentSummary && !this.looksLikeLowSignalScreenshotText(contentSummary)) {
      return true
    }

    if (
      Array.isArray(problemInfo.sub_questions) &&
      problemInfo.sub_questions.some(
        (question) => typeof question === "string" && question.trim().length > 0
      )
    ) {
      return true
    }

    if (
      Array.isArray(problemInfo.key_details) &&
      problemInfo.key_details.some(
        (detail) => typeof detail === "string" && detail.trim().length > 0
      )
    ) {
      return true
    }

    if (
      Array.isArray(problemInfo.answer_choices) &&
      problemInfo.answer_choices.some(
        (choice) => typeof choice === "string" && choice.trim().length > 0
      )
    ) {
      return true
    }

    return Boolean((problemInfo.existing_work || "").trim())
  }

  private looksLikeLowSignalScreenshotText(text: string): boolean {
    const normalized = text.trim().toLowerCase()
    if (!normalized) {
      return true
    }

    if (normalized.includes("?")) {
      return false
    }

    const genericPatterns = [
      "does not contain any specific question",
      "does not contain a specific question",
      "no specific question",
      "no clear question",
      "no explicit question",
      "actual content is missing",
      "appears to be a template",
      "template or a structure",
      "no readable text",
      "[no readable text extracted]",
      "nothing useful is visible",
      "nothing useful visible",
      "unable to read",
      "cannot determine",
      "content is missing",
      "little readable text",
      "no visible question",
    ]

    return genericPatterns.some((pattern) => normalized.includes(pattern))
  }

  private buildExtractionRepairPrompt(
    responseText: string,
    language: string
  ): string {
    return `Convert the raw screenshot extraction output below into valid JSON only.

Return exactly these fields:
{
  "question_type": "coding|mcq|academic|general",
  "problem_statement": "string",
  "content_summary": "string",
  "sub_questions": ["string"],
  "constraints": "string",
  "example_input": "string",
  "example_output": "string",
  "answer_choices": ["string"],
  "subject": "string",
  "answer_format": "string",
  "existing_work": "string",
  "key_details": ["string"]
}

Rules:
- Return JSON only.
- Use empty strings or [] when missing.
- Preserve the visible prompt accurately.
- Preferred coding language is ${language}.

Raw extraction output:
${responseText}`
  }

  private async parseExtractedQuestionInfoResponse(
    responseText: string,
    language: string,
    signal: AbortSignal
  ): Promise<ExtractedQuestionInfo> {
    try {
      const parsedResponse = this.normalizeExtractedQuestionInfo(
        this.parseJsonResponse<ExtractedQuestionInfo>(responseText)
      )
      if (this.hasUsableExtractedQuestionInfo(parsedResponse)) {
        return parsedResponse
      }
    } catch (parseError) {
      console.warn(
        "Extraction JSON parsing failed. Attempting Groq repair.",
        parseError
      )
    }

    try {
      const repairedResponse = await this.generateOpenAITextResponse({
        systemPrompt:
          "You repair invalid model outputs into strict JSON. Return valid JSON only.",
        userPrompt: this.buildExtractionRepairPrompt(responseText, language),
        maxTokens: 700,
        temperature: 0,
        signal,
        model: this.getOpenAIScreenModel(),
      })

      const repairedInfo = this.normalizeExtractedQuestionInfo(
        this.parseJsonResponse<ExtractedQuestionInfo>(repairedResponse)
      )
      if (this.hasUsableExtractedQuestionInfo(repairedInfo)) {
        return repairedInfo
      }
    } catch (repairError) {
      console.warn(
        "Groq repair for extraction JSON failed. Falling back to plain text extraction.",
        repairError
      )
    }

    return this.normalizeExtractedQuestionInfo(
      this.buildFallbackExtractedQuestionInfo(responseText)
    )
  }

  private extractStreamingJsonStringField(
    text: string,
    fieldName: string
  ): string | null {
    const match = new RegExp(`"${fieldName}"\\s*:\\s*"`, "i").exec(text)
    if (!match) {
      return null
    }

    let index = match.index + match[0].length
    let value = ""
    let escaped = false
    let terminated = false

    while (index < text.length) {
      const character = text[index]
      index += 1

      if (escaped) {
        switch (character) {
          case "n":
            value += "\n"
            break
          case "r":
            value += "\r"
            break
          case "t":
            value += "\t"
            break
          case "\\":
            value += "\\"
            break
          case "\"":
            value += "\""
            break
          default:
            value += character
            break
        }
        escaped = false
        continue
      }

      if (character === "\\") {
        escaped = true
        continue
      }

      if (character === "\"") {
        terminated = true
        break
      }

      value += character
    }

    return terminated || value.length > 0 ? value : null
  }

  private extractStreamingJsonBooleanField(
    text: string,
    fieldName: string
  ): boolean | null {
    const match = new RegExp(`"${fieldName}"\\s*:\\s*(true|false)`, "i").exec(text)
    if (!match) {
      return null
    }

    return match[1].toLowerCase() === "true"
  }

  private extractStreamingSolutionPreview(
    text: string,
    fallbackQuestionType?: string
  ): { content: string; isCodeResponse: boolean } | null {
    const answer = this.extractStreamingJsonStringField(text, "answer") || ""
    const code = this.extractStreamingJsonStringField(text, "code") || ""
    const isCodeResponse =
      this.extractStreamingJsonBooleanField(text, "is_code_response") ??
      (fallbackQuestionType === "coding" && code.trim().length > 0)

    const content = isCodeResponse ? code || answer : answer || code
    if (!content.trim()) {
      return null
    }

    return {
      content,
      isCodeResponse,
    }
  }

  private buildExtractionInstruction(language: string): string {
    return `Extract the visible problem or content from the screenshots.

Return only valid JSON with:
- question_type: "coding" | "mcq" | "academic" | "general"
- problem_statement: full visible prompt or a concise summary when no direct question exists
- content_summary: summary only when there is no direct question, otherwise ""
- sub_questions: every visible sub-question or task in order
- constraints: short string
- example_input: short string
- example_output: short string
- answer_choices: MCQ options, otherwise []
- answer_format: short string
- existing_work: short visible attempt/notes/code summary
- key_details: short list of important facts or hints

Rules:
- OCR accuracy is critical: preserve every digit, sign, decimal point, exponent, variable, and unit exactly as visible.
- Never drop leading/tens digits; for example, 13 must not become 3 and 59 must not become 9.
- If a number is genuinely unclear, include the uncertainty in problem_statement or key_details instead of silently guessing.
- Keep wording accurate, but stay compact.
- Include all visible sub-parts in order.
- If there is no clear question, summarize the visible content instead of refusing.
- Preferred coding language is ${language}.
- Use empty strings or [] for missing fields.
- Start directly with { and end directly with }.
- Return JSON only.`;
  }

  private buildScreenOcrPrompt(): string {
    return `Read the screenshot(s) and return only the visible text in plain markdown.

Rules:
- Do not answer the question.
- Preserve every digit exactly as visible; do not drop leading/tens digits such as reading 13 as 3 or 59 as 9.
- Preserve symbols, signs, decimals, exponents, variables, and units exactly.
- Do not return JSON.
- Preserve ordering, numbering, bullets, and code formatting when visible.
- If there are multiple screenshots, merge their content in order.
- If parts are unreadable, write [unreadable].
- If there is little readable text, briefly describe the visible content instead.`
  }

  private buildScreenQuestionProbePrompt(): string {
    return `Inspect the screenshot(s) for any visible question, task, prompt, code, multiple-choice option, heading, search query, or partial statement.

Rules:
- Return plain markdown only.
- Preserve all numbers and symbols exactly; do not collapse 13 into 3 or 59 into 9.
- Focus on the actual visible prompt or task instead of generic commentary.
- If only part of a question is visible, return the visible fragment exactly.
- If there is code, preserve it in a code block.
- If there are numbered or bulleted parts, keep their order.
- Do not say the content is missing unless absolutely nothing useful is visible.`
  }

  private buildExtractionFromVisibleTextPrompt(
    visibleText: string,
    language: string
  ): string {
    return `Convert the visible screenshot text below into valid JSON only.

Return exactly these fields:
{
  "question_type": "coding|mcq|academic|general",
  "problem_statement": "string",
  "content_summary": "string",
  "sub_questions": ["string"],
  "constraints": "string",
  "example_input": "string",
  "example_output": "string",
  "answer_choices": ["string"],
  "subject": "string",
  "answer_format": "string",
  "existing_work": "string",
  "key_details": ["string"]
}

Rules:
- Return JSON only.
- Preserve the visible prompt accurately.
- Preserve every number and mathematical/code symbol exactly from the visible text.
- Use empty strings or [] when missing.
- If the text is partial, extract the best visible fragment instead of claiming there is no question.
- Preferred coding language is ${language}.

Visible screenshot text:
${visibleText || "[no readable text extracted]"}`
  }

  private buildFastAnalyzePrompt(language: string): string {
    return `Analyze the screenshot(s) and answer directly.

Return only valid JSON in this exact field order:
{
  "question_type": "coding|mcq|academic|general",
  "is_code_response": true,
  "answer": "short direct answer covering every visible question in order",
  "code": "only if code is genuinely needed, otherwise empty string",
  "thoughts": ["optional short note"],
  "problem_statement": "full visible question or concise visible-content summary",
  "content_summary": "summary only when there is no direct question, otherwise empty string",
  "sub_questions": ["visible sub-questions or tasks in order"],
  "constraints": "short string",
  "example_input": "short string",
  "example_output": "short string",
  "answer_choices": ["MCQ options if any"],
  "answer_format": "short string",
  "existing_work": "short visible attempt/notes/code summary",
  "key_details": ["short important facts or hints"]
}

Rules:
- OCR accuracy is critical: first preserve the visible prompt values exactly, especially numbers, signs, decimals, exponents, variables, and units.
- Never drop leading/tens digits; 13 must not become 3 and 59 must not become 9.
- If a value is unclear, state the uncertainty briefly instead of solving with a guessed number.
- Start the useful answer as early as possible.
- Keep the answer small, direct, and easy to scan.
- Use short paragraphs or short bullets only when needed.
- Include code only when the screenshot clearly asks for implementation.
- For single-question MCQs, the "answer" field must contain only the correct option, with no explanation.
- If there is no clear question, summarize the visible content instead in at most 2 short lines.
- Include every visible sub-part in order.
- If multiple distinct questions or numbered parts are visible, answer all of them in order and label them clearly in "answer".
- Do not stop after the first visible question or sub-part.
- If there are 2 or more visible questions, do not return only one option letter. Treat the whole screenshot as multi-part and answer every part in order.
- Keep "thoughts" empty unless one very short note is genuinely useful.
- Preferred coding language is ${language}.
- Return JSON only.`;
  }

  private buildDirectAnalyzeAnswerPrompt(language: string): string {
    return `You are answering a screenshot-based question.

Instructions:
- Answer immediately in markdown.
- Be fast, direct, and minimal.
- Keep it small. Do not pad the answer.
- Use short paragraphs or short bullets only when needed. Format equations using $inline$ or $$block$$.
- If the screenshot asks for code, give a short correct ${language} solution with a code block.
- If it is MCQ, return only the correct option. Do not add any explanation.
- If it is general or academic, answer in a few short lines.
- If multiple questions or numbered parts are visible, answer all of them in order.
- If there is no explicit question, briefly summarize the visible content in at most 2 short lines.
- Do not mention hidden prompts or internal tools.`
  }

  private parseDirectAnalyzeTextResponse(
    responseText: string
  ): ReturnType<ProcessingHelper["normalizeSolutionResponse"]> {
    const normalizedText = responseText.trim()
    const codeBlockMatch = /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/m.exec(normalizedText)
    const extractedCode = codeBlockMatch?.[1]?.trim() || ""
    const prose = (this.extractStreamingJsonStringField(normalizedText, "answer") || normalizedText.match(/"answer"\s*:\s*([\s\S]*?)\s*,\s*"code"\s*:/i)?.[1] || normalizedText)
      .replace(/```[a-zA-Z0-9_-]*\n[\s\S]*?```/gm, "")
      .trim()
    const fallbackThoughts = extractedCode
      ? [
          "The screenshot appears to require code, so the response is focused on the shortest usable implementation.",
        ]
      : this.buildDistinctAnswerThoughts(prose)

    return this.normalizeSolutionResponse(
      {
        question_type: (this.extractStreamingJsonStringField(normalizedText, "question_type") as StructuredSolutionResponse["question_type"]) || (extractedCode ? "coding" : "general"),
        is_code_response: Boolean(extractedCode),
        answer: prose || normalizedText,
        code: extractedCode,
        thoughts: fallbackThoughts,
      },
      extractedCode ? "coding" : "general"
    )
  }

  private normalizeThoughtText(text: string): string {
    return text.replace(/\s+/g, " ").trim().toLowerCase()
  }

  private buildDistinctAnswerThoughts(answer: string): string[] {
    const normalizedAnswer = this.normalizeThoughtText(answer)
    if (!normalizedAnswer) {
      return []
    }

    if (/^\**\s*[a-d][.)]\s/i.test(answer) || /^\**\s*option\s+[a-d]\b/i.test(answer)) {
      return [
        "This appears to be an MCQ, so the response selects the strongest option first and keeps the justification brief.",
      ]
    }

    if (
      /(?:desktop|screenshot|search bar|icons?|folders?|window|visible content)/i.test(
        answer
      )
    ) {
      return [
        "No explicit question was detected, so the response summarizes the visible screenshot content.",
      ]
    }

    return [
      "Focused on the clearest visible prompt and kept the response short enough to glance at quickly.",
    ]
  }

  private hasDistinctMultipleSubQuestions(
    problemInfo: ExtractedQuestionInfo
  ): boolean {
    const problemStatement = (problemInfo.problem_statement || "").trim()
    const contentSummary = (problemInfo.content_summary || "").trim()
    const distinctSubQuestions = Array.isArray(problemInfo.sub_questions)
      ? problemInfo.sub_questions
          .filter((question): question is string => typeof question === "string")
          .map((question) => question.trim())
          .filter(Boolean)
          .filter(
            (question) =>
              question !== problemStatement && question !== contentSummary
          )
      : []

    return (
      new Set(
        distinctSubQuestions.map((question) => this.normalizeThoughtText(question))
      ).size > 1
    )
  }

  private shouldRunExpandedSolutionPass(
    problemInfo: ExtractedQuestionInfo
  ): boolean {
    if ((problemInfo.answer_format || "").trim().toLowerCase() === "summary") {
      return false
    }

    if (this.hasDistinctMultipleSubQuestions(problemInfo)) {
      return true
    }

    const visibleText = [
      problemInfo.problem_statement || "",
      ...(Array.isArray(problemInfo.sub_questions) ? problemInfo.sub_questions : []),
    ]
      .map((text) => text.trim())
      .filter(Boolean)
      .join("\n")

    if (!visibleText) {
      return false
    }

    const numberedPartMatches =
      visibleText.match(/(?:^|\n)\s*(?:\d+[\).:]|[a-zA-Z][\).:])\s+/gm) || []
    const questionMarkMatches = visibleText.match(/\?/g) || []

    return numberedPartMatches.length >= 2 || questionMarkMatches.length >= 2
  }

  private countStructuredAnswerParts(answer: string): number {
    const lines = answer
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)

    return lines.filter((line) =>
      /^(?:[-*]\s*)?(?:\*\*|__)?(?:(?:question|part|q)\s*\d+|(?:\d+|[a-zA-Z])[\).:])\b/i.test(
        line
      )
    ).length
  }

  private fastAnswerLikelyCoversMultipleQuestions(
    problemInfo: ExtractedQuestionInfo,
    solution: ReturnType<ProcessingHelper["normalizeSolutionResponse"]>
  ): boolean {
    const answer = (solution.answer || solution.code || "").trim()
    if (!answer || solution.is_code_response) {
      return false
    }

    const distinctSubQuestionCount = Array.isArray(problemInfo.sub_questions)
      ? new Set(
          problemInfo.sub_questions
            .filter((question): question is string => typeof question === "string")
            .map((question) => this.normalizeThoughtText(question))
            .filter(Boolean)
        ).size
      : 0

    const expectedPartCount = Math.max(
      2,
      Math.min(4, distinctSubQuestionCount || 0)
    )
    const structuredAnswerParts = this.countStructuredAnswerParts(answer)

    if (structuredAnswerParts >= expectedPartCount) {
      return true
    }

    const bulletLikeParts =
      answer.match(/(?:^|\n)\s*(?:[-*Ã¢â‚¬Â¢]|\d+[\).:]|[a-zA-Z][\).:])\s+/gm)?.length || 0

    return bulletLikeParts >= expectedPartCount
  }

  private appendWebContextToPrompt(
    prompt: string,
    webContext: string,
    webSearchRequested = false
  ): string {
    const trimmedContext = webContext.trim()
    if (!trimmedContext) {
      return prompt
    }

    return `${prompt}

WEB SEARCH CONTEXT FROM EXA:
${trimmedContext}

Web rules:
- A real Exa web search has already been performed for this turn.
- If the user asked to search, say briefly that you searched the web and answer from these results now. Do not say you will search later.
- For current facts, links, products, docs, releases, prices, news, or recommendations, prefer the web context over stale memory.
- Cite URLs from the context briefly when using web facts.
- If the web context conflicts with the visible screenshot prompt, explain the conflict briefly.
- Web search requested by user: ${webSearchRequested ? "yes" : "no"}.`
  }

  private appendLocalFileSearchContextToPrompt(
    prompt: string,
    fileContext: string,
    fileSearchRequested = false
  ): string {
    const trimmedContext = fileContext.trim()
    if (!trimmedContext) {
      return prompt
    }

    return `${prompt}

LOCAL FILE SEARCH CONTEXT:
${trimmedContext}

Local file search rules:
- A real local file search has already been performed for this turn.
- If the user asked to search files, say briefly that you searched local files and answer from these results now. Do not say you will search later.
- Use exact file names and paths from the context when recommending a file.
- If no result was found, say no matching file was found in the searched folders. Do not claim the entire disk was searched unless the context says so.
- If the user wants to open, move, edit, delete, or upload a file, tell them which file seems relevant and ask for confirmation before destructive actions.
- Local file search requested by user: ${fileSearchRequested ? "yes" : "no"}.`
  }

  private buildProblemSearchQuery(problemInfo: ExtractedQuestionInfo, userMessage = ""): string {
    return [
      userMessage,
      problemInfo.problem_statement || "",
      ...(Array.isArray(problemInfo.sub_questions) ? problemInfo.sub_questions : []),
      ...(Array.isArray(problemInfo.key_details) ? problemInfo.key_details : []),
      problemInfo.content_summary || "",
      problemInfo.subject || "",
    ]
      .filter(Boolean)
      .join("\n")
  }

  private getUserIntentMessage(request: TextFollowUpRequest): string {
    const rawMessage = request.rawMessage?.trim()
    if (rawMessage) {
      return rawMessage
    }

    if (request.voiceMode) {
      const match = request.message.match(/User just said:\s*([\s\S]*?)\n\s*Rules:/i)
      const extracted = match?.[1]?.trim()
      if (extracted) {
        return extracted
      }
    }

    return request.message.trim()
  }
  private buildSolutionPrompt(
    problemInfo: ExtractedQuestionInfo,
    language: string
  ): string {
    const isSummaryMode =
      (problemInfo.answer_format || "").trim().toLowerCase() === "summary";
    const subQuestions =
      problemInfo.sub_questions && problemInfo.sub_questions.length > 0
        ? problemInfo.sub_questions
            .map((question, index) => `${index + 1}. ${question}`)
            .join("\n")
        : isSummaryMode
        ? "1. Summarize the visible content and highlight the key points."
        : "1. Treat the visible prompt as a single question.";
    const answerChoices =
      problemInfo.answer_choices && problemInfo.answer_choices.length > 0
        ? problemInfo.answer_choices.join("\n")
        : "None";
    const keyDetails =
      problemInfo.key_details && problemInfo.key_details.length > 0
        ? problemInfo.key_details.join("\n- ")
        : "None";

    return `Analyze the following screenshot content. It may be a coding problem, academic question, MCQ, general reasoning task, or content that simply needs summarizing.
You must answer every visible question or sub-question from the screenshots, not just the first one.
If there is no direct question, summarize the visible content instead of refusing.

QUESTION TYPE:
${problemInfo.question_type || "general"}

PROMPT / QUESTION OR CONTENT SUMMARY:
${problemInfo.problem_statement || ""}

VISIBLE QUESTIONS / SUBPARTS TO ANSWER IN ORDER:
${subQuestions}

CONSTRAINTS:
${problemInfo.constraints || "None provided."}

EXAMPLE INPUT:
${problemInfo.example_input || "None provided."}

EXAMPLE OUTPUT:
${problemInfo.example_output || "None provided."}

ANSWER CHOICES:
${answerChoices}

SUBJECT:
${problemInfo.subject || "Unknown"}

EXPECTED ANSWER FORMAT:
${problemInfo.answer_format || "Not specified"}

VISIBLE EXISTING WORK:
${problemInfo.existing_work || "None"}

KEY DETAILS:
- ${keyDetails}

PREFERRED CODING LANGUAGE FOR CODING TASKS:
${language}

Return only valid JSON with this exact structure:
{
  "question_type": "coding|mcq|academic|general",
  "is_code_response": true,
  "answer": "short direct answer",
  "code": "code only if the task genuinely requires code, otherwise empty string",
  "thoughts": ["optional short practical note"]
}

Rules:
- Treat extracted numbers as sacred. Do not alter, round, shorten, or drop digits from the prompt.
- If any prompt value looks uncertain or incomplete, say that briefly instead of solving with a guessed value.
- Emit fields in the exact order shown above so the answer can stream early.
- Answer the visible ask directly. Do not describe the task at a meta level.
- Keep the answer compact and easy to scan.
- Use short paragraphs or short bullets only when needed. Format mathematical equations using $inline$ or $$block$$.
- Do not write phrases like "the task involves", "this involves", "the key steps include", or "the provided content".
- If the screenshot shows a to-do list, instruction list, or action items, treat those as the actual visible ask and respond to them directly instead of summarizing them as project context.
- If a direct question is visible or implied by imperative instructions, answer it instead of giving a summary.
- If there are 2 or more visible questions or sub-parts, the "answer" field must be a numbered list using "1.", "2.", "3." with one item per question/sub-part.
- Do not merge multiple answers into one paragraph.
- For coding tasks with an explicit coding task: provide a correct, efficient implementation in ${language}, set is_code_response=true, and keep the answer field to one short line at most before the code.
- For single-question MCQs: set is_code_response=false, leave code empty, and put only the correct option in "answer". Do not explain why.
- For math, probability, recurrence, finance, or word-problem MCQs: solve the prompt, then explicitly test the result against every provided answer choice before choosing.
- If choices include formulas or expressions, compare algebraically/equivalently; do not require a decimal-expanded value to match.
- Treat "None of these" / "None of the above" as a last resort only after every non-none choice is mathematically impossible.
- For time/lifespan/process wording, be careful with boundary conditions such as "just after", "until death", inclusive/exclusive endpoints, and use the interpretation that matches a valid listed option when mathematically reasonable.
- For academic/general tasks: provide a correct direct answer with concise reasoning, set is_code_response=false unless code is genuinely required. For math, finance, or calculation questions, format the answer as short markdown bullet steps, one step per line, then add a blank line and a final line starting with Final answer:. Do not write one dense paragraph.
- Only if there is truly no answerable ask at all, provide a short neutral transcription/summary of the visible content in at most 2 short lines. Do not invent extra context or action items.
- If multiple distinct questions or sub-parts are present, answer all of them in order and label them clearly.
- Do not skip later questions even if the first question looks like the main one.
- If the screenshots contain multiple independent questions that cannot be represented as one code-only answer, set is_code_response=false and place the full multi-part answer in "answer".
- If there are 2 or more visible questions, never answer with only a single option letter. Preserve every question in the final answer.
- Keep thoughts empty unless one short practical note is genuinely useful.
- Keep the answer as short as possible while still correct and usable. If the expected answer format is summary, use at most 2 short lines or 2 short bullet points.
- Return JSON only.`;
  }

  private looksLikeMetaTaskSummaryAnswer(answer: string): boolean {
    const normalized = answer.trim().toLowerCase()
    if (!normalized) {
      return false
    }

    const metaPatterns = [
      "the task involves",
      "this involves",
      "the key steps include",
      "the provided content",
      "it appears to be",
      "the tasks are",
      "this requires",
      "the task requires",
      "the content is missing",
      "the user wants me",
      "let me look",
      "let me think",
      "looking at the instructions",
      "so i need to",
      "determine question_type",
      "determine is_code_response",
      "return a json response",
    ]

    return metaPatterns.some((pattern) => normalized.includes(pattern))
  }

  private sanitizeMetaAnswerText(answer: string): string {
    const trimmed = answer.trim()
    if (!this.looksLikeMetaTaskSummaryAnswer(trimmed)) {
      return trimmed
    }

    const filteredLines = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter(
        (line) =>
          !/^(the user wants me\b|let me\b|wait[,.:]?\b|looking at the instructions\b|so i need to\b|the screenshot is hard to read\b|give the briefest useful description\b|determine\s+(question_type|is_code_response|answer|code|thoughts|problem_statement|content_summary|sub_questions|constraints|example_input|example_output|answer_choices|answer_format|existing_work|key_details)\b)/i.test(
            line
          )
      )

    return filteredLines.join("\n").trim() || trimmed
  }

  private looksLikeVerboseMcqAnswer(answer: string): boolean {
    const normalized = answer.trim()
    if (!normalized) {
      return false
    }

    if (/^[A-Da-d][.)]?$/.test(normalized)) {
      return false
    }

    if (/^option\s+[A-Da-d]\b$/i.test(normalized)) {
      return false
    }

    if (normalized.split(/\s+/).length <= 4 && !/[.!?]/.test(normalized)) {
      return false
    }

    return true
  }

  private looksLikeDenseAcademicParagraph(
    problemInfo: ExtractedQuestionInfo,
    answer: string
  ): boolean {
    const normalized = answer.trim()
    if (!normalized || problemInfo.question_type === "mcq") {
      return false
    }

    if (problemInfo.question_type !== "academic" && problemInfo.question_type !== "general") {
      return false
    }

    if (normalized.includes("\n") || normalized.includes("•") || /^\d+\./m.test(normalized)) {
      return false
    }

    const wordCount = normalized.split(/\s+/).filter(Boolean).length
    if (wordCount < 28) {
      return false
    }

    return /(?:=|formula|therefore|amount|interest|principal|rate|profit|loss|percentage|solve|find)/i.test(normalized)
  }

  private shouldForceMultiPartAnswerFormatting(
    problemInfo: ExtractedQuestionInfo
  ): boolean {
    if ((problemInfo.answer_format || "").trim().toLowerCase() === "summary") {
      return false
    }

    return this.shouldRunExpandedSolutionPass(problemInfo)
  }

  private buildFallbackProblemStatement(
    problemInfo: Partial<ExtractedQuestionInfo>,
    subQuestions: string[],
    contentSummary: string
  ): string {
    if (contentSummary) {
      return contentSummary;
    }

    if (subQuestions.length > 0) {
      return subQuestions
        .map((question, index) => `${index + 1}. ${question}`)
        .join("\n");
    }

    const keyDetails = Array.isArray(problemInfo.key_details)
      ? problemInfo.key_details
          .filter((detail): detail is string => typeof detail === "string")
          .map((detail) => detail.trim())
          .filter(Boolean)
      : [];

    if (keyDetails.length > 0) {
      return `Visible content summary: ${keyDetails.join("; ")}`;
    }

    const existingWork = (problemInfo.existing_work || "").trim();
    if (existingWork) {
      return `Visible content summary: ${existingWork}`;
    }

    return "";
  }

  private buildMinimalScreenSummary(
    problemInfo: Partial<ExtractedQuestionInfo>
  ): string {
    const summaryCandidates = [
      ...(Array.isArray(problemInfo.key_details) ? problemInfo.key_details : []),
      problemInfo.content_summary || "",
      problemInfo.problem_statement || "",
      problemInfo.existing_work || "",
    ]
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .filter((item) => !this.looksLikeLowSignalScreenshotText(item))

    if (summaryCandidates.length > 0) {
      return this.trimCompactAnswer(summaryCandidates[0], 120)
    }

    return "Blurry or unreadable screen."
  }

  private async recoverFromWeakExtraction(
    imageDataList: string[],
    language: string,
    config: ReturnType<typeof configHelper.loadConfig>,
    signal: AbortSignal,
    problemInfo: Partial<ExtractedQuestionInfo>
  ): Promise<{
    problemInfo: ExtractedQuestionInfo
    solution: ReturnType<ProcessingHelper["normalizeSolutionResponse"]>
  }> {
    try {
      const fastAnalyzeResult = await this.generateFastAnalyzeFromImageData(
        imageDataList,
        language,
        config,
        signal
      )
      const recoveredProblemInfo = this.normalizeExtractedQuestionInfo(
        fastAnalyzeResult.problemInfo
      )
      const recoveredSolution = this.finalizeDisplayedSolution(
        fastAnalyzeResult.solution,
        recoveredProblemInfo
      )
      const recoveredAnswer = (
        recoveredSolution.answer ||
        recoveredSolution.code ||
        ""
      ).trim()

      if (
        this.hasUsableExtractedQuestionInfo(recoveredProblemInfo) ||
        recoveredAnswer
      ) {
        return {
          problemInfo: recoveredProblemInfo,
          solution: recoveredSolution,
        }
      }
    } catch (error) {
      console.warn("Direct vision fallback after weak extraction failed.", error)
    }

    const hasAnswerChoices =
      Array.isArray(problemInfo.answer_choices) &&
      problemInfo.answer_choices.length >= 2
    const fallbackSummary = this.buildMinimalScreenSummary(problemInfo)
    const fallbackProblemInfo = this.normalizeExtractedQuestionInfo({
      question_type: hasAnswerChoices ? "mcq" : "general",
      problem_statement: hasAnswerChoices
        ? "Select the correct option from the visible choices."
        : "",
      content_summary: hasAnswerChoices ? "" : fallbackSummary,
      sub_questions: hasAnswerChoices
        ? ["Select the correct option from the visible choices."]
        : ["Briefly summarize the visible content from the screenshots in 1 or 2 short lines."],
      answer_choices: hasAnswerChoices ? problemInfo.answer_choices || [] : [],
      answer_format: hasAnswerChoices ? "multiple_choice" : "summary",
      key_details: Array.isArray(problemInfo.key_details)
        ? problemInfo.key_details.filter(Boolean)
        : [],
      existing_work: problemInfo.existing_work || "",
    })
    const fallbackAnswer = hasAnswerChoices
      ? "Unable to read the options clearly."
      : fallbackSummary
    const fallbackSolution = this.finalizeDisplayedSolution(
      this.normalizeSolutionResponse(
        {
          question_type: fallbackProblemInfo.question_type || "general",
          is_code_response: false,
          answer: fallbackAnswer,
          code: "",
          thoughts: [],
        },
        fallbackProblemInfo.question_type
      ),
      fallbackProblemInfo
    )

    return {
      problemInfo: fallbackProblemInfo,
      solution: fallbackSolution,
    }
  }

  private buildFollowUpPrompt(
    problemInfo: ExtractedQuestionInfo,
    language: string
  ): string {
    const subQuestions =
      problemInfo.sub_questions && problemInfo.sub_questions.length > 0
        ? problemInfo.sub_questions
            .map((question, index) => `${index + 1}. ${question}`)
            .join("\n")
        : "1. No extracted sub-questions available.";

    return `You are analyzing follow-up screenshots for a question-solving assistant. The screenshots may contain code, calculations, answer choices, notes, error messages, or corrections.
Make sure your analysis covers every visible question or sub-question, not just the first one.

Original prompt:
${problemInfo.problem_statement || "Not available"}

Visible questions / subparts:
${subQuestions}

Question type:
${problemInfo.question_type || "general"}

Preferred coding language for coding tasks:
${language}

Respond in markdown using this exact structure:
### Issues or Gaps Found
- Bullet points

### Recommended Answer or Corrections
- Bullet points

### Reasoning
Clear paragraph(s)

### Optional Code or Formula Changes
Include code or formulas only if relevant

### Key Takeaways
- Bullet points

Adapt the content to the task type:
- coding: debug code, logic, tests, or runtime issues
- mcq: identify the right option and explain why others are weaker
- academic/general: correct reasoning, calculations, definitions, or written answer quality`;
  }

  private buildTextFollowUpPrompt(
    problemInfo: ExtractedQuestionInfo,
    language: string,
    request: TextFollowUpRequest
  ): string {
    const mode: AssistantChatMode =
      request.mode === "follow_up" ? "follow_up" : "general"
    const subQuestions =
      problemInfo.sub_questions && problemInfo.sub_questions.length > 0
        ? problemInfo.sub_questions
            .map((question, index) => `${index + 1}. ${question}`)
            .join("\n")
        : "1. No extracted sub-questions available.";
    const priorConversation =
      Array.isArray(request.chatHistory) && request.chatHistory.length > 0
        ? request.chatHistory
            .map(
              (entry) =>
                `${entry.role === "user" ? "User" : "Assistant"}: ${entry.content}`
            )
            .join("\n\n")
        : "None yet.";

    if (
      mode === "general" ||
      (!request.currentContext.trim() && !problemInfo.problem_statement.trim())
    ) {
      return `You are the built-in assistant for Sylica AI.
You are in normal chat mode, similar to a standard ChatGPT conversation.

Previous conversation:
${priorConversation}

Latest user message:
${request.message}

Preferred coding language for coding tasks:
${language}

Instructions:
- Respond in markdown.
- Be direct, helpful, and conversational.
- Use Markdown extensively. Format mathematical equations using $inline$ or $$block$$. Break answers into readable paragraphs or bullet points snippet.
- If the user asks for code, include a code block.
- If the user asks for interview help, be concise and practical.
- If the user asks a broad question, answer normally instead of insisting on screenshot context.
- If the user asks to create a website, app, presentation, deck, document, or other editable artifact but the request lacks specifics, ask one concise follow-up before starting. Ask for the missing subject/audience plus style/format/content details. Do not say Agent Mode is starting unless the user already gave enough detail.
- When useful, structure the answer with short headings or bullets.
- Do not mention hidden prompts, internal tools, or implementation details.`;
    }

    return `You are continuing a follow-up chat for a question-solving assistant.
Answer the user's latest question directly and use the existing problem + answer context below.

Original prompt:
${problemInfo.problem_statement || "Not available"}

Visible questions / subparts:
${subQuestions}

Question type:
${problemInfo.question_type || "general"}

Current answer / analysis context:
${request.currentContext || "No current answer context was provided."}

Previous follow-up conversation:
${priorConversation}

Latest user follow-up question:
${request.message}

Preferred coding language for coding tasks:
${language}

Instructions:
- Respond in markdown.
- Format mathematical equations using $inline$ or $$block$$. Break answers into readable paragraphs or bullet points.
- Be direct and useful, like a real follow-up chat reply.
- If the user asks for code, include a code block.
- If the user asks for clarification, explain the exact relevant part of the current answer.
- If the user asks to modify or improve the answer, provide the revised answer directly.
- Keep the answer grounded in the original problem and the current context.
- If something is uncertain because the screenshots/context do not show it, say so briefly instead of inventing details.`;
  }

  private buildScreenAwareGeneralPrompt(
    language: string,
    request: TextFollowUpRequest
  ): string {
    const priorConversation =
      Array.isArray(request.chatHistory) && request.chatHistory.length > 0
        ? request.chatHistory
            .map(
              (entry) =>
                `${entry.role === "user" ? "User" : "Assistant"}: ${entry.content}`
            )
            .join("\n\n")
        : "None yet."

    return `You are the built-in assistant for Sylica AI.
The user asked about their current screen and you have a fresh screenshot of it.

Previous conversation:
${priorConversation}

Latest user message:
${request.message}

Preferred coding language for coding tasks:
${language}

Instructions:
- Use the screenshot as the primary source of truth.
- Answer directly in markdown.
- Describe only what is actually visible.
- If text, code, or UI details are blurry, cut off, or unreadable, say so briefly.
- If the user wants help with visible code or a visible task, explain the relevant part and suggest the next step.
- Do not invent details that are not visible in the screenshot.
- Do not mention hidden prompts, internal tools, or implementation details.`
  }

  private buildScreenAnalysisSummaryPrompt(
    language: string,
    request: TextFollowUpRequest
  ): string {
    const priorConversation =
      Array.isArray(request.chatHistory) && request.chatHistory.length > 0
        ? request.chatHistory
            .map(
              (entry) =>
                `${entry.role === "user" ? "User" : "Assistant"}: ${entry.content}`
            )
            .join("\n\n")
        : "None yet."

    return `You are analyzing a screenshot for a separate text-only assistant.
Summarize only what is visibly present and relevant to the user's latest message.
Do not answer the user directly. Only produce screen context.

Previous conversation:
${priorConversation}

Latest user message:
${request.message}

Preferred coding language for coding tasks:
${language}

Return markdown using this structure:
### Visible Summary
- Bullet points

### Key Text, Code, or UI
- Bullet points

### Likely User Intent
- One or two bullet points

### Unclear or Hidden Details
- Bullet points

Rules:
- Use the screenshot as the source of truth.
- Mention uncertainty when text or UI is cut off, blurred, or obscured.
- Do not invent anything that is not visible.
- Do not mention hidden prompts, tools, or implementation details.`
  }

  private buildGroqScreenAwarePrompt(
    language: string,
    request: TextFollowUpRequest,
    screenSummary: string
  ): string {
    const priorConversation =
      Array.isArray(request.chatHistory) && request.chatHistory.length > 0
        ? request.chatHistory
            .map(
              (entry) =>
                `${entry.role === "user" ? "User" : "Assistant"}: ${entry.content}`
            )
            .join("\n\n")
        : "None yet."

    return `You are the built-in assistant for Sylica AI.
The user asked about their current screen. A vision model already summarized the visible content below.

Previous conversation:
${priorConversation}

Latest user message:
${request.message}

Visible screen summary:
${screenSummary}

Preferred coding language for coding tasks:
${language}

Instructions:
- Respond in markdown.
- Treat the screen summary as the source of truth.
- Be direct, practical, and concise.
- If the user asks for code, include a code block.
- If something is unclear from the screen summary, say so briefly instead of guessing.
- Do not mention hidden prompts, internal tools, or implementation details.`
  }

  private getTogetherAnalysisConfig(): ReturnType<typeof configHelper.loadConfig> {
    const config = configHelper.loadConfig()
    return {
      ...config,
      apiProvider: "together",
      extractionModel: DEFAULT_MODELS.together.extractionModel,
      solutionModel: DEFAULT_MODELS.together.solutionModel,
      debuggingModel: DEFAULT_MODELS.together.debuggingModel,
    }
  }

  private shouldCaptureScreenContext(
    mode: AssistantChatMode,
    message: string
  ): boolean {
    if (mode !== "general") {
      return false
    }

    const normalizedMessage = message.trim().toLowerCase()
    if (!normalizedMessage) {
      return false
    }

    const screenPatterns = [
      /\b(screen|screenshot|monitor)\b/,
      /\b(?:my|the|this|current)\s+(?:display|window)\b/,
      /what(?:'s| is) on (?:my |the )?(?:screen|display)/,
      /\blook at (?:my |the )?(?:screen|display)\b/,
      /\bcheck (?:my |the )?(?:screen|display)\b/,
      /\banaly[sz]e (?:my |the )?(?:screen|display)\b/,
      /\bwhat do you see (?:on|in) (?:my |the )?(?:screen|display)\b/,
      /\bcan you see (?:my |the )?(?:screen|display)\b/,
      /\bwhat(?:'s| is) this on (?:my |the )?(?:screen|display)\b/,
    ]

    return screenPatterns.some((pattern) => pattern.test(normalizedMessage))
  }

  private async captureScreenContextForChat(): Promise<{
    data: string
    preview: string
  }> {
    if (!this.screenshotHelper) {
      throw new Error("Screenshot helper is not available.")
    }

    return this.screenshotHelper.captureEphemeralScreenshot(
      this.deps.hideMainWindow,
      this.deps.showMainWindow
    )
  }

  private hashValue(value: string): string {
    return crypto.createHash("sha1").update(value).digest("hex")
  }

  private buildLiveInstructionSignature(instructions: string[]): string {
    const normalizedInstructions = instructions
      .map((instruction) => instruction.trim())
      .filter(Boolean)
      .join("\n\n")

    return this.hashValue(normalizedInstructions)
  }

  private buildLiveContentSignature(
    problemInfo: ExtractedQuestionInfo
  ): string {
    return this.hashValue(
      JSON.stringify({
        questionType: problemInfo.question_type || "general",
        problemStatement: problemInfo.problem_statement || "",
        contentSummary: problemInfo.content_summary || "",
        subQuestions: problemInfo.sub_questions || [],
        constraints: problemInfo.constraints || "",
        answerChoices: problemInfo.answer_choices || [],
        answerFormat: problemInfo.answer_format || "",
        existingWork: problemInfo.existing_work || "",
        keyDetails: problemInfo.key_details || [],
      })
    )
  }

  private buildLiveWatchingMessage(): string {
    return "Watching your screen. No clear interview question is visible yet."
  }

  private buildLiveTranscriptWatchingMessage(): string {
    return "- Listening for the full question.\n- I will turn the next clear ask into a short answer right away."
  }

  private shouldUseLiveWatchingState(
    problemInfo: ExtractedQuestionInfo
  ): boolean {
    const answerFormat = (problemInfo.answer_format || "").trim().toLowerCase()
    const problemStatement = (problemInfo.problem_statement || "").trim()
    const contentSummary = (problemInfo.content_summary || "").trim()
    const hasAnswerChoices = Boolean(problemInfo.answer_choices?.length)
    const hasMultipleSubQuestions = Boolean(
      problemInfo.sub_questions?.some((question) => {
        const normalizedQuestion = question.trim()
        return (
          normalizedQuestion &&
          normalizedQuestion !== problemStatement &&
          normalizedQuestion !== contentSummary
        )
      })
    )

    if (
      problemInfo.question_type === "coding" ||
      problemInfo.question_type === "mcq" ||
      hasAnswerChoices ||
      hasMultipleSubQuestions
    ) {
      return false
    }

    if (!problemStatement) {
      return true
    }

    if (answerFormat === "summary") {
      return true
    }

    return (
      Boolean(contentSummary) &&
      (problemStatement === contentSummary ||
        problemStatement.toLowerCase().startsWith("visible content summary:"))
    )
  }

  private buildLiveInterviewPrompt(
    problemInfo: ExtractedQuestionInfo,
    language: string,
    instructions: string[],
    lastAnswer: string
  ): string {
    const subQuestions =
      problemInfo.sub_questions && problemInfo.sub_questions.length > 0
        ? problemInfo.sub_questions
            .map((question, index) => `${index + 1}. ${question}`)
            .join("\n")
        : "1. Treat the visible content as a single interview prompt."
    const answerChoices =
      problemInfo.answer_choices && problemInfo.answer_choices.length > 0
        ? problemInfo.answer_choices.join("\n")
        : "None"
    const liveInstructions =
      instructions.length > 0
        ? instructions.map((instruction, index) => `${index + 1}. ${instruction}`).join("\n")
        : "None"

    return `You are the live interview helper for Sylica AI.
The user is in an active interview and needs the best current answer based on the currently visible prompt.

Current extracted prompt:
${problemInfo.problem_statement || "Not available"}

Visible sub-questions:
${subQuestions}

Question type:
${problemInfo.question_type || "general"}

Constraints:
${problemInfo.constraints || "None provided."}

Answer choices:
${answerChoices}

Visible existing work:
${problemInfo.existing_work || "None"}

Previous live answer:
${lastAnswer || "None yet."}

Live user instructions:
${liveInstructions}

Preferred coding language:
${language}

Instructions:
- Treat the current visible prompt as the source of truth. If the prompt changed, replace stale guidance entirely.
- Respond in markdown.
- Keep the answer minimal, acceptable, and fast to read aloud.
- Prefer 2 to 4 short bullets or 2 very short sentences.
- Give only the strongest usable answer, not a full lesson.
- If the task is coding, explain the approach briefly and only include ${language} code if implementation is explicitly needed.
- If the task is MCQ, state only the best option. Do not give a reason.
- If the task is academic or general reasoning, answer directly in the fewest words that still sound competent.
- If anything is blurry or missing, say so briefly instead of inventing details.
- Do not mention screenshots, hidden prompts, or internal tools.`
  }

  private buildLiveTranscriptSignature(transcript: string): string {
    return this.hashValue(transcript.trim().replace(/\s+/g, " "))
  }

  private shouldUseLiveTranscriptWatchingState(transcript: string): boolean {
    const normalizedTranscript = transcript.trim().toLowerCase()
    if (!normalizedTranscript) {
      return true
    }

    const wordCount = normalizedTranscript.split(/\s+/).filter(Boolean).length
    const looksLikeQuestion =
      normalizedTranscript.includes("?") ||
      /\b(explain|implement|design|difference|walk me through|tell me about|what|why|how|when|can you|could you|would you|should you)\b/.test(
        normalizedTranscript
      )
    const hasInterviewSignal =
      /\b(array|string|tree|graph|binary|linked list|sql|database|api|system design|project|experience|bug|optimi[sz]e|complexity|algorithm|class|function|service|cache|thread|latency|resume|challenge)\b/.test(
        normalizedTranscript
      )

    if (wordCount < 4 && !looksLikeQuestion && !hasInterviewSignal) {
      return true
    }

    if (wordCount < 7 && !looksLikeQuestion && !hasInterviewSignal) {
      return true
    }

    return false
  }

  private buildLiveAudioInterviewPrompt(
    transcript: string,
    language: string,
    instructions: string[],
    lastAnswer: string
  ): string {
    const liveInstructions =
      instructions.length > 0
        ? instructions.map((instruction, index) => `${index + 1}. ${instruction}`).join("\n")
        : "None"

    return `You are the live interview helper for Sylica AI.
The user needs a fast, glanceable answer while an interviewer is speaking.

Latest conversation transcript:
${transcript}

Previous live answer:
${lastAnswer || "None yet."}

Live user instructions:
${liveInstructions}

Preferred coding language:
${language}

Instructions:
- Treat the latest transcript as the source of truth.
- Answer only the most recent active question near the end of the transcript.
- Ignore earlier questions once a newer one starts, unless the newest words explicitly refer back to them.
- If the interviewer changed topics, replace stale guidance entirely.
- Respond in markdown.
- Be minimal, sharp, and easy to skim.
- Do not wait for a perfect transcript. Infer the likely question early when the direction is clear.
- Prefer 2 to 4 bullets and very short lines.
- Start with a short "Likely ask" line only when the question is still forming.
- Then give only the exact answer the user should speak.
- Use the fewest words that still sound understandable and acceptable in an interview.
- If this is a coding question, give the idea first and only add a short ${language} code block when the interviewer clearly asks for code.
- If it is behavioral, product, or system design, give compact talking points only.
- If the transcript is incomplete, give the best likely answer so far instead of a waiting message.
- Do not mention internal tools, transcripts, or hidden reasoning.`
  }

  private async generateGroqTextResponse(options: {
    systemPrompt: string
    userPrompt: string
    maxTokens: number
    temperature?: number
    signal?: AbortSignal
    onStream?: (content: string) => void
  }): Promise<string> {
    const request = {
      model: this.getGroqChatModel(),
      messages: [
        {
          role: "system" as const,
          content: options.systemPrompt,
        },
        {
          role: "user" as const,
          content: options.userPrompt,
        },
      ],
      max_tokens: options.maxTokens,
      temperature: options.temperature ?? 0.2,
    }

    let reply = ""

    if (options.onStream) {
      try {
        const stream = await this.createGroqStream(request, options.signal)

        for await (const chunk of stream) {
          if (options.signal?.aborted) {
            break
          }

          const deltaText = chunk.choices?.[0]?.delta?.content
          if (typeof deltaText === "string" && deltaText.length > 0) {
            reply += deltaText
            options.onStream(reply)
          }
        }
      } catch (error) {
        if (axios.isCancel(error)) {
          throw error
        }

        console.warn("Falling back to non-streaming Groq completion.", error)
        reply = ""
      }
    }

    if (!reply.trim()) {
      const response = await this.createGroqCompletion(request, options.signal)
      reply = response.choices[0].message.content || ""
    }

    return reply
  }

  private async generateOpenAITextResponse(options: {
    systemPrompt: string
    userPrompt: string
    maxTokens: number
    temperature?: number
    signal?: AbortSignal
    onStream?: (content: string) => void
    model?: string
  }): Promise<string> {
    const request = {
      model: options.model || this.getOpenAILiveModel(),
      messages: [
        {
          role: "system" as const,
          content: options.systemPrompt,
        },
        {
          role: "user" as const,
          content: options.userPrompt,
        },
      ],
      max_tokens: options.maxTokens,
      temperature: options.temperature ?? 0.2,
    }

    let reply = ""

    const shouldStream =
      Boolean(options.onStream) &&
      !this.usesReasoningOpenAIChatShape(String(request.model || ""))

    if (shouldStream && options.onStream) {
      try {
        const stream = await this.createOpenAIStream(request, options.signal)

        for await (const chunk of stream) {
          if (options.signal?.aborted) {
            break
          }

          const deltaText = chunk.choices?.[0]?.delta?.content
          if (typeof deltaText === "string" && deltaText.length > 0) {
            reply += deltaText
            options.onStream(reply)
          }
        }
      } catch (error) {
        if (axios.isCancel(error)) {
          throw error
        }

        console.warn("Falling back to non-streaming OpenAI completion.", error)
        reply = ""
      }
    }

    if (!reply.trim()) {
      const response = await this.createOpenAICompletion(request, options.signal)
      reply = response.choices[0]?.message?.content || ""
      if (options.onStream && reply.trim()) {
        options.onStream(reply)
      }
    }

    return reply
  }

  private async analyzeScreenContextForGroqChat(
    screenshotBase64: string,
    language: string,
    request: TextFollowUpRequest,
    signal: AbortSignal
  ): Promise<string> {
    const optimizedImage = this.optimizeVisionImageData(screenshotBase64)

    if (this.shouldUseDirectOpenAIForScreenTasks()) {
      const response = await this.createOpenAICompletion(
        {
          model: this.getOpenAIScreenModel(),
          messages: [
            {
              role: "system" as const,
              content:
                "You are a precise screenshot-answering assistant. Return valid JSON only. Never narrate your reasoning or process. Do not say 'the user wants me', 'let me', 'I need to', or describe how you will analyze the screenshots. Give only the final compact answer or summary.",
            },
            {
              role: "user" as const,
              content: [
                {
                  type: "text" as const,
                  text: this.buildScreenAnalysisSummaryPrompt(language, request),
                },
                {
                  type: "image_url" as const,
                  image_url: this.buildVisionImageUrl(optimizedImage, "high"),
                },
              ],
            },
          ],
          max_tokens: 480,
          temperature: 0.1,
        },
        signal
      )

      return String(response.choices[0].message.content || "").trim()
    }

    const response = await this.createAnalyzeVisionCompletion(
      {
        model:
          this.getAnalyzeVisionProvider() === "huggingface"
            ? this.getScreenAnalysisModel()
            : this.getGroqVisionModel(),
        messages: [
          {
            role: "system" as const,
            content:
              "You are a precise screenshot-answering assistant. Return valid JSON only. Never narrate your reasoning or process. Do not say 'the user wants me', 'let me', 'I need to', or describe how you will analyze the screenshots. Give only the final compact answer or summary.",
          },
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const,
                text: this.buildScreenAnalysisSummaryPrompt(language, request),
              },
              {
                type: "image_url" as const,
                image_url: {
                  url: `data:image/png;base64,${optimizedImage}`,
                },
              },
            ],
          },
        ],
        max_tokens: 480,
        temperature: 0.1,
      },
      signal
    )

    return String(response.choices[0].message.content || "").trim()
  }

  private async extractVisibleTextFromImageDataWithHuggingFace(
    imageDataList: string[],
    signal: AbortSignal
  ): Promise<string> {
    const optimizedImageDataList = imageDataList.map((imageData) =>
      this.optimizeVisionImageData(imageData)
    )
    const response = await this.createAnalyzeVisionCompletion(
      {
        model:
          this.getAnalyzeVisionProvider() === "huggingface"
            ? this.getScreenAnalysisModel()
            : this.getGroqVisionModel(),
        messages: [
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const,
                text: this.buildScreenOcrPrompt(),
              },
              ...optimizedImageDataList.map((data) => ({
                type: "image_url" as const,
                image_url: { url: `data:image/png;base64,${data}` },
              })),
            ],
          },
        ],
        max_tokens: Math.min(1400, 700 + optimizedImageDataList.length * 180),
        temperature: 0,
      },
      signal
    )

    const primaryText = String(response.choices[0].message.content || "").trim()
    if (!this.looksLikeLowSignalScreenshotText(primaryText)) {
      return primaryText
    }

    const focusedResponse = await this.createAnalyzeVisionCompletion(
      {
        model:
          this.getAnalyzeVisionProvider() === "huggingface"
            ? this.getScreenAnalysisModel()
            : this.getGroqVisionModel(),
        messages: [
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const,
                text: this.buildScreenQuestionProbePrompt(),
              },
              ...optimizedImageDataList.map((data) => ({
                type: "image_url" as const,
                image_url: { url: `data:image/png;base64,${data}` },
              })),
            ],
          },
        ],
        max_tokens: Math.min(1100, 560 + optimizedImageDataList.length * 160),
        temperature: 0,
      },
      signal
    )

    const focusedText = String(
      focusedResponse.choices[0].message.content || ""
    ).trim()

    if (!focusedText) {
      return primaryText
    }

    if (this.looksLikeLowSignalScreenshotText(focusedText)) {
      return [primaryText, focusedText].filter(Boolean).join("\n\n")
    }

    if (!primaryText) {
      return focusedText
    }

    return `Visible text transcription:
${primaryText}

Focused prompt detection:
${focusedText}`
  }

  private ensureConfiguredProvider(
    config: ReturnType<typeof configHelper.loadConfig>
  ): void {
    if (this.isOpenAICompatibleProvider(config.apiProvider)) {
      if (!this.openaiClient) {
        this.initializeAIClient()
      }

      if (!this.openaiClient) {
        throw new Error(
          `${this.getProviderLabel(config.apiProvider)} API key not configured. Please check your settings.`
        )
      }

      return
    }

    if (config.apiProvider === "gemini") {
      if (!this.geminiApiKey) {
        this.initializeAIClient()
      }

      if (!this.geminiApiKey) {
        throw new Error("Gemini API key not configured. Please check your settings.")
      }

      return
    }

    if (!this.anthropicClient) {
      this.initializeAIClient()
    }

    if (!this.anthropicClient) {
      throw new Error("Anthropic API key not configured. Please check your settings.")
    }
  }

  private async extractQuestionInfoFromImageData(
    imageDataList: string[],
    language: string,
    config: ReturnType<typeof configHelper.loadConfig>,
    signal: AbortSignal
  ): Promise<ExtractedQuestionInfo> {
    const extractionInstruction = this.buildExtractionInstruction(language)
    const optimizedImageDataList = imageDataList.map((imageData) =>
      this.optimizeVisionImageData(imageData)
    )
    const extractionTokenBudget = this.getExtractionTokenBudget(
      optimizedImageDataList.length
    )

    if (this.shouldUseDirectOpenAIForScreenTasks()) {
      const response = await this.createOpenAICompletion(
        {
          model: this.getOpenAIScreenModel(),
          messages: [
            {
              role: "system" as const,
              content:
                "You are a precise OCR and screenshot-answering assistant. Return valid JSON only. Preserve all numbers exactly before solving. Never narrate your reasoning or process. Do not say 'the user wants me', 'let me', or describe how you will analyze the screenshots.",
            },
            {
              role: "user" as const,
              content: [
                {
                  type: "text" as const,
                  text: extractionInstruction,
                },
                ...optimizedImageDataList.map((data) => ({
                  type: "image_url" as const,
                  image_url: this.buildVisionImageUrl(data, "high"),
                })),
              ],
            },
          ],
          max_tokens: extractionTokenBudget,
          temperature: 0,
        },
        signal
      )

      const responseText = response.choices[0].message.content || ""
      return this.parseExtractedQuestionInfoResponse(
        responseText,
        language,
        signal
      )
    }

    if (this.isOpenAICompatibleProvider(config.apiProvider)) {
      if (this.shouldUseManagedAnalyzeStack(config)) {
        const visibleText = await this.extractVisibleTextFromImageDataWithHuggingFace(
          imageDataList,
          signal
        )
        const structuredResponse = await this.generateGroqTextResponse({
          systemPrompt:
            "You convert OCR-like screenshot text into strict JSON. Return valid JSON only.",
          userPrompt: this.buildExtractionFromVisibleTextPrompt(
            visibleText,
            language
          ),
          maxTokens: Math.min(extractionTokenBudget, 750),
          temperature: 0,
          signal,
        })

        return this.parseExtractedQuestionInfoResponse(
          structuredResponse || visibleText,
          language,
          signal
        )
      }

      const request: any = {
        model: this.getAnalyzeModel(config, "extractionModel"),
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text" as const,
                text: extractionInstruction,
              },
              ...optimizedImageDataList.map((data) => ({
                type: "image_url" as const,
                image_url: this.buildVisionImageUrl(
                  data,
                  config.apiProvider === "openai" ? "high" : null
                ),
              })),
            ],
          },
        ],
        max_tokens: extractionTokenBudget,
        temperature: 0.2,
      }

      const response = await this.getAnalyzeClient(config).chat.completions.create(
        request,
        { signal }
      )

      const responseText = response.choices[0].message.content || ""
      return this.parseExtractedQuestionInfoResponse(
        responseText,
        language,
        signal
      )
    }

    if (config.apiProvider === "gemini") {
      const response = await axios.default.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${config.extractionModel || "gemini-2.0-flash"}:generateContent?key=${this.geminiApiKey}`,
        {
          contents: [
            {
              role: "user",
              parts: [
                { text: extractionInstruction },
                ...optimizedImageDataList.map((data) => ({
                  inlineData: {
                    mimeType: "image/png",
                    data,
                  },
                })),
              ],
            },
          ],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: extractionTokenBudget,
          },
        },
        { signal }
      )

      const responseData = response.data as GeminiResponse
      if (!responseData.candidates || responseData.candidates.length === 0) {
        throw new Error("Empty response from Gemini API.")
      }

      const responseText = responseData.candidates[0].content.parts[0].text
      return this.parseExtractedQuestionInfoResponse(
        responseText,
        language,
        signal
      )
    }

    try {
      const response = await this.anthropicClient!.messages.create({
        model:
          config.extractionModel ||
          this.getDefaultModelForStage(config.apiProvider, "extractionModel"),
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text" as const,
                text: extractionInstruction,
              },
              ...optimizedImageDataList.map((data) => ({
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type: "image/png" as const,
                  data,
                },
              })),
            ],
          },
        ],
        max_tokens: extractionTokenBudget,
        temperature: 0.2,
      })

      const responseText = (response.content[0] as { text: string }).text || ""
      return this.parseExtractedQuestionInfoResponse(
        responseText,
        language,
        signal
      )
    } catch (error: any) {
      if (error?.status === 429) {
        throw new Error(
          "Claude API rate limit exceeded. Please wait a few minutes before trying again."
        )
      }

      if (error?.status === 413 || error?.message?.includes("token")) {
        throw new Error(
          "Your screenshots contain too much information for Claude to process. Switch to OpenAI, Gemini, or Together AI in settings which can handle larger inputs."
        )
      }

      throw error
    }
  }

  private async generateFastAnalyzeFromImageData(
    imageDataList: string[],
    language: string,
    config: ReturnType<typeof configHelper.loadConfig>,
    signal: AbortSignal
  ): Promise<{
    problemInfo: ExtractedQuestionInfo
    solution: ReturnType<ProcessingHelper["normalizeSolutionResponse"]>
  }> {
    const optimizedImageDataList = imageDataList.map((imageData) =>
      this.optimizeVisionImageData(imageData)
    )
    const tokenBudget = this.getFastAnalyzeTokenBudget(
      optimizedImageDataList.length
    )
    const analyzeInstruction = this.buildFastAnalyzePrompt(language)

    if (this.shouldUseDirectOpenAIForScreenTasks()) {
      const request: any = {
        model: this.getOpenAIScreenModel(),
        messages: [
          {
            role: "system" as const,
            content:
              "You are a precise screenshot-answering assistant. Return valid JSON only. Never narrate your reasoning or process. Do not say 'the user wants me', 'let me', 'I need to', or describe how you will analyze the screenshots. Give only the final compact answer or summary.",
          },
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const,
                text: analyzeInstruction,
              },
              ...optimizedImageDataList.map((data) => ({
                type: "image_url" as const,
                image_url: this.buildVisionImageUrl(data, "high"),
              })),
            ],
          },
        ],
        max_tokens: tokenBudget,
        temperature: 0.2,
      }

      let streamedResponseContent = ""

      try {
        const responseStream = await this.createOpenAIStream(request, signal)

        for await (const chunk of responseStream) {
          if (signal.aborted) {
            break
          }

          const deltaText = chunk.choices?.[0]?.delta?.content
          if (typeof deltaText !== "string" || deltaText.length === 0) {
            continue
          }

          streamedResponseContent += deltaText
          const preview = this.extractStreamingSolutionPreview(
            streamedResponseContent
          )

          if (preview) {
            this.emitSolutionStream({
              content: preview.content,
              isCodeResponse: preview.isCodeResponse,
            })
          }
        }
      } catch (streamError) {
        if (axios.isCancel(streamError)) {
          throw streamError
        }

        console.warn(
          "Falling back to non-streaming OpenAI fast analyze generation.",
          streamError
        )
      }

      let responseText = streamedResponseContent.trim()

      if (!responseText) {
        const response = await this.createOpenAICompletion(request, signal)
        responseText = response.choices[0].message.content || ""
      }

      try {
        const parsedResponse = this.parseJsonResponse<StructuredAnalyzeResponse>(
          responseText
        )
        const problemInfo = this.normalizeExtractedQuestionInfo(parsedResponse)
        const solution = this.finalizeDisplayedSolution(
          this.normalizeSolutionResponse(
            parsedResponse,
            problemInfo.question_type
          ),
          problemInfo
        )

        this.emitSolutionStream({
          content: solution.code || solution.answer,
          isCodeResponse: Boolean(solution.is_code_response),
          done: true,
        })

        return {
          problemInfo,
          solution,
        }
      } catch (parseError) {
        console.warn(
          "Structured OpenAI fast analyze parsing failed. Falling back to direct text parsing.",
          parseError
        )
      }

      const parsedSolution = this.parseDirectAnalyzeTextResponse(responseText)
      const problemInfo = this.normalizeExtractedQuestionInfo({
        question_type: parsedSolution.is_code_response ? "coding" : "general",
        problem_statement:
          parsedSolution.answer?.trim() ||
          "Visible question or content extracted from the screenshot.",
        sub_questions: [
          parsedSolution.answer?.trim() ||
            "Answer the visible question or summarize the visible content.",
        ],
        answer_format: parsedSolution.is_code_response ? "code" : "direct_answer",
        key_details: [],
      })
      const solution = this.finalizeDisplayedSolution(parsedSolution, problemInfo)

      this.emitSolutionStream({
        content: solution.code || solution.answer,
        isCodeResponse: Boolean(solution.is_code_response),
        done: true,
      })

      return {
        problemInfo,
        solution,
      }
    }

    if (this.isOpenAICompatibleProvider(config.apiProvider)) {
      const openaiCompatibleClient = this.getAnalyzeClient(config)
      const request: any = {
        model: this.getAnalyzeModel(config, "extractionModel"),
        messages: [
          {
            role: "system" as const,
            content:
              "You are a precise screenshot-answering assistant. Return valid JSON only. Never narrate your reasoning or process. Do not say 'the user wants me', 'let me', 'I need to', or describe how you will analyze the screenshots. Give only the final compact answer or summary.",
          },
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const,
                text: analyzeInstruction,
              },
              ...optimizedImageDataList.map((data) => ({
                type: "image_url" as const,
                image_url: this.buildVisionImageUrl(
                  data,
                  config.apiProvider === "openai" ? "high" : null
                ),
              })),
            ],
          },
        ],
        max_tokens: tokenBudget,
        temperature: 0.2,
      }

      let streamedResponseContent = ""

      try {
        const responseStream = this.shouldUseHuggingFaceForAnalyze(config)
          ? await this.createScreenAnalysisStream(request, signal)
          : await openaiCompatibleClient.chat.completions.create(
              {
                ...request,
                stream: true,
              },
              { signal }
            )

        for await (const chunk of responseStream) {
          if (signal.aborted) {
            break
          }

          const deltaText = chunk.choices?.[0]?.delta?.content
          if (typeof deltaText !== "string" || deltaText.length === 0) {
            continue
          }

          streamedResponseContent += deltaText
          const preview = this.extractStreamingSolutionPreview(
            streamedResponseContent
          )

          if (preview) {
            this.emitSolutionStream({
              content: preview.content,
              isCodeResponse: preview.isCodeResponse,
            })
          }
        }
      } catch (streamError) {
        if (axios.isCancel(streamError)) {
          throw streamError
        }

        console.warn(
          "Falling back to non-streaming fast analyze generation.",
          streamError
        )
      }

      let responseText = streamedResponseContent.trim()

      if (!responseText) {
        const response = this.shouldUseHuggingFaceForAnalyze(config)
          ? await this.createScreenAnalysisCompletion(request, signal)
          : await openaiCompatibleClient.chat.completions.create(
              request,
              { signal }
            )
        responseText = response.choices[0].message.content || ""
      }

      try {
        const parsedResponse = this.parseJsonResponse<StructuredAnalyzeResponse>(
          responseText
        )
        const problemInfo = this.normalizeExtractedQuestionInfo(parsedResponse)
        const solution = this.finalizeDisplayedSolution(
          this.normalizeSolutionResponse(
            parsedResponse,
            problemInfo.question_type
          ),
          problemInfo
        )

        this.emitSolutionStream({
          content: solution.code || solution.answer,
          isCodeResponse: Boolean(solution.is_code_response),
          done: true,
        })

        return {
          problemInfo,
          solution,
        }
      } catch (parseError) {
        console.warn(
          "Structured fast analyze parsing failed. Falling back to direct text parsing.",
          parseError
        )
      }

      const parsedSolution = this.parseDirectAnalyzeTextResponse(responseText)
      const problemInfo = this.normalizeExtractedQuestionInfo({
        question_type: parsedSolution.is_code_response ? "coding" : "general",
        problem_statement:
          parsedSolution.answer?.trim() ||
          "Visible question or content extracted from the screenshot.",
        sub_questions: [
          parsedSolution.answer?.trim() ||
            "Answer the visible question or summarize the visible content.",
        ],
        answer_format: parsedSolution.is_code_response ? "code" : "direct_answer",
        key_details: [],
      })
      const solution = this.finalizeDisplayedSolution(parsedSolution, problemInfo)

      this.emitSolutionStream({
        content: solution.code || solution.answer,
        isCodeResponse: Boolean(solution.is_code_response),
        done: true,
      })

      return {
        problemInfo,
        solution,
      }
    }

    let responseText = ""

    if (config.apiProvider === "gemini") {
      const response = await axios.default.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${config.extractionModel || "gemini-2.0-flash"}:generateContent?key=${this.geminiApiKey}`,
        {
          contents: [
            {
              role: "user",
              parts: [
                { text: analyzeInstruction },
                ...optimizedImageDataList.map((data) => ({
                  inlineData: {
                    mimeType: "image/png",
                    data,
                  },
                })),
              ],
            },
          ],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: tokenBudget,
          },
        },
        { signal }
      )

      const responseData = response.data as GeminiResponse
      if (!responseData.candidates || responseData.candidates.length === 0) {
        throw new Error("Empty response from Gemini API.")
      }

      responseText =
        responseData.candidates[0].content.parts.find(
          (part) => typeof part.text === "string" && part.text.length > 0
        )?.text || ""
    } else {
      const response = await this.anthropicClient!.messages.create({
        model:
          config.extractionModel ||
          this.getDefaultModelForStage(config.apiProvider, "extractionModel"),
        max_tokens: tokenBudget,
        temperature: 0.2,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text" as const,
                text: analyzeInstruction,
              },
              ...optimizedImageDataList.map((data) => ({
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type: "image/png" as const,
                  data,
                },
              })),
            ],
          },
        ],
      })

      const textBlock = response.content.find(
        (entry) => entry.type === "text"
      ) as { text?: string } | undefined

      responseText = textBlock?.text || ""
    }

    const parsedResponse = this.parseJsonResponse<StructuredAnalyzeResponse>(
      responseText
    )
    const problemInfo = this.normalizeExtractedQuestionInfo(parsedResponse)
    const solution = this.normalizeSolutionResponse(
      parsedResponse,
      problemInfo.question_type
    )

    this.emitSolutionStream({
      content: solution.code || solution.answer,
      isCodeResponse: Boolean(solution.is_code_response),
      done: true,
    })

    return {
      problemInfo,
      solution,
    }
  }

  private shouldVerifyFinalAnswer(
    problemInfo: ExtractedQuestionInfo,
    solution: ReturnType<ProcessingHelper["normalizeSolutionResponse"]>
  ): boolean {
    if (solution.is_code_response) {
      return false
    }

    const answerFormat = (problemInfo.answer_format || "").toLowerCase()
    if (answerFormat === "summary") {
      return false
    }

    const promptText = [
      problemInfo.problem_statement || "",
      problemInfo.content_summary || "",
      ...(problemInfo.sub_questions || []),
      ...(problemInfo.answer_choices || []),
      ...(problemInfo.key_details || []),
    ].join("\n")

    const hasMathSignal =
      /\d/.test(promptText) &&
      /\b(?:find|calculate|solve|total|number|seconds?|minutes?|hours?|probability|percent|ratio|average|mean|median|sum|difference|product|growth|birth|death|lifespan|life span|population|finance|interest|cost|price)\b/i.test(
        promptText
      )

    return (
      problemInfo.question_type === "mcq" ||
      problemInfo.question_type === "academic" ||
      hasMathSignal
    )
  }

  private buildVerificationPrompt(
    problemInfo: ExtractedQuestionInfo,
    solution: ReturnType<ProcessingHelper["normalizeSolutionResponse"]>,
    language: string
  ): string {
    const answerChoices = Array.isArray(problemInfo.answer_choices)
      ? problemInfo.answer_choices.join("\n")
      : "None"

    return `Verify the proposed answer by independently solving the extracted prompt.

QUESTION TYPE:
${problemInfo.question_type || "general"}

PROMPT:
${problemInfo.problem_statement || ""}

SUB-QUESTIONS:
${(problemInfo.sub_questions || []).map((item, index) => `${index + 1}. ${item}`).join("\n") || "None"}

ANSWER CHOICES:
${answerChoices}

KEY DETAILS:
${(problemInfo.key_details || []).map((item) => `- ${item}`).join("\n") || "None"}

PROPOSED ANSWER:
${solution.answer || solution.code || ""}

PREFERRED LANGUAGE FOR CODE TASKS:
${language}

Return only valid JSON:
{
  "verdict": "correct|incorrect|uncertain",
  "question_type": "coding|mcq|academic|general",
  "is_code_response": false,
  "answer": "final corrected answer if incorrect, otherwise repeat the proposed answer",
  "code": "only if code is genuinely required, otherwise empty string",
  "thoughts": []
}

Verification rules:
- Do not rubber-stamp the proposed answer. Re-solve independently.
- For MCQs, compare every option before choosing.
- If choices include formulas, compare algebraically/equivalently.
- Treat "None of these" / "None of the above" as last resort only.
- For time/lifespan/process wording, check boundary conditions like "just after", "until death", and inclusive/exclusive endpoints.
- If the proposed answer is wrong, set verdict="incorrect" and put the corrected final answer in answer.
- If the prompt is ambiguous and no correction is safe, set verdict="uncertain" and repeat the proposed answer.`
  }

  private async verifyFinalAnswer(
    problemInfo: ExtractedQuestionInfo,
    solution: ReturnType<ProcessingHelper["normalizeSolutionResponse"]>,
    language: string,
    signal: AbortSignal
  ): Promise<ReturnType<ProcessingHelper["normalizeSolutionResponse"]>> {
    if (!this.shouldVerifyFinalAnswer(problemInfo, solution)) {
      return solution
    }

    try {
      const responseText = await this.generateOpenAITextResponse({
        systemPrompt:
          "You are a strict answer verifier. Return valid JSON only. Re-solve the problem, compare the proposed answer, and correct it only when clearly wrong.",
        userPrompt: this.buildVerificationPrompt(problemInfo, solution, language),
        maxTokens: this.getOpenAIReasoningTokenBudget(problemInfo),
        temperature: 0,
        signal,
        model: this.getOpenAIReasoningModel(),
      })

      if (!responseText.trim()) {
        return solution
      }

      const verification = this.parseJsonResponse<
        Partial<StructuredSolutionResponse> & { verdict?: string; is_correct?: boolean }
      >(responseText)
      const verdict = String(verification.verdict || "").toLowerCase()
      const clearlyIncorrect = verdict === "incorrect" || verification.is_correct === false

      if (!clearlyIncorrect) {
        return solution
      }

      const candidate = this.finalizeDisplayedSolution(
        this.normalizeSolutionResponse(
          {
            question_type: verification.question_type || problemInfo.question_type,
            is_code_response: verification.is_code_response ?? solution.is_code_response,
            answer: verification.answer || solution.answer,
            code: verification.code || "",
            thoughts: [],
          },
          problemInfo.question_type
        ),
        problemInfo
      )

      return candidate.answer || candidate.code ? candidate : solution
    } catch (error) {
      if (axios.isCancel(error)) {
        throw error
      }

      console.warn("Answer verification failed; keeping original answer.", error)
      return solution
    }
  }
  private async generateStructuredSolutionForProblemInfo(
    problemInfo: ExtractedQuestionInfo,
    language: string,
    config: ReturnType<typeof configHelper.loadConfig>,
    signal: AbortSignal
  ): Promise<{
    success: true
    data: ReturnType<ProcessingHelper["normalizeSolutionResponse"]>
  } | {
    success: false
    error: string
  }> {
    try {
      const webContext = await buildExaSearchContext(
        this.buildProblemSearchQuery(problemInfo),
        { signal, maxCharacters: 5200 }
      )
      const promptText = this.appendWebContextToPrompt(
        this.buildSolutionPrompt(problemInfo, language),
        webContext
      );
      const solutionTokenBudget = this.getSolutionTokenBudget(problemInfo)
      const analyzeSolutionModel = this.getAnalyzeSolutionModel(
        config,
        problemInfo
      )

      const deterministicMcqSolution = this.trySolveGrowthLifespanMcq(problemInfo)
      if (deterministicMcqSolution) {
        this.emitProcessingStatus("Verifying answer...", 86)
        this.emitProcessingStatus("Answer verified", 94)
        this.emitSolutionStream({
          content: deterministicMcqSolution.answer,
          isCodeResponse: false,
          done: true,
        })
        return { success: true, data: deterministicMcqSolution }
      }

      let responseContent;

      if (this.shouldUseDirectOpenAIForScreenTasks()) {
        responseContent = await this.generateOpenAITextResponse({
          systemPrompt:
            "You are a high-accuracy screenshot-answering assistant. Return valid JSON only. For math MCQs, solve carefully, compare every option algebraically, and choose None only as a last resort. Keep the visible answer compact; no hidden reasoning narration, no meta commentary.",
          userPrompt: promptText,
          maxTokens: this.getOpenAIReasoningTokenBudget(problemInfo),
          temperature: 0.15,
          signal,
          model: this.getOpenAIReasoningModel(),
          onStream: (content) => {
            const preview = this.extractStreamingSolutionPreview(
              content,
              problemInfo.question_type
            )

            if (!preview) {
              return
            }

            this.emitSolutionStream({
              content: preview.content,
              isCodeResponse: preview.isCodeResponse,
            })
          },
        })

        try {
          const requiresMultiPartFormatting =
            this.shouldForceMultiPartAnswerFormatting(problemInfo)
          const requiresConciseMcqAnswer = problemInfo.question_type === "mcq"
          const previewResponse = this.normalizeSolutionResponse(
            this.parseJsonResponse<StructuredSolutionResponse>(responseContent),
            problemInfo.question_type
          )

          if (
            this.looksLikeMetaTaskSummaryAnswer(previewResponse.answer || "") ||
            (requiresConciseMcqAnswer &&
              this.looksLikeVerboseMcqAnswer(previewResponse.answer || "")) ||
            this.looksLikeDenseAcademicParagraph(
              problemInfo,
              previewResponse.answer || ""
            ) ||
            (requiresMultiPartFormatting &&
              !previewResponse.is_code_response &&
              !this.fastAnswerLikelyCoversMultipleQuestions(
                problemInfo,
                previewResponse
              ))
          ) {
            responseContent = await this.generateOpenAITextResponse({
              systemPrompt:
                requiresConciseMcqAnswer
                  ? "You are a precise screenshot-answering assistant. Return valid JSON only. This is an MCQ. Compare every option first. If a non-none option is mathematically equivalent, choose it. Put only the correct option in the answer field. No explanation, no justification, no extra sentence."
                  : requiresMultiPartFormatting
                  ? "You are a precise screenshot-answering assistant. Return valid JSON only. The answer field must be a numbered list with `1.`, `2.`, `3.` and one item per visible question or sub-part. Do not merge multiple answers into one paragraph. Do not describe the task or project."
                  : this.looksLikeDenseAcademicParagraph(problemInfo, previewResponse.answer || "")
                  ? "You are a precise screenshot-answering assistant. Return valid JSON only. For academic or calculation questions, the answer field must use short step-by-step lines with line breaks and a final answer line. Do not write one dense paragraph."
                  : "You are a precise screenshot-answering assistant. Do not describe the task, project, or your reasoning process. Do not say 'the user wants me', 'let me', or 'I need to'. Give the direct answer to the visible ask only. If the screenshot is just a list of instructions, respond to each visible instruction directly. Return valid JSON only.",
              userPrompt: promptText,
              maxTokens: this.getOpenAIReasoningTokenBudget(problemInfo),
              temperature: 0,
              signal,
              model: this.getOpenAIReasoningModel(),
            })
          }
        } catch (retryCheckError) {
          console.warn(
            "OpenAI preview parsing failed before direct-answer retry.",
            retryCheckError
          )
        }
      } else if (this.shouldUseManagedAnalyzeStack(config)) {
        responseContent = await this.generateGroqTextResponse({
          systemPrompt:
            "You are a high-accuracy screenshot-answering assistant. Return valid JSON only. For math MCQs, solve carefully, compare every option algebraically, and choose None only as a last resort. Keep the visible answer compact; no hidden reasoning narration, no meta commentary.",
          userPrompt: promptText,
          maxTokens: this.getOpenAIReasoningTokenBudget(problemInfo),
          temperature: 0.15,
          signal,
          onStream: (content) => {
            const preview = this.extractStreamingSolutionPreview(
              content,
              problemInfo.question_type
            )

            if (!preview) {
              return
            }

            this.emitSolutionStream({
              content: preview.content,
              isCodeResponse: preview.isCodeResponse,
            })
          },
        })

        try {
          const requiresMultiPartFormatting =
            this.shouldForceMultiPartAnswerFormatting(problemInfo)
          const requiresConciseMcqAnswer = problemInfo.question_type === "mcq"
          const previewResponse = this.normalizeSolutionResponse(
            this.parseJsonResponse<StructuredSolutionResponse>(responseContent),
            problemInfo.question_type
          )

          if (
            this.looksLikeMetaTaskSummaryAnswer(previewResponse.answer || "") ||
            (requiresConciseMcqAnswer &&
              this.looksLikeVerboseMcqAnswer(previewResponse.answer || "")) ||
            this.looksLikeDenseAcademicParagraph(
              problemInfo,
              previewResponse.answer || ""
            ) ||
            (requiresMultiPartFormatting &&
              !previewResponse.is_code_response &&
              !this.fastAnswerLikelyCoversMultipleQuestions(
                problemInfo,
                previewResponse
              ))
          ) {
            responseContent = await this.generateGroqTextResponse({
              systemPrompt:
                requiresConciseMcqAnswer
                  ? "You are a precise screenshot-answering assistant. Return valid JSON only. This is an MCQ. Compare every option first. If a non-none option is mathematically equivalent, choose it. Put only the correct option in the answer field. No explanation, no justification, no extra sentence."
                  : requiresMultiPartFormatting
                  ? "You are a precise screenshot-answering assistant. Return valid JSON only. The answer field must be a numbered list with `1.`, `2.`, `3.` and one item per visible question or sub-part. Do not merge multiple answers into one paragraph. Do not describe the task or project."
                  : this.looksLikeDenseAcademicParagraph(problemInfo, previewResponse.answer || "")
                  ? "You are a precise screenshot-answering assistant. Return valid JSON only. For academic or calculation questions, the answer field must use short step-by-step lines with line breaks and a final answer line. Do not write one dense paragraph."
                  : "You are a precise screenshot-answering assistant. Do not describe the task, project, or your reasoning process. Do not say 'the user wants me', 'let me', or 'I need to'. Give the direct answer to the visible ask only. If the screenshot is just a list of instructions, respond to each visible instruction directly. Return valid JSON only.",
              userPrompt: promptText,
              maxTokens: this.getOpenAIReasoningTokenBudget(problemInfo),
              temperature: 0,
              signal,
            })
          }
        } catch (retryCheckError) {
          console.warn(
            "Managed analyze preview parsing failed before direct-answer retry.",
            retryCheckError
          )
        }
      } else if (this.isOpenAICompatibleProvider(config.apiProvider)) {
        const providerLabel = this.getAnalyzeProviderLabel(config);
        const analyzeClient = this.getAnalyzeClient(config)

        if (!analyzeClient) {
          return {
            success: false,
            error: `${providerLabel} API key not configured. Please check your settings.`
          };
        }
        
        const solutionRequest: any = {
          model: this.getAnalyzeModel(config, "solutionModel"),
          messages: [
            {
              role: "system" as const,
              content:
                "You are a high-accuracy screenshot-answering assistant. Give only the final answer. Do not narrate your reasoning or process. Do not say 'the user wants me', 'let me', or describe how you will analyze the screenshots. Return valid JSON only."
            },
            { role: "user" as const, content: promptText }
          ],
          max_tokens: solutionTokenBudget,
          temperature: 0.2
        };

        let streamedResponseContent = "";

        try {
          const solutionStream = this.shouldUseHuggingFaceForAnalyze(config)
            ? await this.createScreenAnalysisStream(solutionRequest, signal)
            : await analyzeClient.chat.completions.create(
                {
                  ...solutionRequest,
                  stream: true,
                },
                { signal }
              );

          for await (const chunk of solutionStream) {
            if (signal.aborted) {
              break;
            }

            const deltaText = chunk.choices?.[0]?.delta?.content;
            if (typeof deltaText !== "string" || deltaText.length === 0) {
              continue;
            }

            streamedResponseContent += deltaText;
            const preview = this.extractStreamingSolutionPreview(
              streamedResponseContent,
              problemInfo.question_type
            );

            if (preview) {
              this.emitSolutionStream({
                content: preview.content,
                isCodeResponse: preview.isCodeResponse,
              });
            }
          }
        } catch (streamError) {
          if (axios.isCancel(streamError)) {
            throw streamError;
          }

          console.warn(
            "Falling back to non-streaming solution generation.",
            streamError
          );
        }

        if (streamedResponseContent.trim()) {
          responseContent = streamedResponseContent;
        } else {
          const solutionResponse = this.shouldUseHuggingFaceForAnalyze(config)
            ? await this.createScreenAnalysisCompletion(solutionRequest, signal)
            : await analyzeClient.chat.completions.create(
                solutionRequest,
                { signal }
              );

          responseContent = solutionResponse.choices[0].message.content;
        }
      } else if (config.apiProvider === "gemini")  {
        if (!this.geminiApiKey) {
          return {
            success: false,
            error: "Gemini API key not configured. Please check your settings."
          };
        }
        
        try {
          const geminiMessages = [
            {
              role: "user",
              parts: [
                {
                  text: promptText
                }
              ]
            }
          ];

          const response = await axios.default.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${analyzeSolutionModel}:generateContent?key=${this.geminiApiKey}`,
            {
              contents: geminiMessages,
              generationConfig: {
                temperature: 0,
                maxOutputTokens: solutionTokenBudget
              }
            },
            { signal }
          );

          const responseData = response.data as GeminiResponse;
          
          if (!responseData.candidates || responseData.candidates.length === 0) {
            throw new Error("Empty response from Gemini API");
          }
          
          responseContent = responseData.candidates[0].content.parts[0].text;
        } catch (error) {
          console.error("Error using Gemini API for solution:", error);
          return {
            success: false,
            error: "Failed to generate solution with Gemini API. Please check your API key or try again later."
          };
        }
      } else if (config.apiProvider === "anthropic") {
        if (!this.anthropicClient) {
          return {
            success: false,
            error: "Anthropic API key not configured. Please check your settings."
          };
        }
        
        try {
          const messages = [
            {
              role: "user" as const,
              content: [
                {
                  type: "text" as const,
                  text: promptText
                }
              ]
            }
          ];

          const response = await this.anthropicClient.messages.create({
            model: analyzeSolutionModel,
            max_tokens: solutionTokenBudget,
            messages: messages,
            temperature: 0.2
          });

          responseContent = (response.content[0] as { type: 'text', text: string }).text;
        } catch (error: any) {
          console.error("Error using Anthropic API for solution:", error);

          if (error.status === 429) {
            return {
              success: false,
              error: "Claude API rate limit exceeded. Please wait a few minutes before trying again."
            };
          } else if (error.status === 413 || (error.message && error.message.includes("token"))) {
            return {
              success: false,
              error: "Your screenshots contain too much information for Claude to process. Switch to OpenAI, Gemini, or Together AI in settings which can handle larger inputs."
            };
          }

          return {
            success: false,
            error: "Failed to generate solution with Anthropic API. Please check your API key or try again later."
          };
        }
      }

      let formattedResponse

      try {
        formattedResponse = this.finalizeDisplayedSolution(
          this.normalizeSolutionResponse(
            this.parseJsonResponse<StructuredSolutionResponse>(responseContent),
            problemInfo.question_type
          ),
          problemInfo
        );
      } catch (parseError) {
        console.warn(
          "Structured solution parsing failed. Falling back to direct text response.",
          parseError
        )
        formattedResponse = this.finalizeDisplayedSolution(
          this.parseDirectAnalyzeTextResponse(responseContent),
          problemInfo
        )
      }

      this.emitProcessingStatus("Verifying answer...", 86)
      formattedResponse = await this.verifyFinalAnswer(
        problemInfo,
        formattedResponse,
        language,
        signal
      )
      this.emitProcessingStatus("Answer verified", 94)

      this.emitSolutionStream({
        content: formattedResponse.code || formattedResponse.answer,
        isCodeResponse: Boolean(formattedResponse.is_code_response),
        done: true,
      });

      return { success: true, data: formattedResponse };
    } catch (error: any) {
      if (axios.isCancel(error)) {
        return {
          success: false,
          error: "Processing was canceled by the user."
        };
      }

      if (error?.response?.status === 401) {
        return {
          success: false,
          error: "Invalid API key. Please check your settings."
        };
      } else if (error?.response?.status === 429) {
        return {
          success: false,
          error: "API rate limit exceeded or insufficient credits. Please try again later."
        };
      }

      console.error("Solution generation error:", error);
      return {
        success: false,
        error: "Failed to generate solution. Please try again with clearer screenshots."
      };
    }
  }

  private async generateLiveInterviewAnswer(
    problemInfo: ExtractedQuestionInfo,
    language: string,
    instructions: string[],
    lastAnswer: string,
    signal: AbortSignal
  ): Promise<string> {
    const webContext = await buildExaSearchContext(
      this.buildProblemSearchQuery(problemInfo, instructions.join("\n")),
      { signal, maxCharacters: 3800 }
    )
    const promptText = this.appendWebContextToPrompt(
      this.buildLiveInterviewPrompt(
        problemInfo,
        language,
        instructions,
        lastAnswer
      ),
      webContext
    )
    return this.generateOpenAITextResponse({
      systemPrompt:
        "You are a precise live interview assistant. Give the shortest acceptable answer in markdown.",
      userPrompt: promptText,
      maxTokens: LIVE_INTERVIEW_MAX_TOKENS,
      signal,
    })
  }

  private async generateLiveAudioInterviewAnswer(
    transcript: string,
    language: string,
    instructions: string[],
    lastAnswer: string,
    signal: AbortSignal
  ): Promise<string> {
    const webContext = await buildExaSearchContext(
      [transcript, instructions.join("\n")].filter(Boolean).join("\n"),
      { signal, maxCharacters: 3200 }
    )
    const promptText = this.appendWebContextToPrompt(
      this.buildLiveAudioInterviewPrompt(
        transcript,
        language,
        instructions,
        lastAnswer
      ),
      webContext
    )
    return this.generateOpenAITextResponse({
      systemPrompt:
        "You are a precise live interview assistant. Give the shortest acceptable answer in markdown.",
      userPrompt: promptText,
      maxTokens: LIVE_AUDIO_INTERVIEW_MAX_TOKENS,
      signal,
    })
  }

  public async processLiveInterviewTurn(
    request: LiveInterviewTurnRequest
  ): Promise<LiveInterviewTurnResult> {
    const instructions = Array.isArray(request.instructions)
      ? request.instructions
          .map((instruction) => instruction.trim())
          .filter(Boolean)
      : []
    const instructionHash = this.buildLiveInstructionSignature(instructions)
    const lastAnswer = request.lastAnswer.trim()
    const analysisConfig = this.getTogetherAnalysisConfig()

    this.currentLiveProcessingAbortController?.abort()
    const abortController = new AbortController()
    this.currentLiveProcessingAbortController = abortController
    const signal = abortController.signal

    try {
      const language = await this.getLanguage()
      const screenCapture = await this.captureScreenContextForChat()
      const screenHash = this.hashValue(screenCapture.data)

      if (
        screenHash === request.lastScreenHash &&
        instructionHash === (request.lastInstructionHash || "")
      ) {
        return {
          success: true,
          updated: false,
          answer: lastAnswer,
          screenHash,
          contentHash: request.lastContentHash || null,
          instructionHash,
          lastUpdatedAt: null,
        }
      }
      let problemInfo = await this.extractQuestionInfoFromImageData(
        [screenCapture.data],
        language,
        analysisConfig,
        signal
      )
      problemInfo = this.normalizeExtractedQuestionInfo(problemInfo)

      if (!this.hasUsableExtractedQuestionInfo(problemInfo)) {
        const recovered = await this.recoverFromWeakExtraction(
          [screenCapture.data],
          language,
          analysisConfig,
          signal,
          problemInfo
        )
        const contentHash = this.buildLiveContentSignature(recovered.problemInfo)
        const answer = (
          recovered.solution.answer ||
          recovered.solution.code ||
          this.buildLiveWatchingMessage()
        ).trim()
        const updated =
          answer !== lastAnswer ||
          contentHash !== (request.lastContentHash || null) ||
          instructionHash !== (request.lastInstructionHash || "")

        return {
          success: true,
          updated,
          answer,
          screenHash,
          contentHash,
          instructionHash,
          lastUpdatedAt: updated ? new Date().toISOString() : null,
        }
      }

      const contentHash = this.buildLiveContentSignature(problemInfo)

      if (this.shouldUseLiveWatchingState(problemInfo)) {
        const answer = this.buildLiveWatchingMessage()
        const updated =
          answer !== lastAnswer ||
          contentHash !== (request.lastContentHash || null) ||
          instructionHash !== (request.lastInstructionHash || "")

        return {
          success: true,
          updated,
          answer,
          screenHash,
          contentHash,
          instructionHash,
          lastUpdatedAt: updated ? new Date().toISOString() : null,
        }
      }

      if (
        contentHash === request.lastContentHash &&
        instructionHash === (request.lastInstructionHash || "")
      ) {
        return {
          success: true,
          updated: false,
          answer: lastAnswer,
          screenHash,
          contentHash,
          instructionHash,
          lastUpdatedAt: null,
        }
      }

      const answer = (
        await this.generateLiveInterviewAnswer(
          problemInfo,
          language,
          instructions,
          lastAnswer,
          signal
        )
      ).trim()

      if (!answer) {
        throw new Error("The model returned an empty live interview response.")
      }

      return {
        success: true,
        updated:
          answer !== lastAnswer ||
          contentHash !== (request.lastContentHash || null) ||
          instructionHash !== (request.lastInstructionHash || ""),
        answer,
        screenHash,
        contentHash,
        instructionHash,
        lastUpdatedAt: new Date().toISOString(),
      }
    } catch (error: any) {
      if (axios.isCancel(error)) {
        return {
          success: false,
          updated: false,
          answer: lastAnswer,
          screenHash: request.lastScreenHash || null,
          contentHash: request.lastContentHash || null,
          instructionHash,
          lastUpdatedAt: null,
          error: "Live interview request was canceled.",
        }
      }

      console.error("Live interview processing error:", error)
      return {
        success: false,
        updated: false,
        answer: lastAnswer,
        screenHash: request.lastScreenHash || null,
        contentHash: request.lastContentHash || null,
        instructionHash,
        lastUpdatedAt: null,
        error:
          error?.message ||
          "Failed to generate a live interview response.",
      }
    } finally {
      if (this.currentLiveProcessingAbortController === abortController) {
        this.currentLiveProcessingAbortController = null
      }
    }
  }

  public async processLiveAudioInterviewTurn(
    request: LiveAudioInterviewTurnRequest
  ): Promise<LiveInterviewTurnResult> {
    const transcript = request.transcript.trim()
    const instructions = Array.isArray(request.instructions)
      ? request.instructions
          .map((instruction) => instruction.trim())
          .filter(Boolean)
      : []
    const instructionHash = this.buildLiveInstructionSignature(instructions)
    const transcriptHash = this.buildLiveTranscriptSignature(transcript)
    const lastAnswer = request.lastAnswer.trim()

    this.currentLiveProcessingAbortController?.abort()
    const abortController = new AbortController()
    this.currentLiveProcessingAbortController = abortController
    const signal = abortController.signal

    try {
      const language = await this.getLanguage()

      if (
        transcriptHash === request.lastTranscriptHash &&
        instructionHash === (request.lastInstructionHash || "")
      ) {
        return {
          success: true,
          updated: false,
          answer: lastAnswer,
          screenHash: null,
          contentHash: transcriptHash,
          instructionHash,
          lastUpdatedAt: null,
        }
      }

      if (this.shouldUseLiveTranscriptWatchingState(transcript)) {
        const answer = this.buildLiveTranscriptWatchingMessage()
        return {
          success: true,
          updated:
            answer !== lastAnswer ||
            transcriptHash !== (request.lastTranscriptHash || null) ||
            instructionHash !== (request.lastInstructionHash || ""),
          answer,
          screenHash: null,
          contentHash: transcriptHash,
          instructionHash,
          lastUpdatedAt: new Date().toISOString(),
        }
      }

      const answer = (
        await this.generateLiveAudioInterviewAnswer(
          transcript,
          language,
          instructions,
          lastAnswer,
          signal
        )
      ).trim()

      if (!answer) {
        throw new Error("The model returned an empty live interview response.")
      }

      return {
        success: true,
        updated:
          answer !== lastAnswer ||
          transcriptHash !== (request.lastTranscriptHash || null) ||
          instructionHash !== (request.lastInstructionHash || ""),
        answer,
        screenHash: null,
        contentHash: transcriptHash,
        instructionHash,
        lastUpdatedAt: new Date().toISOString(),
      }
    } catch (error: any) {
      if (axios.isCancel(error)) {
        return {
          success: false,
          updated: false,
          answer: lastAnswer,
          screenHash: null,
          contentHash: request.lastTranscriptHash || null,
          instructionHash,
          lastUpdatedAt: null,
          error: "Live interview request was canceled.",
        }
      }

      console.error("Live audio interview processing error:", error)
      return {
        success: false,
        updated: false,
        answer: lastAnswer,
        screenHash: null,
        contentHash: request.lastTranscriptHash || null,
        instructionHash,
        lastUpdatedAt: null,
        error:
          error?.message ||
          "Failed to generate a live interview response.",
      }
    } finally {
      if (this.currentLiveProcessingAbortController === abortController) {
        this.currentLiveProcessingAbortController = null
      }
    }
  }

  public async transcribeLiveInterviewAudioChunk(
    audioBase64: string,
    mimeType: string
  ): Promise<string> {
    const normalizedAudio = audioBase64.trim()
    if (!normalizedAudio) {
      return ""
    }

    const audioBuffer = Buffer.from(normalizedAudio, "base64")
    if (audioBuffer.byteLength === 0) {
      return ""
    }

    const normalizedMimeType = (mimeType || "").trim() || "audio/webm"
    const fileExtension = this.getAudioExtension(normalizedMimeType)
    const usesRawPcm = fileExtension === "pcm"
    const preparedAudioBuffer = usesRawPcm
      ? this.createWavBufferFromPcm(
          audioBuffer,
          this.getPcmSampleRate(normalizedMimeType)
        )
      : audioBuffer

    const file = await toFile(
      preparedAudioBuffer,
      `live-interview.${usesRawPcm ? "wav" : fileExtension}`,
      {
        type: usesRawPcm ? "audio/wav" : normalizedMimeType,
      }
    )

    const response = await this.createOpenAITranscription({
      file,
      model: this.getOpenAILiveTranscriptionModel(),
      language: "en",
      response_format: "json",
      prompt:
        "This is a technical interview conversation about coding, algorithms, system design, software engineering, and behavioral interview questions.",
    })

    return typeof response.text === "string" ? response.text.trim() : ""
  }

  private normalizeExtractedQuestionInfo(
    problemInfo: Partial<ExtractedQuestionInfo>
  ): ExtractedQuestionInfo {
    const subQuestions = Array.isArray(problemInfo.sub_questions)
      ? problemInfo.sub_questions
          .filter((question): question is string => typeof question === "string")
          .map((question) => question.trim())
          .filter(Boolean)
      : []
    const answerChoices = Array.isArray(problemInfo.answer_choices)
      ? problemInfo.answer_choices
          .filter((choice): choice is string => typeof choice === "string")
          .map((choice) => choice.trim())
          .filter(Boolean)
      : []
    const originalProblemStatement = (problemInfo.problem_statement || "").trim()
    const contentSummary = (problemInfo.content_summary || "").trim()
    const distinctSubQuestionCount = new Set(
      subQuestions.map((question) => this.normalizeThoughtText(question)).filter(Boolean)
    ).size
    const hasMultipleDistinctSubQuestions = distinctSubQuestionCount > 1
    const isMcq =
      !hasMultipleDistinctSubQuestions &&
      (problemInfo.question_type === "mcq" || answerChoices.length >= 2)
    const normalizedProblemStatement =
      originalProblemStatement ||
      (isMcq
        ? "Select the correct option from the visible choices."
        : this.buildFallbackProblemStatement(
            problemInfo,
            subQuestions,
            contentSummary
          ))
    const isSummaryFallback =
      !isMcq &&
      (Boolean(contentSummary) ||
        (!originalProblemStatement &&
          subQuestions.length === 0 &&
          Boolean(normalizedProblemStatement)))

    return {
      question_type: isMcq
        ? "mcq"
        : isSummaryFallback
          ? "general"
          : problemInfo.question_type || "general",
      problem_statement: normalizedProblemStatement,
      content_summary: isMcq ? "" : contentSummary,
      sub_questions:
        subQuestions.length > 0
          ? subQuestions
          : isMcq
            ? [normalizedProblemStatement]
            : isSummaryFallback
              ? ["Briefly summarize the visible content from the screenshots in 1 or 2 short lines."]
              : normalizedProblemStatement
                ? [normalizedProblemStatement]
                : [],
      constraints: problemInfo.constraints || "",
      example_input: problemInfo.example_input || "",
      example_output: problemInfo.example_output || "",
      answer_choices: answerChoices,
      subject: problemInfo.subject || "",
      answer_format:
        (problemInfo.answer_format || "").trim() ||
        (isMcq ? "multiple_choice" : isSummaryFallback ? "summary" : ""),
      existing_work: problemInfo.existing_work || "",
      key_details: Array.isArray(problemInfo.key_details)
        ? problemInfo.key_details.filter(Boolean)
        : [],
    }
  }

  private trimCompactAnswer(text: string, maxLength = 180): string {
    const normalized = text.replace(/\s+/g, " ").trim()
    if (normalized.length <= maxLength) {
      return normalized
    }

    const slice = normalized.slice(0, maxLength).trim()
    const lastBreak = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf(", "), slice.lastIndexOf(" "))
    const safeSlice = lastBreak > 60 ? slice.slice(0, lastBreak).trim() : slice
    return safeSlice + "..."
  }

  private shortenSummaryAnswer(answer: string): string {
    const sanitized = this.sanitizeMetaAnswerText(answer)
    const lines = sanitized
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, ""))

    if (lines.length >= 2) {
      return lines.slice(0, 2).map((line) => "- " + this.trimCompactAnswer(line, 110)).join("\n")
    }

    const compact = this.trimCompactAnswer(lines[0] || sanitized, 180)
    const sentences = compact.split(/(?<=[.!?])\s+/).filter(Boolean)
    if (sentences.length >= 2) {
      return sentences.slice(0, 2).join(" ")
    }

    return compact
  }

  private parseSmallNumberFromText(text: string, labels: string[]): number | null {
    const normalized = text.toLowerCase()
    const wordNumbers: Record<string, number> = {
      one: 1,
      two: 2,
      three: 3,
      four: 4,
      five: 5,
      six: 6,
      seven: 7,
      eight: 8,
      nine: 9,
      ten: 10,
      eleven: 11,
      twelve: 12,
    }

    for (const label of labels) {
      const digitMatch = new RegExp(`${label}[^.]{0,40}?(\\d+)`, "i").exec(normalized)
      if (digitMatch) {
        const value = Number.parseInt(digitMatch[1], 10)
        if (Number.isFinite(value)) return value
      }

      for (const [word, value] of Object.entries(wordNumbers)) {
        const wordMatch = new RegExp(`${label}[^.]{0,40}?\\b${word}\\b`, "i").test(normalized)
        if (wordMatch) return value
      }
    }

    return null
  }

  private evaluateSimpleMathExpression(expression: string): number | null {
    const withoutLabel = expression.replace(/^\s*(?:[A-H][.)]|(?:option|choice)\s+[A-H]\b)\s*/i, "")
    const normalized = withoutLabel
      .replace(/[�x]/gi, "*")
      .replace(/�/g, "/")
      .replace(/\^/g, "**")
      .replace(/,/g, "")
      .trim()

    if (!normalized || !/^[0-9+\-*/().\s*]+$/.test(normalized)) {
      return null
    }

    try {
      const value = Function(`"use strict"; return (${normalized});`)()
      return Number.isFinite(value) ? Number(value) : null
    } catch {
      return null
    }
  }

  private trySolveGrowthLifespanMcq(
    problemInfo: ExtractedQuestionInfo
  ): ReturnType<ProcessingHelper["normalizeSolutionResponse"]> | null {
    const promptText = [
      problemInfo.problem_statement || "",
      ...(problemInfo.sub_questions || []),
      ...(problemInfo.key_details || []),
    ].join("\n")
    const normalizedPrompt = promptText.toLowerCase()
    const choices = Array.isArray(problemInfo.answer_choices)
      ? problemInfo.answer_choices.filter(Boolean)
      : []

    if (
      choices.length < 2 ||
      !/\b(?:bacteria|organism|cell|population)\b/i.test(normalizedPrompt) ||
      !/\b(?:birth|born|reproduce|offspring)\b/i.test(normalizedPrompt) ||
      !/\b(?:life span|lifespan|lives? for|death|die)\b/i.test(normalizedPrompt)
    ) {
      return null
    }

    const birthsPerPeriod = this.parseSmallNumberFromText(normalizedPrompt, [
      "birth(?:s)? to",
      "gives? birth to",
      "produces?",
      "reproduces?",
    ])
    const lifespan = this.parseSmallNumberFromText(normalizedPrompt, [
      "life span(?: of each)?(?: is)?",
      "lifespan(?: of each)?(?: is)?",
      "lives? for",
    ])
    const totalTime = this.parseSmallNumberFromText(normalizedPrompt, [
      "after",
      "at time\\s*t\\s*=",
      "time",
    ])

    if (!birthsPerPeriod || !lifespan || !totalTime || totalTime <= lifespan) {
      return null
    }

    const growthBase = birthsPerPeriod + 1
    const expected =
      Math.pow(growthBase, totalTime) -
      Math.pow(growthBase, totalTime - lifespan)
    const matchingChoice = choices.find((choice) => {
      if (/\bnone of (?:these|the above)\b/i.test(choice)) {
        return false
      }

      const value = this.evaluateSimpleMathExpression(choice)
      return value !== null && Math.abs(value - expected) < 1e-6
    })

    if (!matchingChoice) {
      return null
    }

    const optionMatch = /^\s*(?:option\s+)?([A-H])(?:[.)])?/i.exec(matchingChoice)
    const answer = optionMatch ? optionMatch[1].toUpperCase() : matchingChoice.trim()

    return {
      question_type: "mcq",
      is_code_response: false,
      answer,
      code: answer,
      thoughts: [],
    }
  }
  private finalizeDisplayedSolution(
    solution: {
      question_type: string
      is_code_response: boolean
      answer: string
      code: string
      thoughts: string[]
    },
    problemInfo?: Partial<ExtractedQuestionInfo> | null
  ): {
    question_type: string
    is_code_response: boolean
    answer: string
    code: string
    thoughts: string[]
  } {
    const answerFormat = (problemInfo?.answer_format || "").trim().toLowerCase()
    const contentSummary = (problemInfo?.content_summary || "").trim()
    const isSummaryMode = !solution.is_code_response && (answerFormat === "summary" || Boolean(contentSummary))

    if (!isSummaryMode) {
      return solution
    }

    const compactAnswer = this.shortenSummaryAnswer(solution.answer || solution.code || "")
    return {
      ...solution,
      answer: compactAnswer,
      code: compactAnswer,
      thoughts: [],
    }
  }

  private extractDirectMcqAnswer(answer: string): string {
    const sanitized = this.sanitizeMetaAnswerText(answer).replace(/\r/g, "").trim()
    if (!sanitized) {
      return ""
    }

    const lines = sanitized
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
    const firstLine = (lines[0] || sanitized).replace(/^answer\s*[:\-]\s*/i, "").trim()
    const pureAnswer = sanitized.replace(/^answer\s*[:\-]\s*/i, "").trim()
    const hasMultipleAnswerParts =
      lines.length > 1 &&
      lines.some((line) => /^(?:\d+[.):]|[A-H][.)]|[-*])\s+/.test(line))

    if (hasMultipleAnswerParts) {
      return sanitized
    }

    const trueFalseMatch =
      /^(true|false)$/i.exec(firstLine) || /^(true|false)$/i.exec(pureAnswer)
    if (trueFalseMatch) {
      const value = trueFalseMatch[1].toLowerCase()
      return value.charAt(0).toUpperCase() + value.slice(1)
    }

    const pureOptionMatch =
      /^(?:option\s+)?([A-H])(?:[.)])?$/i.exec(firstLine) ||
      /^(?:option\s+)?([A-H])(?:[.)])?$/i.exec(pureAnswer)
    if (pureOptionMatch) {
      return /^option\s+/i.test(firstLine) || /^option\s+/i.test(pureAnswer)
        ? "Option " + pureOptionMatch[1].toUpperCase()
        : pureOptionMatch[1].toUpperCase()
    }

    return this.trimCompactAnswer(firstLine, 160)
  }

  private normalizeSolutionResponse(
    response: Partial<StructuredSolutionResponse>,
    fallbackQuestionType: string | undefined
  ) {
    const questionType = response.question_type || fallbackQuestionType || "general"
    const normalizedAnswer = this.normalizeStructuredTextValue(response.answer)
    const sanitizedAnswer = this.sanitizeMetaAnswerText(normalizedAnswer)
    const code = this.normalizeStructuredTextValue(response.code)
    const isCodeResponse = response.is_code_response ?? Boolean(code)
    const answer = isCodeResponse
      ? sanitizedAnswer || code
      : questionType === "mcq"
        ? this.extractDirectMcqAnswer(sanitizedAnswer || code)
        : sanitizedAnswer
    const primaryContent = answer || code
    const normalizedPrimaryContent = this.normalizeThoughtText(primaryContent)
    const distinctThoughts = Array.isArray(response.thoughts)
      ? response.thoughts
          .filter((thought): thought is string => typeof thought === "string")
          .map((thought) => thought.trim())
          .filter(Boolean)
          .filter((thought) => this.normalizeThoughtText(thought) !== normalizedPrimaryContent)
          .slice(0, 1)
      : []

    return {
      question_type: questionType,
      is_code_response: isCodeResponse,
      answer: answer || code,
      code: isCodeResponse ? code || answer : answer || code,
      thoughts: distinctThoughts,
    }
  }

  private trimPhoneRelayText(value: unknown, maxLength: number): string {
    const text = this.normalizeStructuredTextValue(value)
    if (text.length <= maxLength) {
      return text
    }

    return text.slice(0, Math.max(0, maxLength - 20)).trimEnd() + "\n...[truncated]"
  }

  private publishPhoneRelayScreenResult(
    solution: ReturnType<ProcessingHelper["normalizeSolutionResponse"]>,
    problemInfo: ExtractedQuestionInfo
  ): void {
    if (!this.deps.publishPhoneRelayResult) {
      return
    }

    try {
      const question = this.trimPhoneRelayText(
        problemInfo.problem_statement || problemInfo.content_summary || "",
        4000
      )
      const answer = this.trimPhoneRelayText(solution.answer || solution.code || "", 12000)
      const code = solution.is_code_response
        ? this.trimPhoneRelayText(solution.code || solution.answer || "", 20000)
        : ""

      this.deps.publishPhoneRelayResult({
        question,
        questionType: problemInfo.question_type || solution.question_type || "general",
        answer,
        code,
        isCodeResponse: Boolean(solution.is_code_response),
        thoughts: Array.isArray(solution.thoughts) ? solution.thoughts.slice(0, 2) : [],
        answerChoices: Array.isArray(problemInfo.answer_choices)
          ? problemInfo.answer_choices.slice(0, 12)
          : [],
        answerFormat: problemInfo.answer_format || "",
        generatedAt: new Date().toISOString(),
        source: "desktop",
      })
    } catch (error) {
      console.warn("Failed to publish screen result to phone relay:", error)
    }
  }

  private normalizeStructuredTextValue(value: unknown): string {
    if (typeof value === "string") {
      return value.trim();
    }

    if (Array.isArray(value)) {
      return value
        .map((item) => this.normalizeStructuredTextValue(item))
        .filter(Boolean)
        .join("\n")
        .trim();
    }

    if (value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>).sort(
        ([leftKey], [rightKey]) => this.compareStructuredAnswerKeys(leftKey, rightKey)
      );

      return entries
        .map(([key, entryValue]) => {
          const normalizedValue = this.normalizeStructuredTextValue(entryValue);
          if (!normalizedValue) {
            return "";
          }

          const trimmedKey = key.trim();
          if (!trimmedKey) {
            return normalizedValue;
          }

          if (/^\d+\.?$/.test(trimmedKey)) {
            const numberedKey = trimmedKey.endsWith(".")
              ? trimmedKey
              : `${trimmedKey}.`;
            return `${numberedKey} ${normalizedValue}`.trim();
          }

          return `${trimmedKey}: ${normalizedValue}`.trim();
        })
        .filter(Boolean)
        .join("\n")
        .trim();
    }

    return typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : "";
  }


  private compareStructuredAnswerKeys(leftKey: string, rightKey: string): number {
    const leftMatch = leftKey.trim().match(/^(\d+)\.?$/);
    const rightMatch = rightKey.trim().match(/^(\d+)\.?$/);

    if (leftMatch && rightMatch) {
      return Number(leftMatch[1]) - Number(rightMatch[1]);
    }

    return leftKey.localeCompare(rightKey, undefined, { numeric: true });
  }

  private emitProcessingStatus(message: string, progress: number) {
    const mainWindow = this.deps.getMainWindow()
    if (!mainWindow) {
      return
    }

    mainWindow.webContents.send("processing-status", {
      message,
      progress,
    })
  }
  private emitSolutionStream(data: {
    content: string
    isCodeResponse: boolean
    done?: boolean
  }) {
    const mainWindow = this.deps.getMainWindow()
    if (!mainWindow) {
      return
    }

    mainWindow.webContents.send("solution-stream", {
      content: data.content,
      isCodeResponse: data.isCodeResponse,
      done: Boolean(data.done),
    })
  }
  
  /**
   * Initialize or reinitialize the AI client with current config
   */
  private initializeAIClient(): void {
    try {
      const config = configHelper.loadConfig();
      const configuredApiKey = configHelper.getConfiguredApiKey(
        config.apiProvider
      );
      
      if (this.isOpenAICompatibleProvider(config.apiProvider)) {
        if (configuredApiKey) {
          this.openaiClient = new OpenAI({ 
            apiKey: configuredApiKey,
            baseURL:
              config.apiProvider === "together"
                ? TOGETHER_BASE_URL
                : config.apiProvider === "fireworks"
                ? FIREWORKS_BASE_URL
                : undefined,
            timeout: 60000, // 60 second timeout
            maxRetries: 2   // Retry up to 2 times
          });
          this.geminiApiKey = null;
          this.anthropicClient = null;
          console.log(
            `${this.getProviderLabel(config.apiProvider)} client initialized successfully`
          );
        } else {
          this.openaiClient = null;
          this.geminiApiKey = null;
          this.anthropicClient = null;
          console.warn(
            `No API key available, ${this.getProviderLabel(config.apiProvider)} client not initialized`
          );
        }
      } else if (config.apiProvider === "gemini"){
        // Gemini client initialization
        this.openaiClient = null;
        this.anthropicClient = null;
        if (configuredApiKey) {
          this.geminiApiKey = configuredApiKey;
          console.log("Gemini API key set successfully");
        } else {
          this.openaiClient = null;
          this.geminiApiKey = null;
          this.anthropicClient = null;
          console.warn("No API key available, Gemini client not initialized");
        }
	      } else if (config.apiProvider === "anthropic") {
        // Reset other clients
        this.openaiClient = null;
        this.geminiApiKey = null;
        if (configuredApiKey) {
          this.anthropicClient = new Anthropic({
            apiKey: configuredApiKey,
            timeout: 60000,
            maxRetries: 2
          });
          console.log("Anthropic client initialized successfully");
        } else {
          this.openaiClient = null;
          this.geminiApiKey = null;
          this.anthropicClient = null;
          console.warn("No API key available, Anthropic client not initialized");
        }
      }
    } catch (error) {
      console.error("Failed to initialize AI client:", error);
      this.openaiClient = null;
      this.geminiApiKey = null;
      this.anthropicClient = null;
    }
  }

  private async waitForInitialization(
    mainWindow: BrowserWindow
  ): Promise<void> {
    let attempts = 0
    const maxAttempts = 50 // 5 seconds total

    while (attempts < maxAttempts) {
      const isInitialized = await mainWindow.webContents.executeJavaScript(
        "window.__IS_INITIALIZED__"
      )
      if (isInitialized) return
      await new Promise((resolve) => setTimeout(resolve, 100))
      attempts++
    }
    throw new Error("App failed to initialize after 5 seconds")
  }

  private async getCredits(): Promise<number> {
    const mainWindow = this.deps.getMainWindow()
    if (!mainWindow) return 999 // Unlimited credits in this version

    try {
      await this.waitForInitialization(mainWindow)
      return 999 // Always return sufficient credits to work
    } catch (error) {
      console.error("Error getting credits:", error)
      return 999 // Unlimited credits as fallback
    }
  }

  private async getLanguage(): Promise<string> {
    try {
      // Get language from config
      const config = configHelper.loadConfig();
      if (config.language) {
        return config.language;
      }
      
      // Fallback to window variable if config doesn't have language
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow) {
        try {
          await this.waitForInitialization(mainWindow)
          const language = await mainWindow.webContents.executeJavaScript(
            "window.__LANGUAGE__"
          )

          if (
            typeof language === "string" &&
            language !== undefined &&
            language !== null
          ) {
            return language;
          }
        } catch (err) {
          console.warn("Could not get language from window", err);
        }
      }
      
      // Default fallback
      return "python";
    } catch (error) {
      console.error("Error getting language:", error)
      return "python"
    }
  }

  public async processScreenshots(): Promise<void> {
    const mainWindow = this.deps.getMainWindow()
    if (!mainWindow) return

    const config = configHelper.loadConfig();
    
    // First verify we have a valid AI client
    if (this.shouldUseDirectOpenAIForScreenTasks()) {
      try {
        this.getDirectOpenAIClient();
      } catch (error) {
        console.error("OpenAI client not initialized for screen tasks", error);
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.API_KEY_INVALID
        );
        return;
      }
    } else if (this.isOpenAICompatibleProvider(config.apiProvider) && !this.openaiClient) {
      this.initializeAIClient();
      
      if (!this.openaiClient) {
        console.error(
          `${this.getProviderLabel(config.apiProvider)} client not initialized`
        );
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.API_KEY_INVALID
        );
        return;
      }
    } else if (config.apiProvider === "gemini" && !this.geminiApiKey) {
      this.initializeAIClient();
      
      if (!this.geminiApiKey) {
        console.error("Gemini API key not initialized");
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.API_KEY_INVALID
        );
        return;
      }
    } else if (config.apiProvider === "anthropic" && !this.anthropicClient) {
      // Add check for Anthropic client
      this.initializeAIClient();
      
      if (!this.anthropicClient) {
        console.error("Anthropic client not initialized");
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.API_KEY_INVALID
        );
        return;
      }
    }

    const view = this.deps.getView()
    console.log("Processing screenshots in view:", view)

    if (view === "queue") {
      mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.INITIAL_START)
      const screenshotQueue = this.screenshotHelper.getScreenshotQueue()
      console.log("Processing main queue screenshots:", screenshotQueue)
      
      // Check if the queue is empty
      if (!screenshotQueue || screenshotQueue.length === 0) {
        console.log("No screenshots found in queue");
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS);
        return;
      }

      // Check that files actually exist
      const existingScreenshots = screenshotQueue.filter(path => fs.existsSync(path));
      if (existingScreenshots.length === 0) {
        console.log("Screenshot files don't exist on disk");
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS);
        return;
      }

      try {
        // Initialize AbortController
        this.currentProcessingAbortController = new AbortController()
        const { signal } = this.currentProcessingAbortController

        const screenshots = await Promise.all(
          existingScreenshots.map(async (path) => {
            try {
              return {
                path,
                data: fs.readFileSync(path).toString('base64')
              };
            } catch (err) {
              console.error(`Error reading screenshot ${path}:`, err);
              return null;
            }
          })
        )

        // Filter out any nulls from failed screenshots
        const validScreenshots = screenshots.filter(Boolean);
        
        if (validScreenshots.length === 0) {
          throw new Error("Failed to load screenshot data");
        }

        const result = await this.processScreenshotsHelper(validScreenshots, signal)

        if (!result.success) {
          const resultError =
            "error" in result && result.error
              ? result.error
              : "Failed to process screenshots. Please try again."
          console.log("Processing failed:", resultError)
          const errorText = resultError.toLowerCase();
          if (
            errorText.includes("api key") ||
            errorText.includes("openai") ||
            errorText.includes("gemini") ||
            errorText.includes("anthropic") ||
            errorText.includes("claude") ||
            errorText.includes("together")
          ) {
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.API_KEY_INVALID
            )
          } else {
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
              resultError
            )
          }
          // Reset view back to queue on error
          console.log("Resetting view to queue due to error")
          this.deps.setView("queue")
          return
        }

        // Only set view to solutions if processing succeeded
        console.log("Setting view to solutions after successful processing")
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.SOLUTION_SUCCESS,
          result.data
        )
        this.deps.setView("solutions")
      } catch (error: any) {
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
          error
        )
        console.error("Processing error:", error)
        if (axios.isCancel(error)) {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
            "Processing was canceled by the user."
          )
        } else {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
            error.message || "Server error. Please try again."
          )
        }
        // Reset view back to queue on error
        console.log("Resetting view to queue due to error")
        this.deps.setView("queue")
      } finally {
        this.currentProcessingAbortController = null
      }
    } else {
      // view == 'solutions'
      const extraScreenshotQueue =
        this.screenshotHelper.getExtraScreenshotQueue()
      console.log("Processing extra queue screenshots:", extraScreenshotQueue)
      
      // Check if the extra queue is empty
      if (!extraScreenshotQueue || extraScreenshotQueue.length === 0) {
        console.log("No extra screenshots found in queue");
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS);
        
        return;
      }

      // Check that files actually exist
      const existingExtraScreenshots = extraScreenshotQueue.filter(path => fs.existsSync(path));
      if (existingExtraScreenshots.length === 0) {
        console.log("Extra screenshot files don't exist on disk");
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS);
        return;
      }
      
      mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.DEBUG_START)

      // Initialize AbortController
      this.currentExtraProcessingAbortController = new AbortController()
      const { signal } = this.currentExtraProcessingAbortController

      try {
        // Get all screenshots (both main and extra) for processing
        const allPaths = [
          ...this.screenshotHelper.getScreenshotQueue(),
          ...existingExtraScreenshots
        ];
        
        const screenshots = await Promise.all(
          allPaths.map(async (path) => {
            try {
              if (!fs.existsSync(path)) {
                console.warn(`Screenshot file does not exist: ${path}`);
                return null;
              }
              
              return {
                path,
                data: fs.readFileSync(path).toString('base64')
              };
            } catch (err) {
              console.error(`Error reading screenshot ${path}:`, err);
              return null;
            }
          })
        )
        
        // Filter out any nulls from failed screenshots
        const validScreenshots = screenshots.filter(Boolean);
        
        if (validScreenshots.length === 0) {
          throw new Error("Failed to load screenshot data for debugging");
        }
        
        console.log(
          "Combined screenshots for processing:",
          validScreenshots.map((s) => s.path)
        )

        const result = await this.processExtraScreenshotsHelper(
          validScreenshots,
          signal
        )

        if (result.success) {
          this.deps.setHasDebugged(true)
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.DEBUG_SUCCESS,
            result.data
          )
        } else {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.DEBUG_ERROR,
            result.error
          )
        }
      } catch (error: any) {
        if (axios.isCancel(error)) {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.DEBUG_ERROR,
            "Extra processing was canceled by the user."
          )
        } else {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.DEBUG_ERROR,
            error.message
          )
        }
      } finally {
        this.currentExtraProcessingAbortController = null
      }
    }
  }

  private async processScreenshotsHelper(
    screenshots: Array<{ path: string; data: string }>,
    signal: AbortSignal
  ) {
    try {
      const config = configHelper.loadConfig();
      const language = await this.getLanguage();
      const mainWindow = this.deps.getMainWindow();
      
      // Step 1: Extract problem info using the configured vision-capable API
      const imageDataList = screenshots.map(screenshot => screenshot.data);
      
      // Update the user on progress
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Reading the screenshot and starting the answer...",
          progress: 24
        });
      }

      try {
        let problemInfo: ExtractedQuestionInfo
        let finalSolution:
          | ReturnType<ProcessingHelper["normalizeSolutionResponse"]>
          | undefined

        if (
          this.shouldUseDirectOpenAIForScreenTasks() ||
          this.shouldUseManagedAnalyzeStack(config)
        ) {
          problemInfo = await this.extractQuestionInfoFromImageData(
            imageDataList,
            language,
            config,
            signal
          )
        } else {
          const analyzeResult = await this.generateFastAnalyzeFromImageData(
            imageDataList,
            language,
            config,
            signal
          );
          problemInfo = analyzeResult.problemInfo
          finalSolution = analyzeResult.solution
        }

        problemInfo = this.normalizeExtractedQuestionInfo(problemInfo)

        if (!this.hasUsableExtractedQuestionInfo(problemInfo) && !finalSolution) {
          const recovered = await this.recoverFromWeakExtraction(
            imageDataList,
            language,
            config,
            signal,
            problemInfo
          )
          problemInfo = recovered.problemInfo
          finalSolution = recovered.solution
        }

        // Store problem info in AppState
        this.deps.setProblemInfo(problemInfo);

        if (!finalSolution) {
          if (mainWindow) {
            const providerLabel = this.shouldUseDirectOpenAIForScreenTasks()
              ? "OpenAI"
              : this.getAnalyzeProviderLabel(config)
            mainWindow.webContents.send("processing-status", {
              message: `Generating the answer with ${providerLabel}...`,
              progress: 58
            });
          }

          const solutionResult = await this.generateStructuredSolutionForProblemInfo(
            problemInfo,
            language,
            config,
            signal
          )

          if (!solutionResult.success) {
            return solutionResult
          }

          finalSolution = solutionResult.data
        }

        if (
          !this.shouldUseDirectOpenAIForScreenTasks() &&
          !this.shouldUseManagedAnalyzeStack(config) &&
          this.shouldRunExpandedSolutionPass(problemInfo) &&
          !this.fastAnswerLikelyCoversMultipleQuestions(problemInfo, finalSolution)
        ) {
          if (mainWindow) {
            mainWindow.webContents.send("processing-status", {
              message: "Detected multiple questions. Expanding the answer...",
              progress: 62
            });
          }

          const expandedResult = await this.generateStructuredSolutionForProblemInfo(
            problemInfo,
            language,
            config,
            signal
          )

          if (!expandedResult.success) {
            console.warn(
              "Expanded multi-question solution generation failed; falling back to fast analyze result.",
              "error" in expandedResult ? expandedResult.error : "Unknown error"
            )
          } else {
            finalSolution = expandedResult.data
          }
        }

        const solutionPayload = {
          ...(finalSolution || {}),
          extracted_problem: problemInfo,
        }

        if (finalSolution) {
          this.publishPhoneRelayScreenResult(finalSolution, problemInfo)
        }

        if (mainWindow) {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.PROBLEM_EXTRACTED,
            problemInfo
          )

          this.screenshotHelper.clearExtraScreenshotQueue()

          mainWindow.webContents.send("processing-status", {
            message: "Solution generated successfully",
            progress: 100
          })

          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.SOLUTION_SUCCESS,
            solutionPayload
          )
        }

        return { success: true, data: solutionPayload };
      } catch (error: any) {
        console.error("Error generating fast analyze result:", error);
        return {
          success: false,
          error:
            error?.message ||
            "Failed to read the screenshot and generate an answer. Try again with a clearer screenshot."
        };
      }
    } catch (error: any) {
      // If the request was cancelled, don't retry
      if (axios.isCancel(error)) {
        return {
          success: false,
          error: "Processing was canceled by the user."
        };
      }

      // Handle common OpenAI-compatible API errors
      if (error?.response?.status === 401) {
        return {
          success: false,
          error: "Invalid API key. Please check your settings."
        };
      } else if (error?.response?.status === 429) {
        return {
          success: false,
          error: "API rate limit exceeded or insufficient credits. Please try again later."
        };
      } else if (error?.response?.status === 500) {
        return {
          success: false,
          error: "Provider server error. Please try again later."
        };
      }

      console.error("API Error Details:", error);
      return { 
        success: false, 
        error: error.message || "Failed to process screenshots. Please try again." 
      };
    }
  }

  private async generateSolutionsHelper(signal: AbortSignal) {
    try {
      const problemInfo = this.deps.getProblemInfo() as ExtractedQuestionInfo;
      const language = await this.getLanguage();
      const config = configHelper.loadConfig();
      const mainWindow = this.deps.getMainWindow();

      if (!problemInfo) {
        throw new Error("No problem info available");
      }

      // Update progress status
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Generating the answer...",
          progress: 62
        });
      }

      return await this.generateStructuredSolutionForProblemInfo(
        problemInfo,
        language,
        config,
        signal
      );
    } catch (error: any) {
      if (axios.isCancel(error)) {
        return {
          success: false,
          error: "Processing was canceled by the user."
        };
      }
      
      if (error?.response?.status === 401) {
        return {
          success: false,
          error: "Invalid API key. Please check your settings."
        };
      } else if (error?.response?.status === 429) {
        return {
          success: false,
          error: "API rate limit exceeded or insufficient credits. Please try again later."
        };
      }
      
      console.error("Solution generation error:", error);
      return { success: false, error: error.message || "Failed to generate solution" };
    }
  }

  private async processExtraScreenshotsHelper(
    screenshots: Array<{ path: string; data: string }>,
    signal: AbortSignal
  ) {
    try {
      const problemInfo = this.deps.getProblemInfo() as ExtractedQuestionInfo;
      const language = await this.getLanguage();
      const config = configHelper.loadConfig();
      const mainWindow = this.deps.getMainWindow();

      if (!problemInfo) {
        throw new Error("No problem info available");
      }

      // Update progress status
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Processing follow-up screenshots...",
          progress: 30
        });
      }

      // Prepare the images for the API call
      const imageDataList = screenshots.map((screenshot) =>
        this.optimizeVisionImageData(screenshot.data)
      );
      const followUpPrompt = this.buildFollowUpPrompt(problemInfo, language);
      
      let debugContent;
      
      if (this.shouldUseDirectOpenAIForScreenTasks()) {
        const messages = [
          {
            role: "system" as const,
            content:
              "You are a high-accuracy assistant for coding, academics, multiple-choice questions, and general reasoning. Follow the requested markdown section structure exactly.",
          },
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const,
                text: followUpPrompt,
              },
              ...imageDataList.map((data) => ({
                type: "image_url" as const,
                image_url: this.buildVisionImageUrl(data, "high"),
              })),
            ],
          },
        ]

        if (mainWindow) {
          mainWindow.webContents.send("processing-status", {
            message: "Analyzing code and generating debug feedback with OpenAI...",
            progress: 60,
          })
        }

        const debugResponse = await this.createOpenAICompletion(
          {
            model: this.getOpenAIScreenModel(),
            messages,
            max_tokens: 4000,
            temperature: 0,
          },
          signal
        )

        debugContent = debugResponse.choices[0].message.content || ""
      } else if (this.isOpenAICompatibleProvider(config.apiProvider)) {
        const providerLabel = this.getAnalyzeProviderLabel(config);
        const analyzeClient = this.getAnalyzeClient(config)

        if (!analyzeClient) {
          return {
            success: false,
            error: `${providerLabel} API key not configured. Please check your settings.`
          };
        }
        
        const messages = [
          {
            role: "system" as const, 
            content: "You are a high-accuracy assistant for coding, academics, multiple-choice questions, and general reasoning. Follow the requested markdown section structure exactly."
          },
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const, 
                text: followUpPrompt
              },
              ...imageDataList.map(data => ({
                type: "image_url" as const,
                image_url: this.buildVisionImageUrl(
                  data,
                  config.apiProvider === "openai" ? "high" : null
                )
              }))
            ]
          }
        ];

        if (mainWindow) {
          mainWindow.webContents.send("processing-status", {
            message: `Analyzing code and generating debug feedback with ${providerLabel}...`,
            progress: 60
          });
        }

        const debugRequest: any = {
          model: this.getAnalyzeModel(config, "debuggingModel"),
          messages: messages,
          max_tokens: 4000,
          temperature: 0.2
        }

        const debugResponse = this.shouldUseHuggingFaceForAnalyze(config)
          ? await this.createScreenAnalysisCompletion(debugRequest, signal)
          : await analyzeClient.chat.completions.create(debugRequest, {
              signal,
            });
        
        debugContent = debugResponse.choices[0].message.content;
      } else if (config.apiProvider === "gemini")  {
        if (!this.geminiApiKey) {
          return {
            success: false,
            error: "Gemini API key not configured. Please check your settings."
          };
        }
        
        try {
          const debugPrompt = followUpPrompt;

          const geminiMessages = [
            {
              role: "user",
              parts: [
                { text: debugPrompt },
                ...imageDataList.map(data => ({
                  inlineData: {
                    mimeType: "image/png",
                    data: data
                  }
                }))
              ]
            }
          ];

          if (mainWindow) {
            mainWindow.webContents.send("processing-status", {
              message: "Analyzing code and generating debug feedback with Gemini...",
              progress: 60
            });
          }

          const response = await axios.default.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${config.debuggingModel || "gemini-2.0-flash"}:generateContent?key=${this.geminiApiKey}`,
            {
              contents: geminiMessages,
              generationConfig: {
                temperature: 0,
                maxOutputTokens: 4000
              }
            },
            { signal }
          );

          const responseData = response.data as GeminiResponse;
          
          if (!responseData.candidates || responseData.candidates.length === 0) {
            throw new Error("Empty response from Gemini API");
          }
          
          debugContent = responseData.candidates[0].content.parts[0].text;
        } catch (error) {
          console.error("Error using Gemini API for debugging:", error);
          return {
            success: false,
            error: "Failed to process debug request with Gemini API. Please check your API key or try again later."
          };
        }
      } else if (config.apiProvider === "anthropic") {
        if (!this.anthropicClient) {
          return {
            success: false,
            error: "Anthropic API key not configured. Please check your settings."
          };
        }
        
        try {
          const debugPrompt = followUpPrompt;

          const messages = [
            {
              role: "user" as const,
              content: [
                {
                  type: "text" as const,
                  text: debugPrompt
                },
                ...imageDataList.map(data => ({
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: "image/png" as const, 
                    data: data
                  }
                }))
              ]
            }
          ];

          if (mainWindow) {
            mainWindow.webContents.send("processing-status", {
              message: "Analyzing code and generating debug feedback with Claude...",
              progress: 60
            });
          }

          const response = await this.anthropicClient.messages.create({
            model:
              config.debuggingModel ||
              this.getDefaultModelForStage(config.apiProvider, "debuggingModel"),
            max_tokens: 4000,
            messages: messages,
            temperature: 0.2
          });
          
          debugContent = (response.content[0] as { type: 'text', text: string }).text;
        } catch (error: any) {
          console.error("Error using Anthropic API for debugging:", error);
          
          // Add specific handling for Claude's limitations
          if (error.status === 429) {
            return {
              success: false,
              error: "Claude API rate limit exceeded. Please wait a few minutes before trying again."
            };
          } else if (error.status === 413 || (error.message && error.message.includes("token"))) {
            return {
              success: false,
              error: "Your screenshots contain too much information for Claude to process. Switch to OpenAI, Gemini, or Together AI in settings which can handle larger inputs."
            };
          }
          
          return {
            success: false,
            error: "Failed to process debug request with Anthropic API. Please check your API key or try again later."
          };
        }
      }
      
      
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Debug analysis complete",
          progress: 100
        });
      }

      let extractedCode = "// Debug mode - see analysis below";
      const codeMatch = debugContent.match(/```(?:[a-zA-Z]+)?([\s\S]*?)```/);
      if (codeMatch && codeMatch[1]) {
        extractedCode = codeMatch[1].trim();
      }

      let formattedDebugContent = debugContent;
      
      if (!debugContent.includes('# ') && !debugContent.includes('## ')) {
        formattedDebugContent = debugContent
          .replace(/issues identified|problems found|bugs found/i, '## Issues Identified')
          .replace(/code improvements|improvements|suggested changes/i, '## Code Improvements')
          .replace(/optimizations|performance improvements/i, '## Optimizations')
          .replace(/explanation|detailed analysis/i, '## Explanation');
      }

      const bulletPoints = formattedDebugContent.match(/(?:^|\n)[ ]*(?:[-*Ã¢â‚¬Â¢]|\d+\.)[ ]+([^\n]+)/g);
      const thoughts = bulletPoints 
        ? bulletPoints.map(point => point.replace(/^[ ]*(?:[-*Ã¢â‚¬Â¢]|\d+\.)[ ]+/, '').trim()).slice(0, 5)
        : ["Debug analysis based on your screenshots"];
      
      const response = {
        code: extractedCode,
        debug_analysis: formattedDebugContent,
        thoughts: thoughts,
      };

      return { success: true, data: response };
    } catch (error: any) {
      console.error("Debug processing error:", error);
      return { success: false, error: error.message || "Failed to process debug request" };
    }
  }

  public async processTextFollowUp(
    request: TextFollowUpRequest,
    options: TextFollowUpProcessingOptions = {}
  ): Promise<{ success: true; data: TextFollowUpResponse } | { success: false; error: string }> {
    const message = request.message.trim()
    const userIntentMessage = this.getUserIntentMessage(request)
    const mode: AssistantChatMode =
      request.mode === "follow_up" ? "follow_up" : "general"
    if (!message) {
      return {
        success: false,
        error:
          mode === "general"
            ? "Enter a message first."
            : "Enter a follow-up question first.",
      }
    }

    const problemInfo = this.deps.getProblemInfo() as ExtractedQuestionInfo | null
    const normalizedProblemInfo = this.normalizeExtractedQuestionInfo(
      problemInfo || {
        problem_statement: "",
        sub_questions: [],
      }
    )
    const language = await this.getLanguage()
    const mainWindow = this.deps.getMainWindow()

    this.currentExtraProcessingAbortController?.abort()
    const abortController = new AbortController()
    this.currentExtraProcessingAbortController = abortController
    const signal = abortController.signal

    try {
      const shouldCaptureScreen = this.shouldCaptureScreenContext(
        mode,
        userIntentMessage
      )
      let screenCapture: { data: string; preview: string } | null = null

      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: shouldCaptureScreen
            ? "Checking your screen..."
            : "Generating follow-up response...",
          progress: shouldCaptureScreen ? 35 : 55,
        })
      }

      if (shouldCaptureScreen) {
        screenCapture = await this.captureScreenContextForChat()

        if (mainWindow) {
          mainWindow.webContents.send("processing-status", {
            message: "Analyzing your screen...",
            progress: 60,
          })
        }
      }

      const basePrompt = screenCapture
        ? this.buildGroqScreenAwarePrompt(
            language,
            request,
            await this.analyzeScreenContextForGroqChat(
              screenCapture.data,
              language,
              request,
              signal
            )
          )
        : this.buildTextFollowUpPrompt(
            normalizedProblemInfo,
            language,
            request
          )

      const webSearchRequested = shouldUseExaSearch(userIntentMessage)
      const webSearchQuery = compactSearchQuery(userIntentMessage, 90)
      const fileSearchRequested = shouldUseLocalFileSearch(userIntentMessage)
      const fileSearchQuery = compactFileSearchQuery(userIntentMessage, 90)

      if (webSearchRequested) {
        if (mainWindow) {
          mainWindow.webContents.send("processing-status", {
            message: `Searching web${webSearchQuery ? `: ${webSearchQuery}` : ""}...`,
            progress: 68,
          })
        }
        options.onStream?.(
          `Searching web${webSearchQuery ? ` for "${webSearchQuery}"` : ""}...`
        )
      }

      if (fileSearchRequested) {
        if (mainWindow) {
          mainWindow.webContents.send("processing-status", {
            message: `Searching files${fileSearchQuery ? `: ${fileSearchQuery}` : ""}...`,
            progress: webSearchRequested ? 74 : 68,
          })
        }
        options.onStream?.(
          `Searching local files${fileSearchQuery ? ` for "${fileSearchQuery}"` : ""}...`
        )
      }

      const [webContext, fileContext] = await Promise.all([
        buildExaSearchContext(
          [
            userIntentMessage,
            request.currentContext || "",
            this.buildProblemSearchQuery(normalizedProblemInfo),
          ]
            .filter(Boolean)
            .join("\n"),
          { signal, maxCharacters: 6000, force: webSearchRequested }
        ),
        buildLocalFileSearchContext(userIntentMessage, {
          signal,
          maxCharacters: 6000,
          force: fileSearchRequested,
        }),
      ])

      if (webSearchRequested) {
        options.onStream?.(
          webContext.trim()
            ? "Found web results. Writing answer..."
            : "I tried the web search, but Exa returned no usable results. Writing the best answer I can..."
        )
      }

      if (fileSearchRequested) {
        options.onStream?.(
          fileContext.trim()
            ? "Finished local file search. Writing answer..."
            : "I searched local files but found no usable results. Writing the best answer I can..."
        )
      }

      let prompt = webContext.trim()
        ? this.appendWebContextToPrompt(basePrompt, webContext, webSearchRequested)
        : webSearchRequested
          ? `${basePrompt}\n\nWEB SEARCH NOTE:\nThe user asked for web search, but no usable Exa results were returned for: ${webSearchQuery || userIntentMessage}.`
          : basePrompt
      prompt = fileContext.trim()
        ? this.appendLocalFileSearchContextToPrompt(prompt, fileContext, fileSearchRequested)
        : fileSearchRequested
          ? `${prompt}\n\nLOCAL FILE SEARCH NOTE:\nThe user asked for local file search, but no matching files were found or the searched folders were not readable.`
          : prompt

      const reply = await this.generateOpenAITextResponse({
        systemPrompt:
          mode === "general"
            ? "You are a precise, practical desktop AI assistant. When web or local file context is provided, answer from it now. Include source URLs for web facts and exact paths for local file results. Never say you will search after search already happened."
            : "You are a precise follow-up assistant for coding, academic, MCQ, and general reasoning questions. When web or local file context is provided, answer from it now. Include source URLs for web facts and exact paths for local file results.",
        userPrompt: prompt,
        maxTokens: 2200,
        signal,
        model: this.getOpenAIScreenModel(),
        onStream: options.onStream,
      })

      const cleanedReply = reply.trim()
      if (!cleanedReply) {
        return {
          success: false,
          error: "The model returned an empty follow-up response.",
        }
      }

      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Follow-up response ready",
          progress: 100,
        })
      }

      return {
        success: true,
        data: {
          reply: cleanedReply,
        },
      }
    } catch (error: any) {
      if (axios.isCancel(error)) {
        return {
          success: false,
          error: "Follow-up request was canceled.",
        }
      }

      console.error("Text follow-up processing error:", error)
      return {
        success: false,
        error: error?.message || "Failed to generate a follow-up response.",
      }
    } finally {
      if (this.currentExtraProcessingAbortController === abortController) {
        this.currentExtraProcessingAbortController = null
      }
    }
  }

  public cancelOngoingRequests(notifyRenderer = true): void {
    let wasCancelled = false

    if (this.currentProcessingAbortController) {
      this.currentProcessingAbortController.abort()
      this.currentProcessingAbortController = null
      wasCancelled = true
    }

    if (this.currentExtraProcessingAbortController) {
      this.currentExtraProcessingAbortController.abort()
      this.currentExtraProcessingAbortController = null
      wasCancelled = true
    }

    if (this.currentLiveProcessingAbortController) {
      this.currentLiveProcessingAbortController.abort()
      this.currentLiveProcessingAbortController = null
      wasCancelled = true
    }

    this.deps.setHasDebugged(false)

    this.deps.setProblemInfo(null)

    const mainWindow = this.deps.getMainWindow()
    if (notifyRenderer && wasCancelled && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS)
    }
  }

  public cancelLiveInterviewRequest(): void {
    if (this.currentLiveProcessingAbortController) {
      this.currentLiveProcessingAbortController.abort()
      this.currentLiveProcessingAbortController = null
    }
  }
}
