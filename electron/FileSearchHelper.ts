import fs from "node:fs"
import path from "node:path"
import { app } from "electron"

export interface LocalFileSearchOptions {
  force?: boolean
  maxResults?: number
  maxDepth?: number
  maxFilesScanned?: number
  maxContentFilesScanned?: number
  maxCharacters?: number
  signal?: AbortSignal
}

interface LocalFileSearchResult {
  path: string
  name: string
  isDirectory: boolean
  score: number
  size: number
  modifiedMs: number
  matchType: "name" | "path" | "content"
  snippet?: string
}

interface SearchStats {
  filesScanned: number
  directoriesScanned: number
  contentFilesScanned: number
  skippedDirectories: number
  permissionErrors: number
}

const DEFAULT_FILE_SEARCH_RESULTS = 10
const DEFAULT_FILE_SEARCH_MAX_DEPTH = 5
const DEFAULT_FILE_SEARCH_MAX_FILES = 6000
const DEFAULT_FILE_SEARCH_MAX_CONTENT_FILES = 650
const DEFAULT_FILE_SEARCH_CONTEXT_CHARS = 6000
const MAX_TEXT_FILE_BYTES = 512 * 1024

const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".npm",
  ".bun",
  ".Trash",
  "node_modules",
  "Library",
  "Applications",
  "System",
  "Volumes",
  "venv",
  ".venv",
  "dist",
  "dist-electron",
  "build",
  "release",
])

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".java",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".go",
  ".rs",
  ".php",
  ".rb",
  ".swift",
  ".kt",
  ".sql",
  ".sh",
  ".zsh",
  ".bash",
  ".ps1",
  ".log",
])

const SENSITIVE_FILE_PATTERNS = [
  /^\.env(?:\..*)?$/i,
  /(?:^|[._-])secret(?:s)?(?:[._-]|$)/i,
  /(?:^|[._-])credential(?:s)?(?:[._-]|$)/i,
  /(?:^|[._-])private(?:[._-]|$)/i,
  /(?:^|[._-])token(?:s)?(?:[._-]|$)/i,
  /id_rsa/i,
  /id_ed25519/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
]

export function shouldUseLocalFileSearch(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase()
  if (!normalized) {
    return false
  }

  const hasWebIntent =
    /\b(web|internet|online|google|browser|website|url|latest|current|news|price|weather|stock|market)\b/i.test(
      normalized
    )
  const hasLocalFileReference =
    /\b(file|files|folder|folders|document|documents|pdf|docx?|xlsx?|pptx?|csv|txt|markdown|download|downloads|desktop|computer|pc|mac|local|drive|directory|directories|project|repo|repository)\b/i.test(
      normalized
    )

  if (hasWebIntent && !hasLocalFileReference) {
    return false
  }

  return [
    /\b(find|search|look for|locate)\b.*\b(file|files|folder|folders|document|documents|pdf|docx?|xlsx?|pptx?|csv|txt|download|downloads|desktop|computer|pc|mac|local|drive|directory|project|repo|repository)\b/i,
    /\b(file|files|folder|folders|document|documents|downloads|desktop)\b.*\b(find|search|look for|locate|containing|mentions?)\b/i,
    /\b(where is|where are|do i have|show me|list)\b.*\b(file|files|folder|folders|document|documents|pdf|docx?|xlsx?|pptx?|csv|download|downloads)\b/i,
    /\b(search|find|look for|locate)\b.*\b(on|in)\s+(my\s+)?(computer|pc|mac|desktop|documents|downloads|files|folders|local)\b/i,
  ].some((pattern) => pattern.test(normalized))
}

