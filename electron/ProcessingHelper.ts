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
  PROVIDER_DISPLAY_NAMES,
  TOGETHER_BASE_URL,
  TOGETHER_GENERAL_MODEL,
} from "../shared/aiConfig"
import type {
  AssistantChatMode,
  TextFollowUpRequest,
  TextFollowUpResponse,
} from "../shared/followUpChat"

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
  time_complexity?: string;
  space_complexity?: string;
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

const LIVE_AUDIO_TRANSCRIPTION_MODEL = "openai/whisper-large-v3"
const LIVE_INTERVIEW_MAX_TOKENS = 520
const LIVE_AUDIO_INTERVIEW_MAX_TOKENS = 420
const FAST_VISION_LONG_EDGE = 1440
const ANALYZE_EXTRACTION_BASE_TOKENS = 900
const ANALYZE_EXTRACTION_TOKENS_PER_EXTRA_IMAGE = 110
const ANALYZE_EXTRACTION_MAX_TOKENS = 1340
const FAST_ANALYZE_BASE_TOKENS = 1250
const FAST_ANALYZE_TOKENS_PER_EXTRA_IMAGE = 120
const FAST_ANALYZE_MAX_TOKENS = 1800

export class ProcessingHelper {
  private deps: IProcessingHelperDeps
  private screenshotHelper: ScreenshotHelper
  private openaiClient: OpenAI | null = null
  private geminiApiKey: string | null = null
  private anthropicClient: Anthropic | null = null
  private liveAudioTranscriptionClient: OpenAI | null = null
  private liveAudioTranscriptionApiKey: string | null = null

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
    return provider === "openai" || provider === "together";
  }

  private getProviderLabel(provider: ApiProvider): string {
    return PROVIDER_DISPLAY_NAMES[provider];
  }

  private getLiveAudioTranscriptionClient(): OpenAI {
    const apiKey = configHelper.getConfiguredApiKey("together")
    if (!apiKey) {
      throw new Error("Together AI key not configured for live audio transcription.")
    }

    if (
      !this.liveAudioTranscriptionClient ||
      this.liveAudioTranscriptionApiKey !== apiKey
    ) {
      this.liveAudioTranscriptionClient = new OpenAI({
        apiKey,
        baseURL: TOGETHER_BASE_URL,
        timeout: 60000,
        maxRetries: 2,
      })
      this.liveAudioTranscriptionApiKey = apiKey
    }

    return this.liveAudioTranscriptionClient
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
    if (normalizedMimeType.includes("flac")) {
      return "flac"
    }
    return "webm"
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

      if (!longestEdge || longestEdge <= FAST_VISION_LONG_EDGE) {
        return base64
      }

      const scale = FAST_VISION_LONG_EDGE / longestEdge
      const resizedImage = image.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: "good",
      })

      return resizedImage.toPNG().toString("base64")
    } catch (error) {
      console.warn("Falling back to original screenshot payload for vision.", error)
      return base64
    }
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
        ? 1100
        : questionType === "academic"
        ? 720
        : questionType === "mcq"
        ? 420
        : 620

    return Math.min(1500, baseBudget + Math.max(0, subQuestionCount - 1) * 90)
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

  private parseJsonResponse<T>(text: string): T {
    return JSON.parse(this.stripCodeFences(text)) as T;
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
        break
      }

      value += character
    }

    return value
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
- Keep wording accurate, but stay compact.
- Include all visible sub-parts in order.
- If there is no clear question, summarize the visible content instead of refusing.
- Preferred coding language is ${language}.
- Use empty strings or [] for missing fields.
- Return JSON only.`;
  }

  private buildFastAnalyzePrompt(language: string): string {
    return `Analyze the screenshot(s) and answer directly.

