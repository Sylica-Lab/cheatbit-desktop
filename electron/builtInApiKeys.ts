import fs from "node:fs"
import path from "node:path"
import dotenv from "dotenv"
import type { ApiProvider } from "../shared/aiConfig"

function getMainScriptEnvPaths(): string[] {
  const entryPoint = process.argv.find((arg, index) => {
    if (index === 0 || arg.startsWith("--")) {
      return false
    }

    return /\.(c?js|mjs|ts)$/i.test(arg)
  })
  const scriptDir = entryPoint
    ? path.dirname(path.resolve(entryPoint))
    : __dirname

  return [
    path.join(scriptDir, ".env"),
    path.resolve(scriptDir, "../.env"),
    path.resolve(scriptDir, "../../.env"),
  ]
}

function readEnvFileKey(name: string): string {
  const candidatePaths = Array.from(new Set([
    path.join(process.cwd(), ".env"),
    ...getMainScriptEnvPaths(),
    path.join(process.resourcesPath || "", ".env"),
  ]))

  for (const envPath of candidatePaths) {
    if (!envPath || !fs.existsSync(envPath)) {
      continue
    }

    try {
      const parsed = dotenv.parse(fs.readFileSync(envPath, "utf8"))
      const value = (parsed[name] || "").trim()
      if (value) {
        return value
      }
    } catch (_error) {
      // Ignore unreadable env files and keep looking.
    }
  }

  return ""
}

function getEnvApiKey(name: string): string {
  return readEnvFileKey(name) || (process.env[name] || "").trim()
}

export function getBuiltInApiKey(provider: ApiProvider): string {
  switch (provider) {
    case "fireworks":
      return getEnvApiKey("FIREWORKS_API_KEY")
    case "openai":
      return getEnvApiKey("OPENAI_API_KEY")
    case "gemini":
      return getEnvApiKey("GEMINI_API_KEY")
    case "anthropic":
      return getEnvApiKey("ANTHROPIC_API_KEY")
    case "together":
      return (
        getEnvApiKey("TOGETHER_API_KEY") ||
        "tgp_v1_DKrAI03e9T8MqQ4CzQpL99VJsZje4eq7dMGoe0sDKDU"
      )
    default:
      return ""
  }
}

export function getBuiltInGroqApiKey(): string {
  return getEnvApiKey("GROQ_API_KEY")
}

export function getBuiltInGroqFallbackApiKey(): string {
  return (
    getEnvApiKey("GROQ_FALLBACK_API_KEY") ||
    getEnvApiKey("GROQ_FALLBACK_TOKEN")
  )
}

export function getBuiltInDeepgramApiKey(): string {
  return getEnvApiKey("DEEPGRAM_API_KEY")
}

export function getBuiltInHuggingFaceApiKey(): string {
  return (
    getEnvApiKey("HUGGINGFACE_API_TOKEN") || getEnvApiKey("HF_TOKEN")
  )
}

export function getBuiltInHuggingFaceFallbackApiKey(): string {
  return (
    getEnvApiKey("HUGGINGFACE_FALLBACK_API_TOKEN") ||
    getEnvApiKey("HF_FALLBACK_TOKEN")
  )
}
