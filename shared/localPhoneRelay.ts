export type LocalPhonePairingStatus = "pending" | "paired" | "expired"
export type LocalPhoneRelaySource = "mobile" | "desktop"
export type LocalPhoneRelayEventType =
  | "clipboard"
  | "otp"
  | "link"
  | "note"
  | "notification"
  | "computer_command"
  | "computer_command_status"
  | "desktop_command"
  | "desktop_command_status"
  | "screen_result"
  | "file"
export type LocalPhoneRelayServerStatus = "offline" | "starting" | "ready" | "error"

export type LocalPhoneRemoteInputPayload =
  | { type: "mouse_move_delta"; dx: number; dy: number }
  | { type: "mouse_move_absolute"; normalizedX: number; normalizedY: number }
  | {
      type: "mouse_click_absolute"
      normalizedX: number
      normalizedY: number
      button?: "left" | "right" | "middle"
      double?: boolean
    }
  | { type: "mouse_click"; button?: "left" | "right" | "middle"; double?: boolean }
  | { type: "mouse_scroll"; deltaY: number; deltaX: number }
  | { type: "keyboard_type"; text: string }
  | { type: "keyboard_press"; keys: string }

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
  camera: {
    active: boolean
    mobileDeviceName: string | null
    facing: "front" | "back" | null
    width: number | null
    height: number | null
    frameCount: number
    updatedAt: string | null
    snapshotUrl: string | null
    streamUrl: string | null
  }
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
