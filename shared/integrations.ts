export type IntegrationProvider = "google" | "notion"

export type IntegrationApp = "gmail" | "google_calendar" | "notion"

export interface ConnectedAppIntegration {
  app: IntegrationApp
  provider: IntegrationProvider
  label: string
  connected: boolean
  configured: boolean
  statusText: string
  accountEmail: string | null
  accountName: string | null
  workspaceName: string | null
  connectedAt: string | null
  lastSyncedAt: string | null
  supports: string[]
  sharedConnectionLabel?: string | null
}

export interface IntegrationConnectResponse {
  provider: IntegrationProvider
  url: string
}

export interface IntegrationAssistantChatTurn {
  role: "user" | "assistant"
  content: string
}

export interface IntegrationAssistantRequest {
  message: string
  chatHistory?: IntegrationAssistantChatTurn[]
}

export interface IntegrationAssistantResponse {
  handled: boolean
  reply: string
  provider: IntegrationProvider | null
  app: IntegrationApp | null
}
