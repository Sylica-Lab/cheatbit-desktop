import { store } from "./store"
import type {
  BillingSessionResponse,
  AuthSession,
  AuthState,
  UserDashboardData,
  UsageAction,
  UsageDecision,
} from "../shared/backendAuth"

const DEFAULT_BACKEND_URL = "http://127.0.0.1:8787"
const BACKEND_URL =
  process.env.INTERVIEW_CODER_BACKEND_URL?.trim() || DEFAULT_BACKEND_URL

interface BackendErrorShape {
  error?: string
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

export class BackendClient {
  public getBaseUrl(): string {
    return BACKEND_URL
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
      this.clearSession()

      return {
        authenticated: false,
        session: null,
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

  public logout(): void {
    this.clearSession()
  }

  public async consumeUsage(action: UsageAction): Promise<UsageDecision> {
    const session = this.getStoredSession()
    if (!session?.token) {
      return {
        allowed: false,
        error: "Please log in before using CheatBit.",
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
      const normalized = message.toLowerCase()
      if (
        normalized.includes("authentication") ||
        normalized.includes("session")
      ) {
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

  private setStoredSession(session: AuthSession | null): void {
    store.set("authSession", session)
  }

  private clearSession(): void {
    store.set("authSession", null)
  }

  private async request<T>(
    pathname: string,
    options: {
      method: "GET" | "POST" | "PATCH"
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
      throw new Error(
        `Cannot reach the backend at ${BACKEND_URL}. Start the backend service first.`
      )
    }

    const text = await response.text()
    const data = text ? (JSON.parse(text) as T & BackendErrorShape) : ({} as T)

    if (!response.ok) {
      throw new Error(
        (data as BackendErrorShape).error ||
          `Backend request failed with status ${response.status}.`
      )
    }

    return data
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message
    }

    return "Unexpected backend error."
  }
}

export const backendClient = new BackendClient()
