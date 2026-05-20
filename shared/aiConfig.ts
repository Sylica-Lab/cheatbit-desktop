export type ApiProvider =
  | "fireworks"
  | "openai"
  | "gemini"
  | "anthropic"
  | "together";

export type ModelCategoryKey =
  | "extractionModel"
  | "solutionModel"
  | "debuggingModel";

export interface AIModel {
  id: string;
  name: string;
  description: string;
}

export interface AppConfig {
  apiKey: string;
  apiKeys?: Partial<Record<ApiProvider, string>>;
  configuredApiProviders?: ApiProvider[];
  apiProvider: ApiProvider;
  extractionModel: string;
  solutionModel: string;
  debuggingModel: string;
  language: string;
  opacity: number;
  widgetScale?: number;
  // When true, the Sylica window is captured by screen recordings/screenshots.
  // Default is false (stealth mode) so the app stays invisible to capture.
  // Toggle to true for live demos / YC recordings.
  screenRecordingVisible?: boolean;
  guideCursorEnabled?: boolean;
}

export const DEFAULT_WIDGET_SCALE = 0.6;
export const MIN_WIDGET_SCALE = 0.6;
export const MAX_WIDGET_SCALE = 1.4;

export function normalizeWidgetScale(value: unknown): number {
  const scale = Number(value);
  if (!Number.isFinite(scale)) {
    return DEFAULT_WIDGET_SCALE;
  }

  return Math.min(MAX_WIDGET_SCALE, Math.max(MIN_WIDGET_SCALE, scale));
}

export const DEFAULT_PROVIDER: ApiProvider = "openai";

export const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
export const HUGGINGFACE_BASE_URL = "https://router.huggingface.co/v1";
export const TOGETHER_BASE_URL = "https://api.together.xyz/v1";
export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
export const FIREWORKS_KIMI_MODEL = "accounts/fireworks/models/kimi-k2p6";
export const FIREWORKS_KIMI_VISION_FALLBACK_MODEL =
  "accounts/fireworks/models/kimi-k2p5";
export const HUGGINGFACE_SCREEN_ANALYSIS_MODEL = "moonshotai/Kimi-K2.5";
export const GROQ_VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
export const LEGACY_TOGETHER_VISION_MODEL = "Qwen/Qwen3-VL-8B-Instruct";
export const TOGETHER_VISION_MODEL = "Qwen/Qwen3.5-9B";
export const TOGETHER_VISION_ACCURACY_MODEL = "Qwen/Qwen3.5-397B-A17B";
export const TOGETHER_VISION_REASONING_MODEL = "moonshotai/Kimi-K2.5";
export const TOGETHER_CODER_MODEL = "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8";
export const TOGETHER_GENERAL_MODEL = "moonshotai/Kimi-K2.5";
export const GROQ_CHAT_MODEL = "llama-3.3-70b-versatile";
export const GROQ_AUDIO_TRANSCRIPTION_MODEL = "whisper-large-v3-turbo";

export const PROVIDER_DISPLAY_NAMES: Record<ApiProvider, string> = {
  fireworks: "Fireworks",
  openai: "OpenAI",
  gemini: "Gemini",
  anthropic: "Anthropic",
  together: "Together AI",
};

export const PROVIDER_CARD_TITLES: Record<ApiProvider, string> = {
  fireworks: "Fireworks",
  openai: "OpenAI",
  gemini: "Gemini",
  anthropic: "Claude",
  together: "Together AI",
};

export const PROVIDER_CARD_DESCRIPTIONS: Record<ApiProvider, string> = {
  fireworks: "Direct Fireworks Kimi multimodal models",
  openai: "GPT-4o models",
  gemini: "Gemini 1.5 and 2.0 models",
  anthropic: "Claude 3 models",
  together: "Fast vision, reasoning, and coding models",
};

export const PROVIDER_KEY_LABELS: Record<ApiProvider, string> = {
  fireworks: "Fireworks API Key",
  openai: "OpenAI API Key",
  gemini: "Gemini API Key",
  anthropic: "Anthropic API Key",
  together: "Together AI API Key",
};

