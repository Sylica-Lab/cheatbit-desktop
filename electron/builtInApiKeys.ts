import type { ApiProvider } from "../shared/aiConfig"

// Add the provider keys you want to ship here.
// Leave providers you do not use as empty strings.
export const BUILT_IN_API_KEYS: Record<ApiProvider, string> = {
  openai: "",
  gemini: "",
  anthropic: "",
  together: "tgp_v1_JRv_8uhaM0eIEVjfh0NeapgsPToxrlNxkAlr1rKkQCw"
}

export function getBuiltInApiKey(provider: ApiProvider): string {
  return BUILT_IN_API_KEYS[provider].trim()
}
