export type ApiProvider = "openai" | "gemini" | "anthropic" | "together";

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
  apiProvider: ApiProvider;
  extractionModel: string;
  solutionModel: string;
  debuggingModel: string;
  language: string;
  opacity: number;
}

export const DEFAULT_PROVIDER: ApiProvider = "together";

export const TOGETHER_BASE_URL = "https://api.together.xyz/v1";
export const TOGETHER_VISION_MODEL = "Qwen/Qwen3-VL-8B-Instruct";
export const TOGETHER_CODER_MODEL = "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8";
export const TOGETHER_GENERAL_MODEL = "Qwen/Qwen3-Next-80B-A3B-Instruct";

export const PROVIDER_DISPLAY_NAMES: Record<ApiProvider, string> = {
  openai: "OpenAI",
  gemini: "Gemini",
  anthropic: "Anthropic",
  together: "Together AI",
};

export const PROVIDER_CARD_TITLES: Record<ApiProvider, string> = {
  openai: "OpenAI",
  gemini: "Gemini",
  anthropic: "Claude",
  together: "Together AI",
};

export const PROVIDER_CARD_DESCRIPTIONS: Record<ApiProvider, string> = {
  openai: "GPT-4o models",
  gemini: "Gemini 1.5 and 2.0 models",
  anthropic: "Claude 3 models",
  together: "Qwen vision and coding models",
};

export const PROVIDER_KEY_LABELS: Record<ApiProvider, string> = {
  openai: "OpenAI API Key",
  gemini: "Gemini API Key",
  anthropic: "Anthropic API Key",
  together: "Together AI API Key",
};

export const PROVIDER_KEY_PLACEHOLDERS: Record<ApiProvider, string> = {
  openai: "sk-...",
  gemini: "Enter your Gemini API key",
  anthropic: "sk-ant-...",
  together: "Enter your Together AI API key",
};

export const PROVIDER_PRIVACY_LABELS: Record<ApiProvider, string> = {
  openai: "OpenAI",
  gemini: "Google",
  anthropic: "Anthropic",
  together: "Together AI",
};

export const PROVIDER_SIGNUP_URLS: Record<ApiProvider, string> = {
  openai: "https://platform.openai.com/signup",
  gemini: "https://aistudio.google.com/",
  anthropic: "https://console.anthropic.com/signup",
  together: "https://api.together.ai/",
};

export const PROVIDER_KEY_URLS: Record<ApiProvider, string> = {
  openai: "https://platform.openai.com/api-keys",
  gemini: "https://aistudio.google.com/app/apikey",
  anthropic: "https://console.anthropic.com/settings/keys",
  together: "https://api.together.ai/settings/api-keys",
};

export const PROVIDER_ORDER: ApiProvider[] = [
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
  openai: {
    extractionModel: [
      {
        id: "gpt-4o",
        name: "gpt-4o",
        description: "Best overall performance for problem extraction",
      },
      {
        id: "gpt-4o-mini",
        name: "gpt-4o-mini",
        description: "Faster, more cost-effective option",
      },
    ],
    solutionModel: [
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
        id: TOGETHER_VISION_MODEL,
        name: "Qwen3 VL 8B Instruct",
        description: "Vision-capable Qwen model for screenshot extraction",
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
        name: "Qwen3 Next 80B A3B",
        description: "General-purpose reasoning alternative",
      },
    ],
    debuggingModel: [
      {
        id: TOGETHER_VISION_MODEL,
        name: "Qwen3 VL 8B Instruct",
        description: "Vision-capable Qwen model for screenshot debugging",
      },
    ],
  },
};

export const DEFAULT_MODELS: Record<ApiProvider, Record<ModelCategoryKey, string>> = {
  openai: {
    extractionModel: "gpt-4o",
    solutionModel: "gpt-4o",
    debuggingModel: "gpt-4o",
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