export const PROVIDER_KEY_PLACEHOLDERS: Record<ApiProvider, string> = {
  fireworks: "fw_...",
  openai: "sk-...",
  gemini: "Enter your Gemini API key",
  anthropic: "sk-ant-...",
  together: "Enter your Together AI API key",
};

export const PROVIDER_PRIVACY_LABELS: Record<ApiProvider, string> = {
  fireworks: "Fireworks",
  openai: "OpenAI",
  gemini: "Google",
  anthropic: "Anthropic",
  together: "Together AI",
};

export const PROVIDER_SIGNUP_URLS: Record<ApiProvider, string> = {
  fireworks: "https://app.fireworks.ai/",
  openai: "https://platform.openai.com/signup",
  gemini: "https://aistudio.google.com/",
  anthropic: "https://console.anthropic.com/signup",
  together: "https://api.together.ai/",
};

export const PROVIDER_KEY_URLS: Record<ApiProvider, string> = {
  fireworks: "https://app.fireworks.ai/api-keys",
  openai: "https://platform.openai.com/api-keys",
  gemini: "https://aistudio.google.com/app/apikey",
  anthropic: "https://console.anthropic.com/settings/keys",
  together: "https://api.together.ai/settings/api-keys",
};

export const PROVIDER_ORDER: ApiProvider[] = [
  "fireworks",
  "together",
  "openai",
  "gemini",
  "anthropic",
];

export const MODEL_CATEGORIES: Array<{
  key: ModelCategoryKey;
  title: string;
  description: string;
}> = [
  {
    key: "extractionModel",
    title: "Problem Extraction",
    description: "Model used to analyze screenshots and extract problem details",
  },
  {
    key: "solutionModel",
    title: "Solution Generation",
    description: "Model used to generate coding solutions",
  },
  {
    key: "debuggingModel",
    title: "Debugging",
    description: "Model used to debug and improve solutions",
  },
];

export const MODEL_OPTIONS: Record<
  ApiProvider,
  Record<ModelCategoryKey, AIModel[]>
