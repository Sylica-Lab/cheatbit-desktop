import fs from "node:fs"
import path from "node:path"
import { app } from "electron"
import Store from "electron-store"
import type { AuthSession } from "../shared/backendAuth"

interface StoreSchema {
  authSession: AuthSession | null
}

const STORE_ENCRYPTION_KEY = "your-encryption-key"

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

const storeDirectory = getSylicaAiDataDirectory()
ensureDirectoryExists(storeDirectory)

const baseStore = new Store<StoreSchema>({
  defaults: {
    authSession: null,
  },
  encryptionKey: STORE_ENCRYPTION_KEY,
  cwd: storeDirectory,
  name: "session-store",
}) as Store<StoreSchema> & {
  store: StoreSchema
  get: <K extends keyof StoreSchema>(key: K) => StoreSchema[K]
  set: <K extends keyof StoreSchema>(key: K, value: StoreSchema[K]) => void
}

function migrateLegacySession(): void {
  if (baseStore.get("authSession")) {
    return
  }

  const legacyDirectory = path.join(app.getPath("appData"), "Electron")
  const legacyPath = path.join(legacyDirectory, "config.json")
  if (!fs.existsSync(legacyPath)) {
    return
  }

  try {
    const legacyStore = new Store<StoreSchema>({
      defaults: {
        authSession: null,
      },
      encryptionKey: STORE_ENCRYPTION_KEY,
      cwd: legacyDirectory,
      name: "config",
    }) as Store<StoreSchema> & {
      get: <K extends keyof StoreSchema>(key: K) => StoreSchema[K]
    }

    const legacySession = legacyStore.get("authSession")
    if (legacySession?.token) {
      baseStore.set("authSession", legacySession)
      console.log("Migrated auth session from legacy Electron store")
    }
  } catch (error) {
    console.warn("Skipping legacy auth session migration:", error)
  }
}

migrateLegacySession()

export const store = baseStore
