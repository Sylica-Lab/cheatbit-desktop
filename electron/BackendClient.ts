import { store } from "./store"
import { randomUUID } from "node:crypto"
import type {
  BillingSessionResponse,
  AuthSession,
  AuthState,
  UserDashboardData,
  UsageAction,
  UsageDecision,
} from "../shared/backendAuth"
import type {
  AssistantChatMode,
  ChatThreadSummary,
  FollowUpRole,
  PersistedChatMessage,
} from "../shared/followUpChat"
import type {
  CreatePhonePairingSessionResponse,
  PhonePairingSessionSummary,
  PhoneRelayEventSummary,
} from "../shared/phoneRelay"
import type {
  ConnectedAppIntegration,
  IntegrationAssistantChatTurn,
  IntegrationAssistantResponse,
  IntegrationConnectResponse,
  IntegrationProvider,
} from "../shared/integrations"

const DEFAULT_BACKEND_URL = "https://api.sylicaai.com"
const DEFAULT_DASHBOARD_URL = "https://sylicaai.com"
const BACKEND_URL =
  process.env.SYLICA_AI_BACKEND_URL?.trim() ||
  process.env.CHEATBIT_BACKEND_URL?.trim() ||
  process.env.INTERVIEW_CODER_BACKEND_URL?.trim() ||
  DEFAULT_BACKEND_URL
const DASHBOARD_URL =
  process.env.SYLICA_AI_DASHBOARD_URL?.trim() ||
  DEFAULT_DASHBOARD_URL

interface BackendErrorShape {
  error?: string | { message?: string; type?: string }
  message?: string
}

interface SessionResponse {
  session: AuthSession
}

interface UsageResponse {
  allowed: boolean
  error?: string
  usage?: AuthSession["usage"]
}

interface DashboardResponse {
  dashboard: UserDashboardData
}

interface BillingUrlResponse extends BillingSessionResponse {}

interface ChatThreadsResponse {
  threads: ChatThreadSummary[]
}

interface ChatThreadResponse {
  thread: ChatThreadSummary
}

interface ChatMessagesResponse {
  thread: ChatThreadSummary
  messages: PersistedChatMessage[]
}

interface ChatMessageResponse {
  thread: ChatThreadSummary
  message: PersistedChatMessage
}

interface PhonePairingResponse {
  pairing: PhonePairingSessionSummary
}

interface PhoneDevicesResponse {
  devices: PhonePairingSessionSummary[]
}

interface PhoneEventsResponse {
  events: PhoneRelayEventSummary[]
}

interface IntegrationsResponse {
  integrations: ConnectedAppIntegration[]
}

interface IntegrationAssistantApiResponse extends IntegrationAssistantResponse {}

interface IntegrationConnectApiResponse extends IntegrationConnectResponse {}

class BackendRequestError extends Error {
  public readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = "BackendRequestError"
    this.status = status
  }
}

export class BackendClient {
  public getBaseUrl(): string {
    return BACKEND_URL
  }

  public getWebLoginUrl(): string {
    return `${DASHBOARD_URL.replace(/\/+$/, "")}/desktop-login`
  }

  public getStoredSession(): AuthSession | null {
    return store.get("authSession") || null
  }

  public async getAuthState(): Promise<AuthState> {
    const storedSession = this.getStoredSession()
    if (!storedSession?.token) {
      return { authenticated: false, session: null }
    }

    try {
      const response = await this.request<SessionResponse>("/api/auth/me", {
        method: "GET",
        token: storedSession.token,
      })

      this.setStoredSession(response.session)
      return {
        authenticated: true,
        session: response.session,
      }
    } catch (error) {
      if (this.isAuthFailure(error)) {
        this.clearSession()
        return {
          authenticated: false,
          session: null,
          error: this.getErrorMessage(error),
        }
      }

      return {
        authenticated: true,
        session: storedSession,
        error: this.getErrorMessage(error),
      }
    }
  }