> = {
  fireworks: {
    extractionModel: [
      {
        id: FIREWORKS_KIMI_MODEL,
        name: "Kimi K2.6",
        description: "Direct Fireworks Kimi model for high-quality screenshot understanding",
      },
      {
        id: FIREWORKS_KIMI_VISION_FALLBACK_MODEL,
        name: "Kimi K2.5",
        description: "Known Fireworks multimodal fallback for image-heavy screenshot extraction",
      },
    ],
    solutionModel: [
      {
        id: FIREWORKS_KIMI_MODEL,
        name: "Kimi K2.6",
        description: "Direct Fireworks Kimi model for stronger reasoning and coding output",
      },
      {
        id: FIREWORKS_KIMI_VISION_FALLBACK_MODEL,
        name: "Kimi K2.5",
        description: "Fallback Fireworks Kimi option when you want the same family across all stages",
      },
    ],
    debuggingModel: [
      {
        id: FIREWORKS_KIMI_MODEL,
        name: "Kimi K2.6",
        description: "Direct Fireworks Kimi model for screenshot debugging and fix suggestions",
      },
      {
        id: FIREWORKS_KIMI_VISION_FALLBACK_MODEL,
        name: "Kimi K2.5",
        description: "Known Fireworks multimodal fallback for harder visual debugging inputs",
      },
    ],
  },
  openai: {
    extractionModel: [
      {
        id: "gpt-5.5",
        name: "gpt-5.5",
        description: "Advanced high-accuracy model for OCR-heavy screenshot extraction",
      },
      {
        id: "gpt-4.1",
        name: "gpt-4.1",
        description: "Strong vision fallback for screenshot extraction",
      },
      {
        id: "gpt-4o",
        name: "gpt-4o",
        description: "Balanced vision model for problem extraction",
      },
      {
        id: "gpt-4o-mini",
        name: "gpt-4o-mini",
        description: "Faster, more cost-effective option",
      },
    ],
    solutionModel: [
      {
        id: "gpt-5.4",
        name: "gpt-5.4",
        description: "Reliable high-accuracy model for math and reasoning answers",
      },
      {
        id: "gpt-5.5",
        name: "gpt-5.5",
        description: "Advanced model, kept as an optional fallback",
      },
      {
        id: "gpt-4.1",
        name: "gpt-4.1",
        description: "Strong fallback for coding and reasoning tasks",
      },
      {
        id: "gpt-4o",
        name: "gpt-4o",
        description: "Strong overall performance for coding tasks",
      },
      {
        id: "gpt-4o-mini",
        name: "gpt-4o-mini",
        description: "Faster, more cost-effective option",
      },
    ],
    debuggingModel: [
      {
        id: "gpt-5.4",
        name: "gpt-5.4",
        description: "Reliable high-accuracy model for debugging and math-heavy analysis",
      },
      {
        id: "gpt-5.5",
        name: "gpt-5.5",
        description: "Advanced model, kept as an optional fallback",
      },
      {
        id: "gpt-4.1",
        name: "gpt-4.1",
        description: "Strong fallback for debugging screenshots and code",
      },
      {
        id: "gpt-4o",
        name: "gpt-4o",
        description: "Best for analyzing code and error messages",
      },
      {
        id: "gpt-4o-mini",
        name: "gpt-4o-mini",
        description: "Faster, more cost-effective option",
      },
    ],
  },
  gemini: {
    extractionModel: [
      {
        id: "gemini-1.5-pro",
        name: "Gemini 1.5 Pro",
        description: "Best overall performance for problem extraction",
      },
      {
        id: "gemini-2.0-flash",
        name: "Gemini 2.0 Flash",
        description: "Faster, more cost-effective option",
      },
    ],
    solutionModel: [
      {
        id: "gemini-1.5-pro",
        name: "Gemini 1.5 Pro",
        description: "Strong overall performance for coding tasks",
      },
      {
        id: "gemini-2.0-flash",
        name: "Gemini 2.0 Flash",
        description: "Faster, more cost-effective option",
      },
    ],
    debuggingModel: [
      {
        id: "gemini-1.5-pro",
        name: "Gemini 1.5 Pro",
        description: "Best for analyzing code and error messages",
      },
      {
        id: "gemini-2.0-flash",
        name: "Gemini 2.0 Flash",
        description: "Faster, more cost-effective option",
      },
    ],
  },
  anthropic: {
    extractionModel: [
      {
        id: "claude-3-7-sonnet-20250219",
        name: "Claude 3.7 Sonnet",
        description: "Best overall performance for problem extraction",
      },
      {
        id: "claude-3-5-sonnet-20241022",
        name: "Claude 3.5 Sonnet",
        description: "Balanced performance and speed",
      },
      {
        id: "claude-3-opus-20240229",
        name: "Claude 3 Opus",
        description: "Top-level intelligence, fluency, and understanding",
      },
    ],
    solutionModel: [
      {
        id: "claude-3-7-sonnet-20250219",
        name: "Claude 3.7 Sonnet",
        description: "Strong overall performance for coding tasks",
      },
      {
        id: "claude-3-5-sonnet-20241022",
        name: "Claude 3.5 Sonnet",
        description: "Balanced performance and speed",
      },
      {
        id: "claude-3-opus-20240229",
        name: "Claude 3 Opus",
        description: "Top-level intelligence, fluency, and understanding",
      },
    ],
    debuggingModel: [
      {
        id: "claude-3-7-sonnet-20250219",
        name: "Claude 3.7 Sonnet",
        description: "Best for analyzing code and error messages",
      },
      {
        id: "claude-3-5-sonnet-20241022",
        name: "Claude 3.5 Sonnet",
        description: "Balanced performance and speed",
      },
      {
        id: "claude-3-opus-20240229",
        name: "Claude 3 Opus",
        description: "Top-level intelligence, fluency, and understanding",
      },
    ],
  },
  together: {
    extractionModel: [
      {
        id: LEGACY_TOGETHER_VISION_MODEL,
        name: "Qwen3 VL 8B (Legacy)",
        description: "Legacy stored setting kept only for config compatibility",
      },
      {
        id: TOGETHER_VISION_MODEL,
        name: "Qwen3.5 9B",
        description: "Fast Together vision default for screenshot extraction",
      },
      {
        id: TOGETHER_VISION_REASONING_MODEL,
        name: "Kimi K2.5",
        description: "Best overall Together vision option for harder screenshots",
      },
      {
        id: TOGETHER_VISION_ACCURACY_MODEL,
        name: "Qwen3.5 397B A17B",
        description: "Largest Together vision option when accuracy matters more than speed",
      },
    ],
    solutionModel: [
      {
        id: TOGETHER_CODER_MODEL,
        name: "Qwen3 Coder 480B A35B",
        description: "Best Together option here for pure coding generation",
      },
      {
        id: TOGETHER_GENERAL_MODEL,
        name: "Kimi K2.5",
        description: "Best overall Together reasoning alternative",
      },
    ],
    debuggingModel: [
      {
        id: LEGACY_TOGETHER_VISION_MODEL,
        name: "Qwen3 VL 8B (Legacy)",
        description: "Legacy stored setting kept only for config compatibility",
      },
      {
        id: TOGETHER_VISION_MODEL,
        name: "Qwen3.5 9B",
        description: "Fast Together vision default for screenshot debugging",
      },
      {
        id: TOGETHER_VISION_REASONING_MODEL,
        name: "Kimi K2.5",
        description: "Best overall Together vision option for harder debugging screenshots",
      },
      {
        id: TOGETHER_VISION_ACCURACY_MODEL,
        name: "Qwen3.5 397B A17B",
        description: "Largest Together vision option when debugging accuracy matters more than speed",
      },
    ],
  },
};

