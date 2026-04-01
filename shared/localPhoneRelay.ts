export type LocalPhonePairingStatus = "pending" | "paired" | "expired"
export type LocalPhoneRelaySource = "mobile" | "desktop"
export type LocalPhoneRelayEventType = "clipboard" | "otp" | "link" | "note"
export type LocalPhoneRelayServerStatus = "offline" | "starting" | "ready" | "error"

export interface LocalPhonePairingSessionSummary {
  id: string
  desktopDeviceName: string
  mobileDeviceName: string | null
  status: LocalPhonePairingStatus
  createdAt: string | null
  updatedAt: string | null
  expiresAt: string | null
  pairedAt: string | null
  lastSeenAt: string | null
}

export interface LocalPhonePairingQrPayload {
  type: "sylica-local-phone-relay"
  version: 1
  apiBaseUrl: string
  pairingId: string
  pairingToken: string
}

export interface LocalPhoneRelayEventSummary {
  id: string
  pairingId: string
  source: LocalPhoneRelaySource
  eventType: LocalPhoneRelayEventType
  payload: Record<string, unknown>
  createdAt: string | null
  pairing: {
    desktopDeviceName: string
    mobileDeviceName: string | null
  }
}

export interface LocalPhoneRelayState {
  serverStatus: LocalPhoneRelayServerStatus
  apiBaseUrl: string | null
  desktopDeviceName: string
  activePairing: LocalPhonePairingSessionSummary | null
  activeManualCode: string | null
  activeQrPayload: LocalPhonePairingQrPayload | null
  devices: LocalPhonePairingSessionSummary[]
  events: LocalPhoneRelayEventSummary[]
  lastError: string | null
}

export interface CreateLocalPhonePairingSessionResponse {
  pairing: LocalPhonePairingSessionSummary
  manualCode: string
  qrPayload: LocalPhonePairingQrPayload
}

export interface CompleteLocalPhonePairingResponse {
  pairing: LocalPhonePairingSessionSummary
  deviceToken: string
  apiBaseUrl: string
}
