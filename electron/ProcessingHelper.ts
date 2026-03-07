// ProcessingHelper.ts
import fs from "node:fs"
import { ScreenshotHelper } from "./ScreenshotHelper"
import { IProcessingHelperDeps } from "./main"
import * as axios from "axios"
import { BrowserWindow } from "electron"
import { OpenAI } from "openai"
import { configHelper } from "./ConfigHelper"
import Anthropic from '@anthropic-ai/sdk';
import {
  type ApiProvider,
  DEFAULT_MODELS,
  PROVIDER_DISPLAY_NAMES,
  TOGETHER_BASE_URL,
} from "../shared/aiConfig"
import type {
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

export class ProcessingHelper {
  private deps: IProcessingHelperDeps
  private screenshotHelper: ScreenshotHelper
  private openaiClient: OpenAI | null = null
  private geminiApiKey: string | null = null
  private anthropicClient: Anthropic | null = null

  // AbortControllers for API requests
  private currentProcessingAbortController: AbortController | null = null
  private currentExtraProcessingAbortController: AbortController | null = null

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

  private getDefaultModelForStage(
    provider: ApiProvider,
    stage: "extractionModel" | "solutionModel" | "debuggingModel"
  ): string {
    return DEFAULT_MODELS[provider][stage];
  }

  private stripCodeFences(text: string): string {
    return text.replace(/```json|```/g, "").trim();
  }

  private parseJsonResponse<T>(text: string): T {
    return JSON.parse(this.stripCodeFences(text)) as T;
  }

  private buildExtractionInstruction(language: string): string {
    return `You analyze screenshots that may contain coding challenges, academic questions, multiple-choice questions, or general reasoning prompts.

Return only valid JSON with these fields:
- question_type: one of "coding", "mcq", "academic", or "general"
- problem_statement: the full combined prompt/question text in plain text, covering ALL visible questions, sub-questions, and requested tasks in top-to-bottom order
- sub_questions: array of strings listing every distinct visible question, sub-question, or requested task in order
- constraints: string
- example_input: string
- example_output: string
- answer_choices: array of strings for MCQs, otherwise []
- subject: string
- answer_format: string describing what kind of answer is expected
- existing_work: string with any visible attempt, notes, or partial answer
- key_details: array of short strings with important facts, formulas, instructions, or hints

Rules:
- Preserve the wording from the screenshots as accurately as possible.
- If a field is missing, use an empty string or [].
- If multiple questions or sub-parts are visible, include all of them. Never return only the first one.
- Do not collapse numbered or lettered sub-parts into a single shortened summary.
- If the screenshots show code, keep the question_type as "coding".
- Preferred coding language for coding tasks is ${language}.
- Return JSON only with no markdown or extra commentary.`;
  }

  private buildSolutionPrompt(
    problemInfo: ExtractedQuestionInfo,
    language: string
  ): string {
    const subQuestions =
      problemInfo.sub_questions && problemInfo.sub_questions.length > 0
        ? problemInfo.sub_questions
            .map((question, index) => `${index + 1}. ${question}`)
            .join("\n")
        : "1. Treat the visible prompt as a single question.";
    const answerChoices =
      problemInfo.answer_choices && problemInfo.answer_choices.length > 0
        ? problemInfo.answer_choices.join("\n")
        : "None";
    const keyDetails =
      problemInfo.key_details && problemInfo.key_details.length > 0
        ? problemInfo.key_details.join("\n- ")
        : "None";

    return `Solve the following prompt. It may be a coding problem, academic question, MCQ, or general reasoning task.
You must answer every visible question or sub-question from the screenshots, not just the first one.

QUESTION TYPE:
${problemInfo.question_type || "general"}

PROMPT / QUESTION:
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
- For coding tasks: provide a correct, efficient implementation in ${language}, set is_code_response=true, and include detailed time/space complexity.
- For MCQs: answer directly, identify the best option, explain why, set is_code_response=false, and leave code empty.
- For academic/general tasks: provide a correct direct answer with concise reasoning, set is_code_response=false unless code is genuinely required.
- If multiple distinct questions or sub-parts are present, answer all of them in order and label them clearly.
- Do not skip later questions even if the first question looks like the main one.
- If the screenshots contain multiple independent questions that cannot be represented as one code-only answer, set is_code_response=false and place the full multi-part answer in "answer".
- thoughts must be a short array of practical reasoning points.
- Return JSON only.`;
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

  private normalizeExtractedQuestionInfo(
    problemInfo: Partial<ExtractedQuestionInfo>
  ): ExtractedQuestionInfo {
    const subQuestions = Array.isArray(problemInfo.sub_questions)
      ? problemInfo.sub_questions
          .filter((question): question is string => typeof question === "string")
          .map((question) => question.trim())
          .filter(Boolean)
      : [];

    const normalizedProblemStatement =
      (problemInfo.problem_statement || "").trim() ||
      (subQuestions.length > 0
        ? subQuestions
            .map((question, index) => `${index + 1}. ${question}`)
            .join("\n")
        : "");

    return {
      question_type: problemInfo.question_type || "general",
      problem_statement: normalizedProblemStatement,
      sub_questions:
        subQuestions.length > 0
          ? subQuestions
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
      answer_format: problemInfo.answer_format || "",
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
    const defaultThought =
      questionType === "coding"
        ? "Solution approach based on correctness, efficiency, and edge cases"
        : "Answer based on the key facts and reasoning visible in the screenshots";

    return {
      question_type: questionType,
      is_code_response: isCodeResponse,
      answer: answer || code,
      code: isCodeResponse ? code || answer : answer || code,
      thoughts:
        Array.isArray(response.thoughts) && response.thoughts.length > 0
          ? response.thoughts.filter(Boolean)
          : [defaultThought],
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
                preview: await this.screenshotHelper.getImagePreview(path),
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
                preview: await this.screenshotHelper.getImagePreview(path),
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
          message: "Analyzing screenshots...",
          progress: 20
        });
      }

      let problemInfo: ExtractedQuestionInfo;
      const extractionInstruction = this.buildExtractionInstruction(language);
      
      if (this.isOpenAICompatibleProvider(config.apiProvider)) {
        const providerLabel = this.getProviderLabel(config.apiProvider);

        // Verify OpenAI-compatible client
        if (!this.openaiClient) {
          this.initializeAIClient(); // Try to reinitialize
          
          if (!this.openaiClient) {
            return {
              success: false,
              error: `${providerLabel} API key not configured or invalid. Please check your settings.`
            };
          }
        }

        // Use the OpenAI-compatible chat.completions interface for OpenAI/Together
        const messages = [
          {
            role: "system" as const, 
            content: extractionInstruction
          },
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const, 
                text: "Extract ALL visible question details from these screenshots, including every sub-question or task in order, and return only JSON."
              },
              ...imageDataList.map(data => ({
                type: "image_url" as const,
                image_url: { url: `data:image/png;base64,${data}` }
              }))
            ]
          }
        ];

        // Send to the configured multimodal model
        const extractionResponse = await this.openaiClient.chat.completions.create({
          model:
            config.extractionModel ||
            this.getDefaultModelForStage(config.apiProvider, "extractionModel"),
          messages: messages,
          max_tokens: 4000,
          temperature: 0.2
        });

        // Parse the response
        try {
          const responseText = extractionResponse.choices[0].message.content;
          problemInfo = this.normalizeExtractedQuestionInfo(
            this.parseJsonResponse<ExtractedQuestionInfo>(responseText)
          );
        } catch (error) {
          console.error(`Error parsing ${providerLabel} response:`, error);
          return {
            success: false,
            error: "Failed to parse problem information. Please try again or use clearer screenshots."
          };
        }
      } else if (config.apiProvider === "gemini")  {
        // Use Gemini API
        if (!this.geminiApiKey) {
          return {
            success: false,
            error: "Gemini API key not configured. Please check your settings."
          };
        }

        try {
          // Create Gemini message structure
          const geminiMessages: GeminiMessage[] = [
            {
              role: "user",
              parts: [
                {
                  text: extractionInstruction
                },
                ...imageDataList.map(data => ({
                  inlineData: {
                    mimeType: "image/png",
                    data: data
                  }
                }))
              ]
            }
          ];

          // Make API request to Gemini
          const response = await axios.default.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${config.extractionModel || "gemini-2.0-flash"}:generateContent?key=${this.geminiApiKey}`,
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
          
          const responseText = responseData.candidates[0].content.parts[0].text;
          problemInfo = this.normalizeExtractedQuestionInfo(
            this.parseJsonResponse<ExtractedQuestionInfo>(responseText)
          );
        } catch (error) {
          console.error("Error using Gemini API:", error);
          return {
            success: false,
            error: "Failed to process with Gemini API. Please check your API key or try again later."
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
                  text: extractionInstruction
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

          const response = await this.anthropicClient.messages.create({
            model:
              config.extractionModel ||
              this.getDefaultModelForStage(config.apiProvider, "extractionModel"),
            max_tokens: 4000,
            messages: messages,
            temperature: 0.2
          });

          const responseText = (response.content[0] as { type: 'text', text: string }).text;
          problemInfo = this.normalizeExtractedQuestionInfo(
            this.parseJsonResponse<ExtractedQuestionInfo>(responseText)
          );
        } catch (error: any) {
          console.error("Error using Anthropic API:", error);

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
            error: "Failed to process with Anthropic API. Please check your API key or try again later."
          };
	        }
	      }

      if (!problemInfo.problem_statement) {
        return {
          success: false,
          error: "Failed to identify a usable question from the screenshots. Try clearer screenshots or include more of the prompt."
        };
      }
	      
	      // Update the user on progress
	      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Question analyzed successfully. Preparing the answer...",
          progress: 40
        });
      }

      // Store problem info in AppState
      this.deps.setProblemInfo(problemInfo);

      // Send first success event
      if (mainWindow) {
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.PROBLEM_EXTRACTED,
          problemInfo
        );

        // Generate solutions after successful extraction
        const solutionsResult = await this.generateSolutionsHelper(signal);
        if (solutionsResult.success) {
          // Clear any existing extra screenshots before transitioning to solutions view
          this.screenshotHelper.clearExtraScreenshotQueue();
          
          // Final progress update
          mainWindow.webContents.send("processing-status", {
            message: "Solution generated successfully",
            progress: 100
          });
          
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.SOLUTION_SUCCESS,
            solutionsResult.data
          );
          return { success: true, data: solutionsResult.data };
        } else {
          throw new Error(
            solutionsResult.error || "Failed to generate solutions"
          );
        }
      }

      return { success: false, error: "Failed to process screenshots" };
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
          message: "Creating the best answer or solution...",
          progress: 60
        });
      }

      const promptText = this.buildSolutionPrompt(problemInfo, language);

      let responseContent;
      
      if (this.isOpenAICompatibleProvider(config.apiProvider)) {
        const providerLabel = this.getProviderLabel(config.apiProvider);

        // OpenAI-compatible processing
        if (!this.openaiClient) {
          return {
            success: false,
            error: `${providerLabel} API key not configured. Please check your settings.`
          };
        }
        
        // Send to the configured text model
        const solutionResponse = await this.openaiClient.chat.completions.create({
          model:
            config.solutionModel ||
            this.getDefaultModelForStage(config.apiProvider, "solutionModel"),
          messages: [
            {
              role: "system",
              content:
                "You are a high-accuracy assistant for coding, academics, multiple-choice questions, and general problem solving. Return valid JSON only."
            },
            { role: "user", content: promptText }
          ],
          max_tokens: 4000,
          temperature: 0.2
        });

        responseContent = solutionResponse.choices[0].message.content;
      } else if (config.apiProvider === "gemini")  {
        // Gemini processing
        if (!this.geminiApiKey) {
          return {
            success: false,
            error: "Gemini API key not configured. Please check your settings."
          };
        }
        
        try {
          // Create Gemini message structure
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

          // Make API request to Gemini
          const response = await axios.default.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${config.solutionModel || "gemini-2.0-flash"}:generateContent?key=${this.geminiApiKey}`,
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
          
          responseContent = responseData.candidates[0].content.parts[0].text;
        } catch (error) {
          console.error("Error using Gemini API for solution:", error);
          return {
            success: false,
            error: "Failed to generate solution with Gemini API. Please check your API key or try again later."
          };
        }
      } else if (config.apiProvider === "anthropic") {
        // Anthropic processing
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

          // Send to Anthropic API
          const response = await this.anthropicClient.messages.create({
            model:
              config.solutionModel ||
              this.getDefaultModelForStage(config.apiProvider, "solutionModel"),
            max_tokens: 4000,
            messages: messages,
            temperature: 0.2
          });

          responseContent = (response.content[0] as { type: 'text', text: string }).text;
        } catch (error: any) {
          console.error("Error using Anthropic API for solution:", error);

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
            error: "Failed to generate solution with Anthropic API. Please check your API key or try again later."
          };
        }
      }
      
      const formattedResponse = this.normalizeSolutionResponse(
        this.parseJsonResponse<StructuredSolutionResponse>(responseContent),
        problemInfo.question_type
      );

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
      const imageDataList = screenshots.map(screenshot => screenshot.data);
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
    request: TextFollowUpRequest
  ): Promise<{ success: true; data: TextFollowUpResponse } | { success: false; error: string }> {
    const message = request.message.trim()
    if (!message) {
      return {
        success: false,
        error: "Enter a follow-up question first.",
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
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Generating follow-up response...",
          progress: 55,
        })
      }

      const prompt = this.buildTextFollowUpPrompt(
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

        const response = await this.openaiClient.chat.completions.create({
          model:
            config.debuggingModel ||
            this.getDefaultModelForStage(config.apiProvider, "debuggingModel"),
          messages: [
            {
              role: "system",
              content:
                "You are a precise follow-up assistant for coding, academic, MCQ, and general reasoning questions.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          max_tokens: 2200,
          temperature: 0.2,
        })

        reply = response.choices[0].message.content || ""
      } else if (config.apiProvider === "gemini") {
        if (!this.geminiApiKey) {
          return {
            success: false,
            error: "Gemini API key not configured. Please check your settings.",
          }
        }

        const response = await axios.default.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${
            config.debuggingModel || "gemini-2.0-flash"
          }:generateContent?key=${this.geminiApiKey}`,
          {
            contents: [
              {
                role: "user",
                parts: [{ text: prompt }],
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

        reply = responseData.candidates[0].content.parts[0].text || ""
      } else if (config.apiProvider === "anthropic") {
        if (!this.anthropicClient) {
          return {
            success: false,
            error: "Anthropic API key not configured. Please check your settings.",
          }
        }

        const response = await this.anthropicClient.messages.create({
          model:
            config.debuggingModel ||
            this.getDefaultModelForStage(config.apiProvider, "debuggingModel"),
          max_tokens: 2200,
          temperature: 0.2,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: prompt,
                },
              ],
            },
          ],
        })

        reply = (response.content[0] as { type: "text"; text: string }).text || ""
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

    this.deps.setHasDebugged(false)

    this.deps.setProblemInfo(null)

    const mainWindow = this.deps.getMainWindow()
    if (notifyRenderer && wasCancelled && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS)
    }
  }
}