export const DEFAULT_MODELS: Record<ApiProvider, Record<ModelCategoryKey, string>> = {
  fireworks: {
    extractionModel: FIREWORKS_KIMI_MODEL,
    solutionModel: FIREWORKS_KIMI_MODEL,
    debuggingModel: FIREWORKS_KIMI_MODEL,
  },
  openai: {
    extractionModel: "gpt-4.1",
    solutionModel: "gpt-5.4",
    debuggingModel: "gpt-5.4",
  },
  gemini: {
    extractionModel: "gemini-2.0-flash",
    solutionModel: "gemini-2.0-flash",
    debuggingModel: "gemini-2.0-flash",
  },
  anthropic: {
    extractionModel: "claude-3-7-sonnet-20250219",
    solutionModel: "claude-3-7-sonnet-20250219",
    debuggingModel: "claude-3-7-sonnet-20250219",
  },
  together: {
    extractionModel: TOGETHER_VISION_MODEL,
    solutionModel: TOGETHER_CODER_MODEL,
    debuggingModel: TOGETHER_VISION_MODEL,
  },
};

export function isValidProvider(value: string): value is ApiProvider {
  return PROVIDER_ORDER.includes(value as ApiProvider);
}

export function getDefaultModel(
  provider: ApiProvider,
  category: ModelCategoryKey
): string {
  return DEFAULT_MODELS[provider][category];
}

export function sanitizeModelSelection(
  provider: ApiProvider,
  category: ModelCategoryKey,
  model: string
): string {
  const allowedModels = MODEL_OPTIONS[provider][category].map(({ id }) => id);
  const defaultModel = getDefaultModel(provider, category);

  if (!allowedModels.includes(model)) {
    console.warn(
      `Invalid ${PROVIDER_DISPLAY_NAMES[provider]} model specified for ${category}: ${model}. Using default model: ${defaultModel}`
    );
    return defaultModel;
  }

  return model;
}
