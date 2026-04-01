import type { ApiProvider } from "../shared/aiConfig"

// Add the provider keys you want to ship here.
// Leave providers you do not use as empty strings.
export const BUILT_IN_API_KEYS: Record<ApiProvider, string> = {
  openai: "",
  gemini: "",
  anthropic: "",
  together: "tgp_v1_DKrAI03e9T8MqQ4CzQpL99VJsZje4eq7dMGoe0sDKDU"
}

export function getBuiltInApiKey(provider: ApiProvider): string {
  return BUILT_IN_API_KEYS[provider].trim()
}