export function compactFileSearchQuery(text: string, maxLength = 160): string {
  const quoted = text.match(/["“”'`](.{2,160}?)["“”'`]/)
  if (quoted?.[1]) {
    return cleanWhitespace(quoted[1]).slice(0, maxLength)
  }

  return cleanWhitespace(text)
    .replace(/\b(can you|please|could you|would you|help me|i need to|i want to)\b/gi, " ")
    .replace(/\b(find|search|look for|locate|show me|list|where is|where are|do i have)\b/gi, " ")
    .replace(/\b(my|the|a|an|all|local|computer|pc|mac|files?|folders?|documents?|downloads?|desktop|drive|directory|directories)\b/gi, " ")
    .replace(/\b(on|in|from|for|about|called|named|with|containing|mentions?)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
}

export async function buildLocalFileSearchContext(
  rawQuery: string,
  options: LocalFileSearchOptions = {}
): Promise<string> {
  const query = compactFileSearchQuery(rawQuery)
  const shouldSearch = options.force || shouldUseLocalFileSearch(rawQuery)
  if (!shouldSearch || !query) {
    return ""
  }

  const roots = getSearchRoots(rawQuery)
  if (roots.length === 0) {
    return `Local file search context for: ${query}\nNo searchable local folders were available.`
  }

  const stats: SearchStats = {
    filesScanned: 0,
    directoriesScanned: 0,
    contentFilesScanned: 0,
    skippedDirectories: 0,
    permissionErrors: 0,
  }
  const results = await searchRoots(query, rawQuery, roots, stats, options)
  return formatLocalFileSearchContext(query, roots, results, stats, options)
}

async function searchRoots(
  query: string,
  rawQuery: string,
  roots: string[],
  stats: SearchStats,
  options: LocalFileSearchOptions
): Promise<LocalFileSearchResult[]> {
  const results = new Map<string, LocalFileSearchResult>()
  const tokens = tokenize(query)
  const maxDepth = options.maxDepth ?? DEFAULT_FILE_SEARCH_MAX_DEPTH
  const maxFilesScanned = options.maxFilesScanned ?? DEFAULT_FILE_SEARCH_MAX_FILES
  const wantsContent = wantsContentSearch(rawQuery)

  for (const root of roots) {
    if (options.signal?.aborted || stats.filesScanned >= maxFilesScanned) {
      break
    }

    await walkDirectory(root, 0)
  }

  return Array.from(results.values())
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return b.modifiedMs - a.modifiedMs
    })
    .slice(0, options.maxResults ?? DEFAULT_FILE_SEARCH_RESULTS)

  async function walkDirectory(dir: string, depth: number): Promise<void> {
    if (
      options.signal?.aborted ||
      depth > maxDepth ||
      stats.filesScanned >= maxFilesScanned
    ) {
      return
    }

    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
      stats.directoriesScanned += 1
    } catch (error) {
      stats.permissionErrors += 1
      return
    }

    for (const entry of entries) {
      if (options.signal?.aborted || stats.filesScanned >= maxFilesScanned) {
        return
      }

      if (entry.name.startsWith(".") && entry.name !== ".config") {
        continue
      }

      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (shouldSkipDirectory(entry.name)) {
          stats.skippedDirectories += 1
          continue
        }

        const score = scorePathMatch(query, tokens, fullPath, entry.name)
        if (score > 0) {
          upsertResult(results, {
            path: fullPath,
            name: entry.name,
            isDirectory: true,
            score: score + 8,
            size: 0,
            modifiedMs: await safeModifiedMs(fullPath),
            matchType: score >= 65 ? "name" : "path",
          })
        }

        await walkDirectory(fullPath, depth + 1)
        continue
      }

      if (!entry.isFile()) {
        continue
      }

      stats.filesScanned += 1

      if (isSensitiveFileName(entry.name)) {
        continue
      }

      const metadata = await safeStat(fullPath)
      const pathScore = scorePathMatch(query, tokens, fullPath, entry.name)
      let bestResult: LocalFileSearchResult | null = null

      if (pathScore > 0) {
        bestResult = {
          path: fullPath,
          name: entry.name,
          isDirectory: false,
          score: pathScore,
          size: metadata?.size ?? 0,
          modifiedMs: metadata?.mtimeMs ?? 0,
          matchType: pathScore >= 65 ? "name" : "path",
        }
      }

      const shouldReadContent =
        wantsContent &&
        stats.contentFilesScanned <
          (options.maxContentFilesScanned ?? DEFAULT_FILE_SEARCH_MAX_CONTENT_FILES) &&
        isTextFile(entry.name) &&
        (metadata?.size ?? Number.MAX_SAFE_INTEGER) <= MAX_TEXT_FILE_BYTES

      if (shouldReadContent) {
        stats.contentFilesScanned += 1
        const contentMatch = await scoreContentMatch(query, tokens, fullPath)
        if (contentMatch) {
          const contentResult: LocalFileSearchResult = {
            path: fullPath,
            name: entry.name,
            isDirectory: false,
            score: contentMatch.score + 40,
            size: metadata?.size ?? 0,
            modifiedMs: metadata?.mtimeMs ?? 0,
            matchType: "content",
            snippet: contentMatch.snippet,
          }
          if (!bestResult || contentResult.score > bestResult.score) {
            bestResult = contentResult
          }
        }
      }

      if (bestResult) {
        upsertResult(results, bestResult)
      }
    }
  }
}

