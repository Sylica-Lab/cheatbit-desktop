export type PhonePairingStatus = "pending" | "paired" | "revoked" | "expired"
export type PhoneRelaySource = "mobile" | "desktop"
export type PhoneRelayEventType = "clipboard" | "otp" | "link" | "note"

export interface PhonePairingSessionSummary {
  id: string
  userId: string
  desktopDeviceName: string
  mobileDeviceName: string | null
  status: PhonePairingStatus
  createdAt: string | null
  updatedAt: string | null
  expiresAt: string | null
  pairedAt: string | null
  lastSeenAt: string | null
}

export interface PhonePairingQrPayload {
  type: "sylica-phone-pair"
  version: 1
  apiBaseUrl: string
  pairingId: string
  pairingToken: string
}

export interface PhoneRelayEventSummary {
  id: string
  userId: string
  pairingId: string
  source: PhoneRelaySource
  eventType: PhoneRelayEventType
  payload: Record<string, unknown>
  createdAt: string | null
  pairing: {
    desktopDeviceName: string
    mobileDeviceName: string | null
  }
}

export interface CreatePhonePairingSessionResponse {
  pairing: PhonePairingSessionSummary
  manualCode: string
  qrPayload: PhonePairingQrPayload
}