  public async register(
    name: string,
    email: string,
    password: string
  ): Promise<AuthSession> {
    const response = await this.request<SessionResponse>("/api/auth/register", {
      method: "POST",
      body: { name, email, password },
    })

    this.setStoredSession(response.session)
    return response.session
  }

  public async login(email: string, password: string): Promise<AuthSession> {
    const response = await this.request<SessionResponse>("/api/auth/login", {
      method: "POST",
      body: { email, password },
    })

    this.setStoredSession(response.session)
    return response.session
  }

  public async completeWebLogin(token: string): Promise<AuthSession> {
    const response = await this.request<SessionResponse>("/api/auth/me", {
      method: "GET",
      token,
    })

    this.setStoredSession(response.session)
    return response.session
  }

  public logout(): void {
    this.clearSession()
  }

  public async consumeUsage(action: UsageAction): Promise<UsageDecision> {
    const session = this.getStoredSession()
    if (!session?.token) {
      return {
        allowed: false,
        error: "Please log in before using Sylica AI.",
        session: null,
      }
    }

    try {
      const response = await this.request<UsageResponse>("/api/usage/consume", {
        method: "POST",
        token: session.token,
        body: { action },
      })

      const nextSession: AuthSession = {
        ...session,
        usage: response.usage || session.usage,
      }
      this.setStoredSession(nextSession)

      return {
        allowed: Boolean(response.allowed),
        error: response.error,
        usage: nextSession.usage,
        session: nextSession,
      }
    } catch (error) {
      const message = this.getErrorMessage(error)
      if (this.isAuthFailure(error)) {
        this.clearSession()
        return {
          allowed: false,
          error: "Your login session has expired. Please sign in again.",
          session: null,
        }
      }

      return {
        allowed: false,
        error: message,
        session,
      }
    }
  }

  public async getAccountDashboard(): Promise<UserDashboardData> {
    const session = this.getStoredSession()
    if (!session?.token) {
      throw new Error("Please log in before opening the account dashboard.")
    }

    const response = await this.request<DashboardResponse>("/api/account/dashboard", {
      method: "GET",
      token: session.token,
    })

    this.setStoredSession({
      ...session,
      user: response.dashboard.user,
      usage: response.dashboard.usage,
    })

    return response.dashboard
  }

  public async createCheckoutSession(): Promise<BillingSessionResponse> {
    const session = this.getStoredSession()
    if (!session?.token) {
      throw new Error("Please log in before starting checkout.")
    }

    return this.request<BillingUrlResponse>("/api/billing/checkout-session", {
      method: "POST",
      token: session.token,
    })
  }

  public async createBillingPortalSession(): Promise<BillingSessionResponse> {
    const session = this.getStoredSession()
    if (!session?.token) {
      throw new Error("Please log in before opening billing.")
    }

    return this.request<BillingUrlResponse>("/api/billing/portal-session", {
      method: "POST",
      token: session.token,
    })
  }

  public async listChatThreads(
    mode: AssistantChatMode = "general"
  ): Promise<ChatThreadSummary[]> {
    const session = this.getStoredSession()
    if (!session?.token) {
      return this.listLocalChatThreads(mode)
    }

    try {
      const response = await this.request<ChatThreadsResponse>(
        `/api/chat/threads?mode=${encodeURIComponent(mode)}`,
        {
          method: "GET",
          token: session.token,
        }
      )

      return response.threads
    } catch (error) {
      if (this.shouldUseLocalChatFallback(error)) {
        return this.listLocalChatThreads(mode)
      }
      throw error
    }
  }

  public async createChatThread(
    mode: AssistantChatMode = "general",
    title?: string
  ): Promise<ChatThreadSummary> {
    const session = this.getStoredSession()
    if (!session?.token) {
      return this.createLocalChatThread(mode, title)
    }

    try {
      const response = await this.request<ChatThreadResponse>("/api/chat/threads", {
        method: "POST",
        token: session.token,
        body: { mode, title },
      })

      return response.thread
    } catch (error) {
      if (this.shouldUseLocalChatFallback(error)) {
        return this.createLocalChatThread(mode, title)
      }
      throw error
    }
  }

