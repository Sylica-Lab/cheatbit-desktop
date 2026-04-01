export type SubscriptionPlan = "free" | "pro" | "enterprise"

export interface UsageSnapshot {
  solvesToday: number
  debugToday: number
  screenshotsToday: number
  requestsToday: number
  requestsThisHour: number
  remainingRequestsToday: number
  remainingSolveDaily: number
  remainingDebugDaily: number
  remainingRequestsThisHour: number
  totalSolveCount: number
  totalDebugCount: number
  totalScreenshotCount: number
  blockedAttemptsToday: number
  lastUsageAt: string | null
}

export interface AuthenticatedUser {
  id: string
  email: string
  name: string
  role: "user"
  subscriptionPlan: SubscriptionPlan
  subscriptionStatus: string
  subscriptionSource: "manual" | "stripe" | "dodo"
  cancelAtPeriodEnd: boolean
  createdAt: string
  updatedAt: string
  lastLoginAt: string | null
  subscriptionStartedAt: string | null
  subscriptionRenewsAt: string | null
}

export interface AuthSession {
  token: string
  user: AuthenticatedUser
  usage: UsageSnapshot
}

export interface BillingSummary {
  provider: "manual" | "stripe" | "dodo"
  pricePerMonthUsd: number
  unlimited: boolean
  checkoutEnabled: boolean
  canManageBilling: boolean
  cancelAtPeriodEnd: boolean
  statusMessage: string
}

export interface UsageEventSummary {
  id: string
  action: string
  allowed: boolean
  reason: string | null
  createdAt: string
}

export interface DailyActivityPoint {
  day: string
  solves: number
  debug: number
  screenshots: number
  blocked: number
}

export interface UserDashboardData {
  user: AuthenticatedUser
  usage: UsageSnapshot
  billing: BillingSummary
  recentEvents: UsageEventSummary[]
  dailyActivity: DailyActivityPoint[]
}

export interface ChatThreadSummary {
  id: string
  userId: string
  mode: "general" | "follow_up" | "live_interview" | "computer_use"
  title: string
  preview: string
  createdAt: string | null
  updatedAt: string | null
  lastMessageAt: string | null
}

export interface PersistedChatMessage {
  id: string
  threadId: string
  userId: string
  role: "user" | "assistant"
  content: string
  createdAt: string | null
}

export interface BillingSessionResponse {
  url: string
}

export interface MobileChatResponse {
  thread: ChatThreadSummary
  userMessage: PersistedChatMessage
  assistantMessage: PersistedChatMessage
  usage: UsageSnapshot
}

export type PhonePairingStatus = "pending" | "paired" | "revoked" | "expired"
export type PhoneRelayEventType = "clipboard" | "otp" | "link" | "note"

export interface PhonePairingQrPayload {
  type: "sylica-phone-pair"
  version: 1
  apiBaseUrl: string
  pairingId: string
  pairingToken: string
}

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

export interface PhoneRelayEventSummary {
  id: string
  userId: string
  pairingId: string
  source: "mobile" | "desktop"
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

export interface LocalPhonePairingQrPayload {
  type: "sylica-local-phone-relay"
  version: 1
  apiBaseUrl: string
  pairingId: string
  pairingToken: string
}

export interface LocalPhoneRelayConnection {
  id: string
  apiBaseUrl: string
  deviceToken: string
  desktopDeviceName: string
  mobileDeviceName: string | null
  status: "paired"
  pairedAt: string | null
  lastSeenAt: string | null
}

export interface LocalPhoneRelayEventSummary {
  id: string
  pairingId: string
  source: "mobile" | "desktop"
  eventType: PhoneRelayEventType
  payload: Record<string, unknown>
  createdAt: string | null
  pairing: {
    desktopDeviceName: string
    mobileDeviceName: string | null
  }
}

export interface AndroidRelayCapabilityState {
  notificationAccessEnabled: boolean
  imeEnabled: boolean
  imeSelected: boolean
}
