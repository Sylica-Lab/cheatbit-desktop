import Store from "electron-store"
import type { AuthSession } from "../shared/backendAuth"

interface StoreSchema {
  authSession: AuthSession | null
}

const store = new Store<StoreSchema>({
  defaults: {
    authSession: null,
  },
  encryptionKey: "your-encryption-key"
}) as Store<StoreSchema> & {
  store: StoreSchema
  get: <K extends keyof StoreSchema>(key: K) => StoreSchema[K]
  set: <K extends keyof StoreSchema>(key: K, value: StoreSchema[K]) => void
}

export { store }