  public async getChatMessages(
    threadId: string
  ): Promise<ChatMessagesResponse> {
    const session = this.getStoredSession()
    if (!session?.token) {
      return this.getLocalChatMessages(threadId)
    }

    if (this.isLocalChatThreadId(threadId)) {
      return this.getLocalChatMessages(threadId)
    }

    try {
      return await this.request<ChatMessagesResponse>(
        `/api/chat/threads/${encodeURIComponent(threadId)}/messages`,
        {
          method: "GET",
          token: session.token,
        }
      )
    } catch (error) {
      if (this.shouldUseLocalChatFallback(error)) {
        return this.getLocalChatMessages(threadId)
      }
      throw error
    }
  }

  public async appendChatMessage(input: {
    threadId: string
    role: FollowUpRole
    content: string
  }): Promise<ChatMessageResponse> {
    const session = this.getStoredSession()
    if (!session?.token) {
      return this.appendLocalChatMessage(input)
    }

    if (this.isLocalChatThreadId(input.threadId)) {
      return this.appendLocalChatMessage(input)
    }

    try {
      return await this.request<ChatMessageResponse>(
        `/api/chat/threads/${encodeURIComponent(input.threadId)}/messages`,
        {
          method: "POST",
          token: session.token,
          body: {
            role: input.role,
            content: input.content,
          },
        }
      )
    } catch (error) {
      if (this.shouldUseLocalChatFallback(error)) {
        return this.appendLocalChatMessage(input)
      }
      throw error
    }
  }

  public async createPhonePairingSession(input?: {
    desktopDeviceName?: string
  }): Promise<CreatePhonePairingSessionResponse> {
    const session = this.getStoredSession()
    if (!session?.token) {
      throw new Error("Please log in before pairing a phone.")
    }

    return this.request<CreatePhonePairingSessionResponse>(
      "/api/phone/pairing-sessions",
      {
        method: "POST",
        token: session.token,
        body: {
          desktopDeviceName: input?.desktopDeviceName,
        },
      }
    )
  }

  public async getPhonePairingSession(
    pairingId: string
  ): Promise<PhonePairingSessionSummary> {
    const session = this.getStoredSession()
    if (!session?.token) {
      throw new Error("Please log in before checking phone pairing.")
    }

    const response = await this.request<PhonePairingResponse>(
      `/api/phone/pairing-sessions/${encodeURIComponent(pairingId)}`,
      {
        method: "GET",
        token: session.token,
      }
    )

    return response.pairing
  }

  public async listPhoneDevices(): Promise<PhonePairingSessionSummary[]> {
    const session = this.getStoredSession()
    if (!session?.token) {
      throw new Error("Please log in before loading paired phones.")
    }

    const response = await this.request<PhoneDevicesResponse>("/api/phone/devices", {
      method: "GET",
      token: session.token,
    })

    return response.devices
  }

  public async listPhoneEvents(input?: {
    pairingId?: string
    after?: string | null
  }): Promise<PhoneRelayEventSummary[]> {
    const session = this.getStoredSession()
    if (!session?.token) {
      throw new Error("Please log in before loading phone relay events.")
    }

    const query = new URLSearchParams()
    if (input?.pairingId) {
      query.set("pairingId", input.pairingId)
    }
    if (input?.after) {
      query.set("after", input.after)
    }

    const suffix = query.toString() ? `?${query.toString()}` : ""
    const response = await this.request<PhoneEventsResponse>(
      `/api/phone/events${suffix}`,
      {
        method: "GET",
        token: session.token,
      }
    )

    return response.events
  }

