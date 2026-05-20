import fs from "node:fs"
import path from "node:path"
import { app } from "electron"
import type { AuthSession } from "../shared/backendAuth"
import type {
  ChatThreadSummary,
  PersistedChatMessage,
} from "../shared/followUpChat"

interface LocalChatStore {
  threads: ChatThreadSummary[]
  messagesByThreadId: Record<string, PersistedChatMessage[]>
}

interface StoreSchema {
  authSession: AuthSession | null
  voiceMemory: {
    summary: string
    updatedAt: string | null
  }
  localChat: LocalChatStore
}

type StoreKey = keyof StoreSchema

const DEFAULT_STORE_STATE: StoreSchema = {
  authSession: null,
  voiceMemory: {
    summary: "",
    updatedAt: null,
  },
  localChat: {
    threads: [],
    messagesByThreadId: {},
  },
}

function getSylicaAiDataDirectory(): string {
  try {
    const targetDirectory = path.join(app.getPath("appData"), "sylica-ai")
    const legacyDirectory = path.join(app.getPath("appData"), "cheatbit")
    if (!fs.existsSync(targetDirectory) && fs.existsSync(legacyDirectory)) {
      try {
        fs.renameSync(legacyDirectory, targetDirectory)
      } catch (error) {
        fs.cpSync(legacyDirectory, targetDirectory, { recursive: true })
      }
    }
    return targetDirectory
  } catch (error) {
    const targetDirectory = path.join(process.cwd(), ".sylica-ai")
    const legacyDirectory = path.join(process.cwd(), ".cheatbit")
    if (!fs.existsSync(targetDirectory) && fs.existsSync(legacyDirectory)) {
      try {
        fs.renameSync(legacyDirectory, targetDirectory)
      } catch (renameError) {
        fs.cpSync(legacyDirectory, targetDirectory, { recursive: true })
      }
    }
    return targetDirectory
  }
}

function ensureDirectoryExists(directory: string): void {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true })
  }
}

function normalizeStoreState(value: unknown): StoreSchema {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_STORE_STATE }
  }

  const parsed = value as Partial<StoreSchema>
  const localChat =
    parsed.localChat &&
    typeof parsed.localChat === "object" &&
    !Array.isArray(parsed.localChat)
      ? parsed.localChat
      : DEFAULT_STORE_STATE.localChat

  return {
    authSession: parsed.authSession ?? null,
    voiceMemory: {
      summary:
        typeof parsed.voiceMemory?.summary === "string"
          ? parsed.voiceMemory.summary
          : "",
      updatedAt:
        typeof parsed.voiceMemory?.updatedAt === "string"
          ? parsed.voiceMemory.updatedAt
          : null,
    },
    localChat: {
      threads: Array.isArray(localChat.threads)
        ? localChat.threads.filter((thread): thread is ChatThreadSummary => {
            return (
              !!thread &&
              typeof thread === "object" &&
              typeof thread.id === "string" &&
              typeof thread.mode === "string"
            )
          })
        : [],
      messagesByThreadId:
        localChat.messagesByThreadId &&
        typeof localChat.messagesByThreadId === "object" &&
        !Array.isArray(localChat.messagesByThreadId)
          ? Object.fromEntries(
              Object.entries(localChat.messagesByThreadId).map(
                ([threadId, messages]) => [
                  threadId,
                  Array.isArray(messages)
                    ? messages.filter(
                        (message): message is PersistedChatMessage =>
                          !!message &&
                          typeof message === "object" &&
                          typeof message.id === "string" &&
                          typeof message.threadId === "string" &&
                          typeof message.role === "string" &&
                          typeof message.content === "string"
                      )
                    : [],
                ]
              )
            )
          : {},
    },
  }
}

function readStoreFile(filePath: string): StoreSchema {
  if (!fs.existsSync(filePath)) {
    return { ...DEFAULT_STORE_STATE }
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8").trim()
    if (!raw) {
      return { ...DEFAULT_STORE_STATE }
    }

    return normalizeStoreState(JSON.parse(raw))
  } catch (error) {
    console.warn(`Failed to read store file at ${filePath}:`, error)
    return { ...DEFAULT_STORE_STATE }
  }
}

const storeDirectory = getSylicaAiDataDirectory()
ensureDirectoryExists(storeDirectory)

const storeFilePath = path.join(storeDirectory, "session-store.json")
let storeState: StoreSchema = readStoreFile(storeFilePath)

function writeStoreFile(): void {
  try {
    fs.writeFileSync(storeFilePath, JSON.stringify(storeState, null, 2), "utf8")
  } catch (error) {
    console.warn("Failed to persist local store:", error)
  }
}

function migrateLegacySession(): void {
  if (storeState.authSession?.token) {
    return
  }

  const legacyDirectory = path.join(app.getPath("appData"), "Electron")
  const legacyPath = path.join(legacyDirectory, "config.json")
  if (!fs.existsSync(legacyPath)) {
    return
  }

  try {
    const legacyState = readStoreFile(legacyPath)
    const legacySession = legacyState.authSession
    if (legacySession?.token) {
      storeState = {
        ...storeState,
        authSession: legacySession,
      }
      writeStoreFile()
      console.log("Migrated auth session from legacy Electron store")
    }
  } catch (error) {
    console.warn("Skipping legacy auth session migration:", error)
  }
}

migrateLegacySession()

export const store = {
  get store(): StoreSchema {
    return storeState
  },
  get<K extends StoreKey>(key: K): StoreSchema[K] {
    return storeState[key]
  },
  set<K extends StoreKey>(key: K, value: StoreSchema[K]): void {
    storeState = {
      ...storeState,
      [key]: value,
    }
    writeStoreFile()
  },
}