function getSearchRoots(rawQuery: string): string[] {
  const normalized = rawQuery.toLowerCase()
  const candidates: string[] = []
  const addPath = (pathName: Parameters<typeof app.getPath>[0]) => {
    try {
      candidates.push(app.getPath(pathName))
    } catch (_error) {
      // Ignore unavailable platform-specific paths.
    }
  }

  const hasSpecificRoot = /\b(desktop|documents?|downloads?|home|project|repo|repository)\b/i.test(
    normalized
  )

  if (/\bdesktop\b/i.test(normalized)) addPath("desktop")
  if (/\bdocuments?\b/i.test(normalized)) addPath("documents")
  if (/\bdownloads?\b/i.test(normalized)) addPath("downloads")
  if (/\bhome\b/i.test(normalized)) addPath("home")
  if (/\b(project|repo|repository|codebase)\b/i.test(normalized)) {
    candidates.push(process.cwd())
  }

  if (!hasSpecificRoot) {
    addPath("desktop")
    addPath("documents")
    addPath("downloads")
  }

  return Array.from(new Set(candidates.map((candidate) => path.resolve(candidate))))
    .filter((candidate) => fs.existsSync(candidate))
}

function scorePathMatch(
  query: string,
  tokens: string[],
  fullPath: string,
  name: string
): number {
  const lowerQuery = query.toLowerCase()
  const lowerName = name.toLowerCase()
  const lowerPath = fullPath.toLowerCase()
  let score = 0

  if (lowerName === lowerQuery) score += 130
  if (lowerName.includes(lowerQuery)) score += 95
  if (lowerPath.includes(lowerQuery)) score += 45

  const extension = path.extname(lowerName).replace(/^\./, "")
  for (const token of tokens) {
    if (lowerName.includes(token)) score += 18
    else if (lowerPath.includes(token)) score += 6
    if (extension && token === extension) score += 24
  }

  if (tokens.length > 1 && tokens.every((token) => lowerName.includes(token))) {
    score += 35
  }

  return score
}

async function scoreContentMatch(
  query: string,
  tokens: string[],
  filePath: string
): Promise<{ score: number; snippet: string } | null> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf8")
    const lowerRaw = raw.toLowerCase()
    const lowerQuery = query.toLowerCase()
    let index = lowerRaw.indexOf(lowerQuery)
    let score = index >= 0 ? 55 : 0

    if (index < 0) {
      const matchedTokenIndexes = tokens
        .map((token) => lowerRaw.indexOf(token))
        .filter((tokenIndex) => tokenIndex >= 0)
      if (matchedTokenIndexes.length === 0) {
        return null
      }

      score = matchedTokenIndexes.length * 12
      index = Math.min(...matchedTokenIndexes)
    }

    if (tokens.length > 1 && tokens.every((token) => lowerRaw.includes(token))) {
      score += 30
    }

    return {
      score,
      snippet: redactSensitiveText(extractSnippet(raw, index)),
    }
  } catch (_error) {
    return null
  }
}