  public async listIntegrations(): Promise<ConnectedAppIntegration[]> {
    const session = this.getStoredSession()
    if (!session?.token) {
      throw new Error("Please log in before loading connected apps.")
    }

    const response = await this.request<IntegrationsResponse>("/api/integrations", {
      method: "GET",
      token: session.token,
    })

    return response.integrations
  }

  public async createIntegrationConnectSession(
    provider: IntegrationProvider
  ): Promise<IntegrationConnectResponse> {
    const session = this.getStoredSession()
    if (!session?.token) {
      throw new Error("Please log in before connecting an app.")
    }

    return this.request<IntegrationConnectApiResponse>(
      `/api/integrations/${encodeURIComponent(provider)}/connect`,
      {
        method: "POST",
        token: session.token,
      }
    )
  }

  public async disconnectIntegration(provider: IntegrationProvider): Promise<void> {
    const session = this.getStoredSession()
    if (!session?.token) {
      throw new Error("Please log in before disconnecting an app.")
    }

    await this.request<{ success: boolean }>(
      `/api/integrations/${encodeURIComponent(provider)}`,
      {
        method: "DELETE",
        token: session.token,
      }
    )
  }

  public looksLikeIntegrationAssistantRequest(message: string): boolean {
    return /\b(gmail|calendar|notion)\b/i.test(
      String(message || "")
    )
  }

  public async runIntegrationAssistantAction(input: {
    message: string
    chatHistory?: IntegrationAssistantChatTurn[]
  }): Promise<IntegrationAssistantResponse> {
    const session = this.getStoredSession()
    if (!session?.token) {
      throw new Error("Please log in before using connected apps.")
    }

    return this.request<IntegrationAssistantApiResponse>(
      "/api/integrations/assistant-action",
      {
        method: "POST",
        token: session.token,
        body: {
          message: input.message,
          chatHistory: input.chatHistory || [],
        },
      }
    )
  }

  private setStoredSession(session: AuthSession | null): void {
    store.set("authSession", session)
  }

  private clearSession(): void {
    store.set("authSession", null)
  }

  private shouldUseLocalChatFallback(error: unknown): boolean {
    if (!(error instanceof BackendRequestError)) {
      return false
    }

    const normalizedMessage = error.message.toLowerCase()
    return (
      error.status === undefined ||
      error.status === 404 ||
      (error.status === 401 && normalizedMessage.includes("invalid api key"))
    )
  }

  private isLocalChatThreadId(threadId: string): boolean {
    return threadId.startsWith("local-chat-")
  }

  private getLocalChatUserId(): string {
    return this.getStoredSession()?.user?.id || "local-user"
  }

  private normalizeLocalThreadTitle(title?: string): string {
    const normalized = String(title || "").replace(/\s+/g, " ").trim()
    if (!normalized) {
      return "New chat"
    }

    return normalized.length <= 80
      ? normalized
      : `${normalized.slice(0, 77).trimEnd()}...`
  }

