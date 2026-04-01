import * as SecureStore from "expo-secure-store"
import { syncAndroidRelayConnections } from "./androidRelay"
import type { AuthSession, LocalPhoneRelayConnection } from "./types"

const SESSION_KEY = "sylica.mobile.session"
const LOCAL_RELAY_CONNECTIONS_KEY = "sylica.mobile.local-relay.connections"

export async function loadStoredSession(): Promise<AuthSession | null> {
  const rawValue = await SecureStore.getItemAsync(SESSION_KEY)
  if (!rawValue) {
    return null
  }

  try {
    return JSON.parse(rawValue) as AuthSession
  } catch (_error) {
    await SecureStore.deleteItemAsync(SESSION_KEY)
    return null
  }
}

export async function saveStoredSession(session: AuthSession): Promise<void> {
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session))
}

export async function clearStoredSession(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_KEY)
}

export async function loadStoredLocalRelayConnections(): Promise<
  LocalPhoneRelayConnection[]
> {
  const rawValue = await SecureStore.getItemAsync(LOCAL_RELAY_CONNECTIONS_KEY)
  if (!rawValue) {
    return []
  }

  try {
    const parsed = JSON.parse(rawValue) as LocalPhoneRelayConnection[]
    return Array.isArray(parsed) ? parsed : []
  } catch (_error) {
    await SecureStore.deleteItemAsync(LOCAL_RELAY_CONNECTIONS_KEY)
    return []
  }
}

export async function saveStoredLocalRelayConnections(
  connections: LocalPhoneRelayConnection[]
): Promise<void> {
  await SecureStore.setItemAsync(
    LOCAL_RELAY_CONNECTIONS_KEY,
    JSON.stringify(connections)
  )
  await syncAndroidRelayConnections(connections)
}
