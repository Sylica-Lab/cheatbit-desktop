import type {
  AuthSession,
  BillingSessionResponse,
  ChatThreadSummary,
  CreatePhonePairingSessionResponse,
  LocalPhoneRelayConnection,
  LocalPhoneRelayEventSummary,
  MobileChatResponse,
  PhonePairingSessionSummary,
  PhoneRelayEventSummary,
  PersistedChatMessage,
  UserDashboardData,
} from "./types"

const API_BASE_URL =
  process.env.EXPO_PUBLIC_SYLICA_BACKEND_URL?.trim() ||
  "https://cheat.trybookai.com"

class ApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message)
    this.name = "ApiError"
  }
}

async function request<T>(
  pathname: string,
  options: {
    method?: "GET" | "POST"
    token?: string
    body?: unknown
  } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  }

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json"
  }

  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`
  }

  const response = await fetch(`${API_BASE_URL}${pathname}`, {
    method: options.method || "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })

  let payload: any = null
  const text = await response.text()
  if (text.trim()) {
    try {
      payload = JSON.parse(text)
    } catch (_error) {
      payload = null
    }
  }

  if (!response.ok) {
    throw new ApiError(
      payload?.error || `Request failed with status ${response.status}.`,
      response.status
    )
  }

  return payload as T
}

export function getApiBaseUrl() {
  return API_BASE_URL
}

export async function register(payload: {
  name: string
  email: string
  password: string
}): Promise<AuthSession> {
  const response = await request<{ session: AuthSession }>("/api/auth/register", {
    method: "POST",
    body: payload,
  })

  return response.session
}

export async function login(payload: {
  email: string
  password: string
}): Promise<AuthSession> {
  const response = await request<{ session: AuthSession }>("/api/auth/login", {
    method: "POST",
    body: payload,
  })

  return response.session
}

export async function getCurrentSession(token: string): Promise<AuthSession> {
  const response = await request<{ session: AuthSession }>("/api/auth/me", {
    token,
  })

  return response.session
}

export async function getDashboard(token: string): Promise<UserDashboardData> {
  const response = await request<{ dashboard: UserDashboardData }>(
    "/api/account/dashboard",
    {
      token,
    }
  )

  return response.dashboard
}

export async function listThreads(token: string): Promise<ChatThreadSummary[]> {
  const response = await request<{ threads: ChatThreadSummary[] }>(
    "/api/chat/threads?mode=general",
    {
      token,
    }
  )

  return response.threads.filter((thread) => thread.mode === "general")
}

export async function getMessages(
  token: string,
  threadId: string
): Promise<PersistedChatMessage[]> {
  const response = await request<{
    thread: ChatThreadSummary
    messages: PersistedChatMessage[]
  }>(`/api/chat/threads/${encodeURIComponent(threadId)}/messages`, {
    token,
  })

  return response.messages
}

export async function sendMobileChat(
  token: string,
  input: {
    threadId?: string | null
    message: string
  }
): Promise<MobileChatResponse> {
  return request<MobileChatResponse>("/api/mobile/chat/respond", {
    method: "POST",
    token,
    body: input,
  })
}

export async function createCheckoutSession(
  token: string
): Promise<BillingSessionResponse> {
  return request<BillingSessionResponse>("/api/billing/checkout-session", {
    method: "POST",
    token,
  })
}

export async function createBillingPortalSession(
  token: string
): Promise<BillingSessionResponse> {
  return request<BillingSessionResponse>("/api/billing/portal-session", {
    method: "POST",
    token,
  })
}

export async function createPhonePairingSession(
  token: string,
  input?: { desktopDeviceName?: string }
): Promise<CreatePhonePairingSessionResponse> {
  return request<CreatePhonePairingSessionResponse>("/api/phone/pairing-sessions", {
    method: "POST",
    token,
    body: input || {},
  })
}

export async function completePhonePairing(
  token: string,
  input: {
    pairingId: string
    pairingToken: string
    mobileDeviceName?: string
  }
): Promise<PhonePairingSessionSummary> {
  const response = await request<{ pairing: PhonePairingSessionSummary }>(
    "/api/phone/pairing-sessions/complete",
    {
      method: "POST",
      token,
      body: input,
    }
  )

  return response.pairing
}

export async function listPhoneDevices(
  token: string
): Promise<PhonePairingSessionSummary[]> {
  const response = await request<{ devices: PhonePairingSessionSummary[] }>(
    "/api/phone/devices",
    {
      token,
    }
  )

  return response.devices
}

export async function listPhoneEvents(
  token: string,
  input?: { pairingId?: string; after?: string | null }
): Promise<PhoneRelayEventSummary[]> {
  const params = new URLSearchParams()
  if (input?.pairingId) {
    params.set("pairingId", input.pairingId)
  }
  if (input?.after) {
    params.set("after", input.after)
  }

  const suffix = params.toString() ? `?${params.toString()}` : ""
  const response = await request<{ events: PhoneRelayEventSummary[] }>(
    `/api/phone/events${suffix}`,
    {
      token,
    }
  )

  return response.events
}

export async function sendPhoneRelayEvent(
  token: string,
  input: {
    pairingId: string
    eventType: "clipboard" | "otp" | "link" | "note"
    payload: Record<string, unknown>
  }
): Promise<PhoneRelayEventSummary> {
  const response = await request<{ event: PhoneRelayEventSummary }>(
    "/api/phone/events",
    {
      method: "POST",
      token,
      body: {
        pairingId: input.pairingId,
        eventType: input.eventType,
        source: "mobile",
        payload: input.payload,
      },
    }
  )

  return response.event
}

async function localRequest<T>(
  apiBaseUrl: string,
  pathname: string,
  options: {
    method?: "GET" | "POST"
    body?: unknown
  } = {}
): Promise<T> {
  const normalizedBaseUrl = apiBaseUrl.trim().replace(/\/+$/, "")
  const headers: Record<string, string> = {
    Accept: "application/json",
  }

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json"
  }

  const response = await fetch(`${normalizedBaseUrl}${pathname}`, {
    method: options.method || "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })

  let payload: any = null
  const text = await response.text()
  if (text.trim()) {
    try {
      payload = JSON.parse(text)
    } catch (_error) {
      payload = null
    }
  }

  if (!response.ok) {
    throw new ApiError(
      payload?.error || `Request failed with status ${response.status}.`,
      response.status
    )
  }

  return payload as T
}

export async function completeLocalPhonePairing(input: {
  apiBaseUrl: string
  pairingId: string
  pairingToken: string
  mobileDeviceName?: string
}): Promise<LocalPhoneRelayConnection> {
  const response = await localRequest<{
    pairing: PhonePairingSessionSummary
    deviceToken: string
    apiBaseUrl: string
  }>(input.apiBaseUrl, "/api/pairings/complete", {
    method: "POST",
    body: {
      pairingId: input.pairingId,
      pairingToken: input.pairingToken,
      mobileDeviceName: input.mobileDeviceName,
    },
  })

  return {
    id: response.pairing.id,
    apiBaseUrl: response.apiBaseUrl,
    deviceToken: response.deviceToken,
    desktopDeviceName: response.pairing.desktopDeviceName,
    mobileDeviceName: response.pairing.mobileDeviceName,
    status: "paired",
    pairedAt: response.pairing.pairedAt,
    lastSeenAt: response.pairing.lastSeenAt,
  }
}

export async function sendLocalPhoneRelayEvent(input: {
  apiBaseUrl: string
  pairingId: string
  deviceToken: string
  eventType: "clipboard" | "otp" | "link" | "note"
  payload: Record<string, unknown>
}): Promise<LocalPhoneRelayEventSummary> {
  const response = await localRequest<{ event: LocalPhoneRelayEventSummary }>(
    input.apiBaseUrl,
    "/api/events",
    {
      method: "POST",
      body: {
        pairingId: input.pairingId,
        deviceToken: input.deviceToken,
        eventType: input.eventType,
        payload: input.payload,
      },
    }
  )

  return response.event
}
