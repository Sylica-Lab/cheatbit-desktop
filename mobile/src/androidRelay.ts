import { NativeModules, Platform } from "react-native"
import type { LocalPhoneRelayConnection } from "./types"

interface NativeRelayCapabilityState {
  notificationAccessEnabled: boolean
  imeEnabled: boolean
  imeSelected: boolean
}

interface SylicaAndroidBridgeModuleShape {
  syncLocalRelayConnections: (connectionsJson: string) => Promise<void>
  getRelayCapabilityState: () => Promise<NativeRelayCapabilityState>
  openNotificationListenerSettings: () => Promise<boolean>
  openInputMethodSettings: () => Promise<boolean>
  showInputMethodPicker: () => Promise<boolean>
}

const nativeModule: SylicaAndroidBridgeModuleShape | null =
  Platform.OS === "android"
    ? (NativeModules.SylicaAndroidBridge as SylicaAndroidBridgeModuleShape | undefined) || null
    : null

export const EMPTY_ANDROID_RELAY_CAPABILITY_STATE: NativeRelayCapabilityState = {
  notificationAccessEnabled: false,
  imeEnabled: false,
  imeSelected: false,
}

export async function syncAndroidRelayConnections(
  connections: LocalPhoneRelayConnection[]
): Promise<void> {
  if (!nativeModule) {
    return
  }

  await nativeModule.syncLocalRelayConnections(JSON.stringify(connections))
}

export async function getAndroidRelayCapabilityState(): Promise<NativeRelayCapabilityState> {
  if (!nativeModule) {
    return EMPTY_ANDROID_RELAY_CAPABILITY_STATE
  }

  return nativeModule.getRelayCapabilityState()
}

export async function openNotificationRelaySettings(): Promise<void> {
  if (!nativeModule) {
    return
  }

  await nativeModule.openNotificationListenerSettings()
}

export async function openInputMethodRelaySettings(): Promise<void> {
  if (!nativeModule) {
    return
  }

  await nativeModule.openInputMethodSettings()
}

export async function showRelayInputMethodPicker(): Promise<void> {
  if (!nativeModule) {
    return
  }

  await nativeModule.showInputMethodPicker()
}

export function isAndroidRelayNativeAvailable(): boolean {
  return nativeModule !== null
}