  private listLocalChatThreads(mode: AssistantChatMode): ChatThreadSummary[] {
    return store
      .get("localChat")
      .threads.filter((thread) => thread.mode === mode)
      .sort((a, b) => {
        const bTime = Date.parse(b.lastMessageAt || b.updatedAt || b.createdAt || "")
        const aTime = Date.parse(a.lastMessageAt || a.updatedAt || a.createdAt || "")
        return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0)
      })
  }

  private createLocalChatThread(
    mode: AssistantChatMode,
    title?: string
  ): ChatThreadSummary {
    const now = new Date().toISOString()
    const thread: ChatThreadSummary = {
      id: `local-chat-${randomUUID()}`,
      userId: this.getLocalChatUserId(),
      mode,
      title: this.normalizeLocalThreadTitle(title),
      preview: "",
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
    }
    const localChat = store.get("localChat")
    store.set("localChat", {
      threads: [thread, ...localChat.threads.filter((entry) => entry.id !== thread.id)],
      messagesByThreadId: {
        ...localChat.messagesByThreadId,
        [thread.id]: [],
      },
    })
    return thread
  }

  private getLocalChatThread(threadId: string): ChatThreadSummary | null {
    return (
      store.get("localChat").threads.find((thread) => thread.id === threadId) || null
    )
  }

  private getLocalChatMessages(threadId: string): ChatMessagesResponse {
    const thread = this.getLocalChatThread(threadId)
    if (!thread) {
      throw new Error("Chat thread not found.")
    }

    return {
      thread,
      messages: store.get("localChat").messagesByThreadId[threadId] || [],
    }
  }

  private appendLocalChatMessage(input: {
    threadId: string
    role: FollowUpRole
    content: string
  }): ChatMessageResponse {
    const localChat = store.get("localChat")
    const existingThread = localChat.threads.find(
      (thread) => thread.id === input.threadId
    )
    if (!existingThread) {
      throw new Error("Chat thread not found.")
    }

    const now = new Date().toISOString()
    const content = input.content.replace(/\s+$/g, "")
    const message: PersistedChatMessage = {
      id: `local-msg-${randomUUID()}`,
      threadId: existingThread.id,
      userId: existingThread.userId || this.getLocalChatUserId(),
      role: input.role,
      content,
      createdAt: now,
    }
    const previousMessages = localChat.messagesByThreadId[existingThread.id] || []
    const preview = content.replace(/\s+/g, " ").slice(0, 160)
    const title =
      input.role === "user" &&
      (!existingThread.title || existingThread.title === "New chat")
        ? this.normalizeLocalThreadTitle(content)
        : existingThread.title
    const updatedThread: ChatThreadSummary = {
      ...existingThread,
      title,
      preview,
      updatedAt: now,
      lastMessageAt: now,
    }

    store.set("localChat", {
      threads: [
        updatedThread,
        ...localChat.threads.filter((thread) => thread.id !== existingThread.id),
      ],
      messagesByThreadId: {
        ...localChat.messagesByThreadId,
        [existingThread.id]: [...previousMessages, message].slice(-300),
      },
    })

    return {
      thread: updatedThread,
      message,
    }
  }

  private async request<T>(
    pathname: string,
    options: {
      method: "GET" | "POST" | "PATCH" | "DELETE"
      token?: string
      body?: unknown
    }
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

    let response: Response
    try {
      response = await fetch(`${BACKEND_URL}${pathname}`, {
        method: options.method,
        headers,
        body:
          options.body !== undefined ? JSON.stringify(options.body) : undefined,
      })
    } catch (error) {
      throw new BackendRequestError(
        `Cannot reach the backend at ${BACKEND_URL}. Start the backend service first.`
      )
    }

    const text = await response.text()
    let data = {} as T & BackendErrorShape
    if (text) {
      try {
        data = JSON.parse(text) as T & BackendErrorShape
      } catch (error) {
        throw new BackendRequestError(
          `Backend returned invalid JSON for ${pathname}.`,
          response.status
        )
      }
    }

    if (!response.ok) {
      throw new BackendRequestError(
        this.getBackendErrorMessage(data as BackendErrorShape) ||
          `Backend request failed with status ${response.status}.`,
        response.status
      )
    }

    return data
  }

  private isAuthFailure(error: unknown): boolean {
    if (error instanceof BackendRequestError) {
      return error.status === 401
    }

    if (error instanceof Error) {
      const normalized = error.message.toLowerCase()
      return (
        normalized === "authentication required." ||
        normalized === "user session is no longer valid."
      )
    }

    return false
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message
    }

    return "Unexpected backend error."
  }

  private getBackendErrorMessage(data: BackendErrorShape): string | null {
    if (typeof data.error === "string" && data.error.trim()) {
      return data.error
    }

    if (
      data.error &&
      typeof data.error === "object" &&
      typeof data.error.message === "string" &&
      data.error.message.trim()
    ) {
      return data.error.message
    }

    if (typeof data.message === "string" && data.message.trim()) {
      return data.message
    }

    return null
  }
}

export const backendClient = new BackendClient()