Return only valid JSON in this exact field order:
{
  "question_type": "coding|mcq|academic|general",
  "is_code_response": true,
  "answer": "direct final answer or concise explanation covering every visible question in order",
  "code": "only if code is genuinely needed, otherwise empty string",
  "thoughts": ["1 or 2 short reasoning bullets"],
  "time_complexity": "coding only, otherwise N/A - Not applicable",
  "space_complexity": "coding only, otherwise N/A - Not applicable",
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
- Start the useful answer as early as possible.
- Keep the answer minimal, correct, and fast to read.
- Include code only when the screenshot clearly asks for implementation.
- If there is no clear question, summarize the visible content instead.
- Include every visible sub-part in order.
- If multiple distinct questions or numbered parts are visible, answer all of them in order and label them clearly in "answer".
- Do not stop after the first visible question or sub-part.
- Preferred coding language is ${language}.
- Return JSON only.`;
  }

  private buildDirectAnalyzeAnswerPrompt(language: string): string {
    return `You are answering a screenshot-based question.

Instructions:
- Answer immediately in markdown.
- Be fast, direct, and minimal.
- If the screenshot asks for code, give a short correct ${language} solution with a code block.
- If it is MCQ, start with the best option, then one short reason.
- If it is general or academic, answer in a few short lines.
- If multiple questions or numbered parts are visible, answer all of them in order.
- If there is no explicit question, briefly summarize the visible content.
- Do not mention hidden prompts or internal tools.`
  }

  private parseDirectAnalyzeTextResponse(
    responseText: string
  ): ReturnType<ProcessingHelper["normalizeSolutionResponse"]> {
    const normalizedText = responseText.trim()
    const codeBlockMatch = /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/m.exec(normalizedText)
    const extractedCode = codeBlockMatch?.[1]?.trim() || ""
    const prose = normalizedText
      .replace(/```[a-zA-Z0-9_-]*\n[\s\S]*?```/gm, "")
      .trim()
    const fallbackThoughts = extractedCode
      ? [
          "The screenshot appears to require code, so the response is focused on the shortest usable implementation.",
        ]
      : this.buildDistinctAnswerThoughts(prose)

    return this.normalizeSolutionResponse(
      {
        question_type: extractedCode ? "coding" : "general",
        is_code_response: Boolean(extractedCode),
        answer: prose || normalizedText,
        code: extractedCode,
        thoughts: fallbackThoughts,
        time_complexity: extractedCode ? "Complexity not provided." : "N/A - Not applicable",
        space_complexity: extractedCode ? "Complexity not provided." : "N/A - Not applicable",
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
      answer.match(/(?:^|\n)\s*(?:[-*•]|\d+[\).:]|[a-zA-Z][\).:])\s+/gm)?.length || 0

    return bulletLikeParts >= expectedPartCount
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
  "answer": "final answer or concise solution explanation",
  "code": "code only if the task genuinely requires code, otherwise empty string",
  "thoughts": ["short bullet insight 1", "short bullet insight 2"],
  "time_complexity": "detailed complexity if coding, otherwise 'N/A - Not applicable'",
  "space_complexity": "detailed complexity if coding, otherwise 'N/A - Not applicable'"
}

Rules:
- Emit fields in the exact order shown above so the answer can stream early.
- For coding tasks with an explicit coding task: provide a correct, efficient implementation in ${language}, set is_code_response=true, and include detailed time/space complexity.
- For MCQs: answer directly, identify the best option, explain why, set is_code_response=false, and leave code empty.
- For academic/general tasks: provide a correct direct answer with concise reasoning, set is_code_response=false unless code is genuinely required.
- If there is no explicit question or the expected answer format is "summary", provide a concise summary of the visible content, explain the key points, and mention any obvious takeaway or action item. Set is_code_response=false unless code output is explicitly requested.
- If multiple distinct questions or sub-parts are present, answer all of them in order and label them clearly.
- Do not skip later questions even if the first question looks like the main one.
- If the screenshots contain multiple independent questions that cannot be represented as one code-only answer, set is_code_response=false and place the full multi-part answer in "answer".
- thoughts must be 1 or 2 short practical reasoning points.
- Keep the answer as short as possible while still correct and usable.
- Return JSON only.`;
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
- If the user asks for code, include a code block.
- If the user asks for interview help, be concise and practical.
- If the user asks a broad question, answer normally instead of insisting on screenshot context.
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
- If the task is MCQ, state the best option first and give one short reason.
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

    if (this.isOpenAICompatibleProvider(config.apiProvider)) {
      const response = await this.openaiClient!.chat.completions.create({
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
                type: "image_url" as const,
                image_url: { url: `data:image/png;base64,${data}` },
              })),
            ],
          },
        ],
        max_tokens: extractionTokenBudget,
        temperature: 0.2,
      })

      const responseText = response.choices[0].message.content || ""
      return this.normalizeExtractedQuestionInfo(
        this.parseJsonResponse<ExtractedQuestionInfo>(responseText)
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
            temperature: 0.2,
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
      return this.normalizeExtractedQuestionInfo(
        this.parseJsonResponse<ExtractedQuestionInfo>(responseText)
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
      return this.normalizeExtractedQuestionInfo(
        this.parseJsonResponse<ExtractedQuestionInfo>(responseText)
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

    if (this.isOpenAICompatibleProvider(config.apiProvider)) {
      const request = {
        model:
          config.extractionModel ||
          this.getDefaultModelForStage(config.apiProvider, "extractionModel"),
        messages: [
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const,
                text: analyzeInstruction,
              },
              ...optimizedImageDataList.map((data) => ({
                type: "image_url" as const,
                image_url: { url: `data:image/png;base64,${data}` },
              })),
            ],
          },
        ],
        max_tokens: tokenBudget,
        temperature: 0.2,
      }

      let streamedResponseContent = ""

      try {
        const responseStream = await this.openaiClient!.chat.completions.create(
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
        const response = await this.openaiClient!.chat.completions.create(
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
      } catch (parseError) {
        console.warn(
          "Structured fast analyze parsing failed. Falling back to direct text parsing.",
          parseError
        )
      }

      const solution = this.parseDirectAnalyzeTextResponse(responseText)
      const problemInfo = this.normalizeExtractedQuestionInfo({
        question_type: solution.is_code_response ? "coding" : "general",
        problem_statement:
          solution.answer?.trim() ||
          "Visible question or content extracted from the screenshot.",
        sub_questions: [
          solution.answer?.trim() ||
            "Answer the visible question or summarize the visible content.",
        ],
        answer_format: solution.is_code_response ? "code" : "direct_answer",
        key_details: [],
      })

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
            temperature: 0.2,
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
      const promptText = this.buildSolutionPrompt(problemInfo, language);
      const solutionTokenBudget = this.getSolutionTokenBudget(problemInfo)
      const analyzeSolutionModel = this.getAnalyzeSolutionModel(
        config,
        problemInfo
      )

      let responseContent;
      
      if (this.isOpenAICompatibleProvider(config.apiProvider)) {
        const providerLabel = this.getProviderLabel(config.apiProvider);

        if (!this.openaiClient) {
          return {
            success: false,
            error: `${providerLabel} API key not configured. Please check your settings.`
          };
        }
        
        const solutionRequest = {
          model: analyzeSolutionModel,
          messages: [
            {
              role: "system" as const,
              content:
                "You are a high-accuracy assistant for coding, academics, multiple-choice questions, and general problem solving. Return valid JSON only."
            },
            { role: "user" as const, content: promptText }
          ],
          max_tokens: solutionTokenBudget,
          temperature: 0.2
        };

        let streamedResponseContent = "";

        try {
          const solutionStream = await this.openaiClient.chat.completions.create(
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
          const solutionResponse = await this.openaiClient.chat.completions.create(
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
                temperature: 0.2,
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
      
      const formattedResponse = this.normalizeSolutionResponse(
        this.parseJsonResponse<StructuredSolutionResponse>(responseContent),
        problemInfo.question_type
      );

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
    config: ReturnType<typeof configHelper.loadConfig>,
    signal: AbortSignal
  ): Promise<string> {
    const promptText = this.buildLiveInterviewPrompt(
      problemInfo,
      language,
      instructions,
      lastAnswer
    )

    if (this.isOpenAICompatibleProvider(config.apiProvider)) {
      const response = await this.openaiClient!.chat.completions.create({
        model:
          config.solutionModel ||
          this.getDefaultModelForStage(config.apiProvider, "solutionModel"),
        messages: [
          {
            role: "system",
            content:
              "You are a precise live interview assistant. Give the shortest acceptable answer in markdown.",
          },
          {
            role: "user",
            content: promptText,
          },
        ],
        max_tokens: LIVE_INTERVIEW_MAX_TOKENS,
        temperature: 0.2,
      })

      return response.choices[0].message.content || ""
    }

    if (config.apiProvider === "gemini") {
      const response = await axios.default.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${config.solutionModel || "gemini-2.0-flash"}:generateContent?key=${this.geminiApiKey}`,
        {
          contents: [
            {
              role: "user",
              parts: [{ text: promptText }],
            },
          ],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: LIVE_INTERVIEW_MAX_TOKENS,
          },
        },
        { signal }
      )

      const responseData = response.data as GeminiResponse
      if (!responseData.candidates || responseData.candidates.length === 0) {
        throw new Error("Empty response from Gemini API.")
      }

      return (
        responseData.candidates[0].content.parts.find(
          (part) => typeof part.text === "string" && part.text.length > 0
        )?.text || ""
      )
    }

    try {
      const response = await this.anthropicClient!.messages.create({
        model:
          config.solutionModel ||
          this.getDefaultModelForStage(config.apiProvider, "solutionModel"),
        max_tokens: LIVE_INTERVIEW_MAX_TOKENS,
        temperature: 0.2,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text" as const,
                text: promptText,
              },
            ],
          },
        ],
      })

      const textBlock = response.content.find(
        (entry) => entry.type === "text"
      ) as { text?: string } | undefined

      return textBlock?.text || ""
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

  private async generateLiveAudioInterviewAnswer(
    transcript: string,
    language: string,
    instructions: string[],
    lastAnswer: string,
    config: ReturnType<typeof configHelper.loadConfig>,
    signal: AbortSignal
  ): Promise<string> {
    const promptText = this.buildLiveAudioInterviewPrompt(
      transcript,
      language,
      instructions,
      lastAnswer
    )

    if (this.isOpenAICompatibleProvider(config.apiProvider)) {
      const response = await this.openaiClient!.chat.completions.create({
        model:
          config.solutionModel ||
          this.getDefaultModelForStage(config.apiProvider, "solutionModel"),
        messages: [
          {
            role: "system",
            content:
              "You are a precise live interview assistant. Give the shortest acceptable answer in markdown.",
          },
          {
            role: "user",
            content: promptText,
          },
        ],
        max_tokens: LIVE_AUDIO_INTERVIEW_MAX_TOKENS,
        temperature: 0.2,
      })

      return response.choices[0].message.content || ""
    }

    if (config.apiProvider === "gemini") {
      const response = await axios.default.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${config.solutionModel || "gemini-2.0-flash"}:generateContent?key=${this.geminiApiKey}`,
        {
          contents: [
            {
              role: "user",
              parts: [{ text: promptText }],
            },
          ],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: LIVE_AUDIO_INTERVIEW_MAX_TOKENS,
          },
        },
        { signal }
      )

      const responseData = response.data as GeminiResponse
      if (!responseData.candidates || responseData.candidates.length === 0) {
        throw new Error("Empty response from Gemini API.")
      }

      return (
        responseData.candidates[0].content.parts.find(
          (part) => typeof part.text === "string" && part.text.length > 0
        )?.text || ""
      )
    }

    try {
      const response = await this.anthropicClient!.messages.create({
        model:
          config.solutionModel ||
          this.getDefaultModelForStage(config.apiProvider, "solutionModel"),
        max_tokens: LIVE_AUDIO_INTERVIEW_MAX_TOKENS,
        temperature: 0.2,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text" as const,
                text: promptText,
              },
            ],
          },
        ],
      })

      const textBlock = response.content.find(
        (entry) => entry.type === "text"
      ) as { text?: string } | undefined

      return textBlock?.text || ""
    } catch (error: any) {
      if (error?.status === 429) {
        throw new Error(
          "Claude API rate limit exceeded. Please wait a few minutes before trying again."
        )
      }

      throw error
    }
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
    const config = configHelper.loadConfig()

    this.currentLiveProcessingAbortController?.abort()
    const abortController = new AbortController()
    this.currentLiveProcessingAbortController = abortController
    const signal = abortController.signal

    try {
      this.ensureConfiguredProvider(config)
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

      const problemInfo = await this.extractQuestionInfoFromImageData(
        [screenCapture.data],
        language,
        config,
        signal
      )
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
          config,
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
    const config = configHelper.loadConfig()

    this.currentLiveProcessingAbortController?.abort()
    const abortController = new AbortController()
    this.currentLiveProcessingAbortController = abortController
    const signal = abortController.signal

    try {
      this.ensureConfiguredProvider(config)
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
          config,
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

    const client = this.getLiveAudioTranscriptionClient()
    const file = await toFile(
      audioBuffer,
      `live-interview.${this.getAudioExtension(mimeType)}`,
      {
        type: mimeType || "audio/webm",
      }
    )

    const response = await client.audio.transcriptions.create({
      file,
      model: LIVE_AUDIO_TRANSCRIPTION_MODEL,
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
      : [];
    const originalProblemStatement = (problemInfo.problem_statement || "").trim();
    const contentSummary = (problemInfo.content_summary || "").trim();

    const normalizedProblemStatement =
      originalProblemStatement ||
      this.buildFallbackProblemStatement(
        problemInfo,
        subQuestions,
        contentSummary
      );
    const isSummaryFallback =
      Boolean(contentSummary) ||
      (!originalProblemStatement &&
        subQuestions.length === 0 &&
        Boolean(normalizedProblemStatement));

    return {
      question_type:
        isSummaryFallback ? "general" : problemInfo.question_type || "general",
      problem_statement: normalizedProblemStatement,
      content_summary: contentSummary,
      sub_questions:
        subQuestions.length > 0
          ? subQuestions
          : isSummaryFallback
          ? ["Summarize the visible content from the screenshots and highlight the key points."]
          : normalizedProblemStatement
          ? [normalizedProblemStatement]
          : [],
      constraints: problemInfo.constraints || "",
      example_input: problemInfo.example_input || "",
      example_output: problemInfo.example_output || "",
      answer_choices: Array.isArray(problemInfo.answer_choices)
        ? problemInfo.answer_choices.filter(Boolean)
        : [],
      subject: problemInfo.subject || "",
      answer_format:
        (problemInfo.answer_format || "").trim() ||
        (isSummaryFallback ? "summary" : ""),
      existing_work: problemInfo.existing_work || "",
      key_details: Array.isArray(problemInfo.key_details)
        ? problemInfo.key_details.filter(Boolean)
        : [],
    };
  }

  private normalizeSolutionResponse(
    response: Partial<StructuredSolutionResponse>,
    fallbackQuestionType: string | undefined
  ) {
    const questionType = response.question_type || fallbackQuestionType || "general";
    const answer = (response.answer || "").trim();
    const code = (response.code || "").trim();
    const isCodeResponse = response.is_code_response ?? Boolean(code);
    const primaryContent = answer || code;
    const defaultThought =
      questionType === "coding"
        ? "Solution approach based on correctness, efficiency, and edge cases"
        : "Answer based on the key facts and reasoning visible in the screenshots";
    const normalizedPrimaryContent = this.normalizeThoughtText(primaryContent);
    const distinctThoughts = Array.isArray(response.thoughts)
      ? response.thoughts
          .filter((thought): thought is string => typeof thought === "string")
          .map((thought) => thought.trim())
          .filter(Boolean)
          .filter((thought) => this.normalizeThoughtText(thought) !== normalizedPrimaryContent)
      : [];

    return {
      question_type: questionType,
      is_code_response: isCodeResponse,
      answer: answer || code,
      code: isCodeResponse ? code || answer : answer || code,
      thoughts: distinctThoughts.length > 0 ? distinctThoughts : [defaultThought],
      time_complexity:
        response.time_complexity ||
        (questionType === "coding"
          ? "Complexity not provided."
          : "N/A - Not applicable"),
      space_complexity:
        response.space_complexity ||
        (questionType === "coding"
          ? "Complexity not provided."
          : "N/A - Not applicable"),
    };
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
              config.apiProvider === "together" ? TOGETHER_BASE_URL : undefined,
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
    if (this.isOpenAICompatibleProvider(config.apiProvider) && !this.openaiClient) {
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
          console.log("Processing failed:", result.error)
          const errorText = result.error?.toLowerCase() || "";
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
              result.error
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
        const analyzeResult = await this.generateFastAnalyzeFromImageData(
          imageDataList,
          language,
          config,
          signal
        );
        const problemInfo = analyzeResult.problemInfo
        let finalSolution = analyzeResult.solution

        if (!problemInfo.problem_statement) {
          return {
            success: false,
            error:
              "Failed to identify any usable content from the screenshots. Try clearer screenshots or include more of the visible content."
          };
        }

        // Store problem info in AppState
        this.deps.setProblemInfo(problemInfo);

        if (
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
            finalSolution
          )
        }

        return { success: true, data: finalSolution };
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
      
      if (this.isOpenAICompatibleProvider(config.apiProvider)) {
        const providerLabel = this.getProviderLabel(config.apiProvider);

        if (!this.openaiClient) {
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
                image_url: { url: `data:image/png;base64,${data}` }
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

        const debugResponse = await this.openaiClient.chat.completions.create({
          model:
            config.debuggingModel ||
            this.getDefaultModelForStage(config.apiProvider, "debuggingModel"),
          messages: messages,
          max_tokens: 4000,
          temperature: 0.2
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
                temperature: 0.2,
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

      const bulletPoints = formattedDebugContent.match(/(?:^|\n)[ ]*(?:[-*•]|\d+\.)[ ]+([^\n]+)/g);
      const thoughts = bulletPoints 
        ? bulletPoints.map(point => point.replace(/^[ ]*(?:[-*•]|\d+\.)[ ]+/, '').trim()).slice(0, 5)
        : ["Debug analysis based on your screenshots"];
      
      const response = {
        code: extractedCode,
        debug_analysis: formattedDebugContent,
        thoughts: thoughts,
        time_complexity: "N/A - Debug mode",
        space_complexity: "N/A - Debug mode"
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
    const config = configHelper.loadConfig()
    const mainWindow = this.deps.getMainWindow()

    this.currentExtraProcessingAbortController?.abort()
    const abortController = new AbortController()
    this.currentExtraProcessingAbortController = abortController
    const signal = abortController.signal

    try {
      const shouldCaptureScreen = this.shouldCaptureScreenContext(mode, message)
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

      const prompt = screenCapture
        ? this.buildScreenAwareGeneralPrompt(language, request)
        : this.buildTextFollowUpPrompt(
            normalizedProblemInfo,
            language,
            request
          )

      let reply = ""

      if (this.isOpenAICompatibleProvider(config.apiProvider)) {
        const providerLabel = this.getProviderLabel(config.apiProvider)

        if (!this.openaiClient) {
          return {
            success: false,
            error: `${providerLabel} API key not configured. Please check your settings.`,
          }
        }

        const selectedModel = screenCapture
          ? config.extractionModel ||
            this.getDefaultModelForStage(config.apiProvider, "extractionModel")
          : mode === "general"
          ? config.solutionModel ||
            this.getDefaultModelForStage(config.apiProvider, "solutionModel")
          : config.debuggingModel ||
            this.getDefaultModelForStage(config.apiProvider, "debuggingModel")

        const baseRequest = {
          model: selectedModel,
          messages: [
            {
              role: "system" as const,
              content:
                mode === "general"
                  ? "You are a precise, practical desktop AI assistant."
                  : "You are a precise follow-up assistant for coding, academic, MCQ, and general reasoning questions.",
            },
            {
              role: "user" as const,
              content: screenCapture
                ? [
                    {
                      type: "text" as const,
                      text: prompt,
                    },
                    {
                      type: "image_url" as const,
                      image_url: {
                        url: `data:image/png;base64,${screenCapture.data}`,
                      },
                    },
                  ]
                : prompt,
            },
          ],
          max_tokens: 2200,
          temperature: 0.2,
        }

        if (options.onStream) {
          try {
            const stream = await this.openaiClient.chat.completions.create(
              {
                ...baseRequest,
                stream: true,
              },
              { signal }
            )

            let streamedReply = ""

            for await (const chunk of stream) {
              if (signal.aborted) {
                break
              }

              const deltaText = chunk.choices?.[0]?.delta?.content
              if (typeof deltaText === "string" && deltaText.length > 0) {
                streamedReply += deltaText
                options.onStream(streamedReply)
              }
            }

            reply = streamedReply
          } catch (streamError) {
            if (axios.isCancel(streamError)) {
              throw streamError
            }

            console.warn(
              "Falling back to non-streaming follow-up response.",
              streamError
            )
          }
        }

        if (!reply.trim()) {
          const response = await this.openaiClient.chat.completions.create(
            baseRequest,
            { signal }
          )

          reply = response.choices[0].message.content || ""
        }
      } else if (config.apiProvider === "gemini") {
        if (!this.geminiApiKey) {
          return {
            success: false,
            error: "Gemini API key not configured. Please check your settings.",
          }
        }

        const selectedModel = screenCapture
          ? config.extractionModel || "gemini-2.0-flash"
          : mode === "general"
          ? config.solutionModel || "gemini-2.0-flash"
          : config.debuggingModel || "gemini-2.0-flash"

        const response = await axios.default.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${this.geminiApiKey}`,
          {
            contents: [
              {
                role: "user",
                parts: screenCapture
                  ? [
                      { text: prompt },
                      {
                        inlineData: {
                          mimeType: "image/png",
                          data: screenCapture.data,
                        },
                      },
                    ]
                  : [{ text: prompt }],
              },
            ],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 2200,
            },
          },
          { signal }
        )

        const responseData = response.data as GeminiResponse
        if (!responseData.candidates || responseData.candidates.length === 0) {
          return {
            success: false,
            error: "Empty response from Gemini API.",
          }
        }

        reply =
          responseData.candidates[0].content.parts.find(
            (part) => typeof part.text === "string" && part.text.length > 0
          )?.text || ""
      } else if (config.apiProvider === "anthropic") {
        if (!this.anthropicClient) {
          return {
            success: false,
            error: "Anthropic API key not configured. Please check your settings.",
          }
        }

        const selectedModel = screenCapture
          ? config.extractionModel ||
            this.getDefaultModelForStage(config.apiProvider, "extractionModel")
          : mode === "general"
          ? config.solutionModel ||
            this.getDefaultModelForStage(
              config.apiProvider,
              "solutionModel"
            )
          : config.debuggingModel ||
            this.getDefaultModelForStage(
              config.apiProvider,
              "debuggingModel"
            )

        const response = await this.anthropicClient.messages.create({
          model: selectedModel,
          max_tokens: 2200,
          temperature: 0.2,
          messages: [
            {
              role: "user",
              content: screenCapture
                ? [
                    {
                      type: "text" as const,
                      text: prompt,
                    },
                    {
                      type: "image" as const,
                      source: {
                        type: "base64" as const,
                        media_type: "image/png" as const,
                        data: screenCapture.data,
                      },
                    },
                  ]
                : [
                    {
                      type: "text" as const,
                      text: prompt,
                    },
                  ],
            },
          ],
        })

        const textBlock = response.content.find(
          (entry) => entry.type === "text"
        ) as { text?: string } | undefined
        reply = textBlock?.text || ""
      }

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