function formatLocalFileSearchContext(
  query: string,
  roots: string[],
  results: LocalFileSearchResult[],
  stats: SearchStats,
  options: LocalFileSearchOptions
): string {
  const lines = [
    `Local file search context for: ${query}`,
    `Searched folders: ${roots.join(", ")}`,
    `Scanned ${stats.filesScanned} files in ${stats.directoriesScanned} folders.`,
  ]

  if (stats.permissionErrors > 0) {
    lines.push(
      `Skipped ${stats.permissionErrors} unreadable folders because macOS or the filesystem denied access.`
    )
  }

  if (results.length === 0) {
    lines.push("No matching files or folders were found in the searched folders.")
  } else {
    results.forEach((result, index) => {
      lines.push("")
      lines.push(`[${index + 1}] ${result.name}`)
      lines.push(`Path: ${result.path}`)
      lines.push(`Kind: ${result.isDirectory ? "folder" : "file"}`)
      lines.push(`Match: ${result.matchType}`)
      if (!result.isDirectory) {
        lines.push(`Size: ${formatBytes(result.size)}`)
      }
      if (result.modifiedMs > 0) {
        lines.push(`Modified: ${new Date(result.modifiedMs).toISOString()}`)
      }
      if (result.snippet) {
        lines.push(`Snippet: ${result.snippet}`)
      }
    })
  }

  const formatted = lines.join("\n").trim()
  const maxCharacters = options.maxCharacters ?? DEFAULT_FILE_SEARCH_CONTEXT_CHARS
  if (formatted.length <= maxCharacters) {
    return formatted
  }

  return `${formatted.slice(0, maxCharacters).trimEnd()}\n...`
}

function tokenize(value: string): string[] {
  return cleanWhitespace(value)
    .toLowerCase()
    .split(/[^a-z0-9._-]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 10)
}

function wantsContentSearch(value: string): boolean {
  return /\b(content|contains?|containing|mentions?|inside|text|phrase|word|string|grep|search files? for)\b/i.test(
    value
  )
}

function shouldSkipDirectory(name: string): boolean {
  return SKIPPED_DIRECTORY_NAMES.has(name)
}

function isSensitiveFileName(name: string): boolean {
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(name))
}

function isTextFile(name: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(name).toLowerCase())
}

async function safeStat(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(filePath)
  } catch (_error) {
    return null
  }
}

async function safeModifiedMs(filePath: string): Promise<number> {
  return (await safeStat(filePath))?.mtimeMs ?? 0
}

function upsertResult(
  results: Map<string, LocalFileSearchResult>,
  result: LocalFileSearchResult
): void {
  const existing = results.get(result.path)
  if (!existing || result.score > existing.score) {
    results.set(result.path, result)
  }
}

function extractSnippet(content: string, index: number): string {
  const start = Math.max(0, index - 180)
  const end = Math.min(content.length, index + 360)
  return cleanWhitespace(content.slice(start, end))
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\bsk-proj-[A-Za-z0-9_-]{12,}\b/g, "[redacted-api-key]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted-api-key]")
    .replace(/\bsk-ant-[A-Za-z0-9_-]{12,}\b/g, "[redacted-api-key]")
    .replace(/\bhf_[A-Za-z0-9]{12,}\b/g, "[redacted-api-key]")
    .replace(/\bgsk_[A-Za-z0-9]{12,}\b/g, "[redacted-api-key]")
    .replace(/\bfw_[A-Za-z0-9]{12,}\b/g, "[redacted-api-key]")
}

function cleanWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B"
  }

  const units = ["B", "KB", "MB", "GB"]
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`
}
