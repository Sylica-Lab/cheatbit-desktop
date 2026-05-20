export interface ExaSearchOptions {
  force?: boolean
  numResults?: number
  type?: "instant" | "fast" | "auto" | "deep-lite" | "deep" | "deep-reasoning"
  maxCharacters?: number
  signal?: AbortSignal
}

interface ExaSearchResult {
  title?: string
  url?: string
  publishedDate?: string
  author?: string
  highlights?: string[]
  text?: string
  summary?: string
}

interface ExaSearchResponse {
  results?: ExaSearchResult[]
  output?: unknown
}

const EXA_SEARCH_URL = "https://api.exa.ai/search"
const DEFAULT_EXA_RESULTS = 5
const DEFAULT_EXA_MAX_CONTEXT_CHARS = 5200

export function getExaApiKey(): string {
  return (
    process.env.EXA_API_KEY ||
    process.env.SYLICA_EXA_API_KEY ||
    ""
  ).trim()
}

export function isExaConfigured(): boolean {
  return Boolean(getExaApiKey())
}

export function shouldUseExaSearch(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (!normalized) {
    return false
  }

  return [
    /\b(search|look up|lookup|google|internet|web|online|browse|source|sources|citation|citations)\b/,
    /\b(latest|current|today|yesterday|tomorrow|recent|newest|updated|now|news)\b/,
    /\b(price|pricing|cost|stock|weather|schedule|release date|version|download|availability)\b/,
    /\b(best|top|compare|comparison|review|reviews|recommend|alternative|alternatives)\b/,
    /\b(who is|what is the current|where can i|find me|research)\b/,
    /\b20(?:2[4-9]|3[0-9])\b/,
  ].some((pattern) => pattern.test(normalized))
}

export function compactSearchQuery(text: string, maxLength = 220): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b(use|with)\s+exa(?:\.ai)?\b/gi, " ")
    .trim()
    .slice(0, maxLength)
}

export async function buildExaSearchContext(
  rawQuery: string,
  options: ExaSearchOptions = {}
): Promise<string> {
  const query = compactSearchQuery(rawQuery)
  if (!query || (!options.force && !shouldUseExaSearch(query))) {
    return ""
  }

  const apiKey = getExaApiKey()
  if (!apiKey) {
    return ""
  }

  const timeout = new AbortController()
  const timeoutId = setTimeout(() => timeout.abort(), 6500)
  const signal = mergeAbortSignals(options.signal, timeout.signal)

  try {
    const response = await fetch(EXA_SEARCH_URL, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        query,
        type: options.type || "fast",
        numResults: options.numResults || DEFAULT_EXA_RESULTS,
        contents: {
          highlights: true,
        },
      }),
    })

    if (!response.ok) {
      const message = await response.text().catch(() => "")
      throw new Error(
        `Exa search failed (${response.status}): ${message || response.statusText}`
      )
    }

    const data = (await response.json()) as ExaSearchResponse
    return formatExaContext(query, data, options.maxCharacters)
  } catch (error) {
    if (isAbortLikeError(error)) {
      return ""
    }

    console.warn("Exa search failed:", error)
    return ""
  } finally {
    clearTimeout(timeoutId)
  }
}

function formatExaContext(
  query: string,
  data: ExaSearchResponse,
  maxCharacters = DEFAULT_EXA_MAX_CONTEXT_CHARS
): string {
  const results = Array.isArray(data.results) ? data.results : []
  if (results.length === 0) {
    return ""
  }

  const lines = [
    `Web search context from Exa for: ${query}`,
    "Use this only when relevant. Prefer cited facts from these results for current/web-dependent claims.",
  ]

  results.slice(0, DEFAULT_EXA_RESULTS).forEach((result, index) => {
    const title = clean(result.title || "Untitled result")
    const url = clean(result.url || "")
    const date = clean(result.publishedDate || "")
    const author = clean(result.author || "")
    const highlights = Array.isArray(result.highlights)
      ? result.highlights.map(clean).filter(Boolean).slice(0, 3)
      : []
    const fallbackText = clean(result.summary || result.text || "").slice(0, 900)

    lines.push("")
    lines.push(`[${index + 1}] ${title}`)
    if (url) lines.push(`URL: ${url}`)
    if (date) lines.push(`Published: ${date}`)
    if (author) lines.push(`Author: ${author}`)
    if (highlights.length > 0) {
      lines.push("Highlights:")
      highlights.forEach((highlight) => lines.push(`- ${highlight}`))
    } else if (fallbackText) {
      lines.push(`Excerpt: ${fallbackText}`)
    }
  })

  const formatted = lines.join("\n").trim()
  if (formatted.length <= maxCharacters) {
    return formatted
  }

  return `${formatted.slice(0, maxCharacters).trimEnd()}\n...`
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function isAbortLikeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || /aborted|abort/i.test(error.message))
  )
}

function mergeAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const activeSignals = signals.filter(Boolean) as AbortSignal[]
  const controller = new AbortController()

  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort()
    }
  }

  activeSignals.forEach((signal) => {
    if (signal.aborted) {
      abort()
    } else {
      signal.addEventListener("abort", abort, { once: true })
    }
  })

  return controller.signal
}
