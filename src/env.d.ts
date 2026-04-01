/// <reference types="vite/client" />

import type { ApiProvider, AppConfig } from "../shared/aiConfig"
import type {
  AuthState,
  BillingSessionResponse,
  UserDashboardData
} from "../shared/backendAuth"
import type {
  AssistantChatMode,
  ChatThreadSummary,
  ComputerUseResumeData,
  ComputerUseStartData,
  ComputerUseState,
  LiveInterviewInstructionData,
  LiveInterviewStartData,
  LiveInterviewState,
  LiveInterviewTranscriptData,
  PersistedChatMessage,
  TextFollowUpRequest,
  TextFollowUpStreamEvent,
  TextFollowUpResponse
} from "../shared/followUpChat"
import type { DesktopUpdateState } from "../shared/desktopUpdates"
import type {
  CreatePhonePairingSessionResponse,
  PhonePairingSessionSummary,
  PhoneRelayEventSummary,
} from "../shared/phoneRelay"
import type {
  CreateLocalPhonePairingSessionResponse,
  LocalPhoneRelayState,
} from "../shared/localPhoneRelay"
import type {
  ConnectedAppIntegration,
  IntegrationConnectResponse,
  IntegrationProvider,
} from "../shared/integrations"

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
  readonly NODE_ENV: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface ElectronAPI {
  getAuthState: () => Promise<AuthState>
  register: (payload: {
    name: string
    email: string
    password: string
  }) => Promise<AuthState>
  login: (payload: {
    email: string
    password: string
  }) => Promise<AuthState>
  logout: () => Promise<{ success: boolean }>
  getAccountDashboard: () => Promise<UserDashboardData>
  listIntegrations: () => Promise<ConnectedAppIntegration[]>
  createIntegrationConnectSession: (payload: {
    provider: IntegrationProvider
  }) => Promise<IntegrationConnectResponse>
  disconnectIntegration: (payload: {
    provider: IntegrationProvider
  }) => Promise<{ success: true }>
  createCheckoutSession: () => Promise<BillingSessionResponse>
  createBillingPortalSession: () => Promise<BillingSessionResponse>
  createPhonePairingSession: (payload?: {
    desktopDeviceName?: string
  }) => Promise<
    { success: true; data: CreatePhonePairingSessionResponse } | { success: false; error: string }
  >
  getPhonePairingSession: (payload: {
    pairingId: string
  }) => Promise<
    { success: true; data: { pairing: PhonePairingSessionSummary } } | { success: false; error: string }
  >
  listPhoneDevices: () => Promise<
    { success: true; data: { devices: PhonePairingSessionSummary[] } } | { success: false; error: string }
  >
  listPhoneEvents: (payload?: {
    pairingId?: string
    after?: string | null
  }) => Promise<
    { success: true; data: { events: PhoneRelayEventSummary[] } } | { success: false; error: string }
  >
  getLocalPhoneRelayState: () => Promise<
    { success: true; data: { state: LocalPhoneRelayState } } | { success: false; error: string }
  >
  createLocalPhonePairingSession: (payload?: {
    desktopDeviceName?: string
  }) => Promise<
    {
      success: true
      data: {
        pairing: CreateLocalPhonePairingSessionResponse
        state: LocalPhoneRelayState
      }
    } | { success: false; error: string }
  >
  openPhoneRelayWindow: () => Promise<
    { success: true } | { success: false; error: string }
  >
  requestMicrophoneAccess: () => Promise<{
    granted: boolean
    status: string
    error?: string
  }>
  listChatThreads: (payload?: {
    mode?: AssistantChatMode
  }) => Promise<
    { success: true; data: { threads: ChatThreadSummary[] } } | { success: false; error: string }
  >
  createChatThread: (payload?: {
    mode?: AssistantChatMode
    title?: string
  }) => Promise<
    { success: true; data: { thread: ChatThreadSummary } } | { success: false; error: string }
  >
  getChatMessages: (payload: {
    threadId: string
  }) => Promise<
    {
      success: true
      data: { thread: ChatThreadSummary; messages: PersistedChatMessage[] }
    } | { success: false; error: string }
  >
  appendChatMessage: (payload: {
    threadId: string
    role: "user" | "assistant"
    content: string
  }) => Promise<
    {
      success: true
      data: { thread: ChatThreadSummary; message: PersistedChatMessage }
    } | { success: false; error: string }
  >
  getLiveInterviewState: () => Promise<
    { success: true; data: { state: LiveInterviewState } } | { success: false; error: string }
  >
  startLiveInterview: () => Promise<
    { success: true; data: LiveInterviewStartData } | { success: false; error: string }
  >
  stopLiveInterview: () => Promise<
    { success: true; data: { state: LiveInterviewState } } | { success: false; error: string }
  >
  addLiveInterviewInstruction: (payload: { content: string }) => Promise<
    { success: true; data: LiveInterviewInstructionData } | { success: false; error: string }
  >
  addLiveInterviewTranscript: (payload: { content: string }) => Promise<
    { success: true; data: LiveInterviewTranscriptData } | { success: false; error: string }
  >
  addLiveInterviewAudioChunk: (payload: {
    audioBase64: string
    mimeType: string
  }) => Promise<
    { success: true; data: LiveInterviewTranscriptData } | { success: false; error: string }
  >
  getComputerUseState: () => Promise<
    { success: true; data: { state: ComputerUseState } } | { success: false; error: string }
  >
  startComputerUseTask: (payload: { task: string }) => Promise<
    { success: true; data: ComputerUseStartData } | { success: false; error: string }
  >
  stopComputerUseTask: () => Promise<
    { success: true; data: { state: ComputerUseState } } | { success: false; error: string }
  >
  resumeComputerUseAfterSecret: () => Promise<
    { success: true; data: ComputerUseResumeData } | { success: false; error: string }
  >
  submitTextFollowUp: (
    payload: TextFollowUpRequest
  ) => Promise<
    { success: true; data: TextFollowUpResponse } | { success: false; error: string }
  >
  onTextFollowUpStream: (
    callback: (event: TextFollowUpStreamEvent) => void
  ) => () => void
  openSubscriptionPortal: (authData: {
    id: string
    email: string
  }) => Promise<{ success: boolean; error?: string }>
  beginUninstall: () => Promise<{ success: true } | { success: false; error: string }>
  updateContentDimensions: (dimensions: {
    width: number
    height: number
  }) => Promise<void>
  clearStore: () => Promise<{ success: boolean; error?: string }>
  getScreenshots: () => Promise<{
    success: boolean
    previews?: Array<{ path: string; preview: string }> | null
    error?: string
  }>
  deleteScreenshot: (
    path: string
  ) => Promise<{ success: boolean; error?: string }>
  onScreenshotTaken: (
    callback: (data: { path: string; preview: string }) => void
  ) => () => void
  onResetView: (callback: () => void) => () => void
  onSolutionStart: (callback: () => void) => () => void
  onDebugStart: (callback: () => void) => () => void
  onDebugSuccess: (callback: (data: any) => void) => () => void
  onSolutionError: (callback: (error: string) => void) => () => void
  onProcessingNoScreenshots: (callback: () => void) => () => void
  onProblemExtracted: (callback: (data: any) => void) => () => void
  onSolutionSuccess: (callback: (data: any) => void) => () => void
  onSolutionStream: (callback: (data: any) => void) => () => void
  onUnauthorized: (callback: () => void) => () => void
  onLiveInterviewState: (
    callback: (state: LiveInterviewState) => void
  ) => () => void
  onComputerUseState: (
    callback: (state: ComputerUseState) => void
  ) => () => void
  onLocalPhoneRelayState: (
    callback: (state: LocalPhoneRelayState) => void
  ) => () => void
  onDebugError: (callback: (error: string) => void) => () => void
  openExternal: (
    url: string
  ) => Promise<{ success: boolean; error?: string }>
  toggleMainWindow: () => Promise<{ success: boolean; error?: string }>
  quitApp: () => Promise<{ success: boolean; error?: string }>
  triggerScreenshot: () => Promise<{ success: boolean; error?: string }>
  triggerRegionScreenshot: () => Promise<{
    success: boolean
    error?: string
    canceled?: boolean
  }>
  triggerProcessScreenshots: () => Promise<{ success: boolean; error?: string }>
  triggerReset: () => Promise<{ success: boolean; error?: string }>
  triggerMoveLeft: () => Promise<{ success: boolean; error?: string }>
  triggerMoveRight: () => Promise<{ success: boolean; error?: string }>
  triggerMoveUp: () => Promise<{ success: boolean; error?: string }>
  triggerMoveDown: () => Promise<{ success: boolean; error?: string }>
  onSubscriptionUpdated: (callback: () => void) => () => void
  onSubscriptionPortalClosed: (callback: () => void) => () => void
  getUpdateState: () => Promise<
    { success: true; data: { state: DesktopUpdateState } } | { success: false; error: string }
  >
  downloadUpdate: () => Promise<
    { success: true; data?: { state: DesktopUpdateState } } | { success: false; error: string }
  >
  installUpdate: () => Promise<{ success: true } | { success: false; error: string }>
  onUpdateState: (callback: (state: DesktopUpdateState) => void) => () => void
  getConfig: () => Promise<AppConfig>
  updateConfig: (config: Partial<AppConfig>) => Promise<AppConfig>
  validateApiKey: (
    apiKey: string,
    provider?: ApiProvider
  ) => Promise<{ valid: boolean; error?: string }>
  openLink: (
    url: string
  ) => Promise<{ success: boolean; error?: string }>
  openSettingsPortal: () => Promise<void>
  onShowSettings: (callback: () => void) => () => void
  onShowUninstallOffboarding: (callback: () => void) => () => void
  onApiKeyInvalid: (callback: () => void) => () => void
  onDeleteLastScreenshot: (callback: () => void) => () => void
  deleteLastScreenshot: () => Promise<{ success: boolean; error?: string }>
  removeListener: (eventName: string, callback: (...args: any[]) => void) => void
}

interface Window {
  electronAPI: ElectronAPI
  electron: {
    ipcRenderer: {
      on(channel: string, func: (...args: any[]) => void): void
      removeListener(channel: string, func: (...args: any[]) => void): void
    }
  }
  __CREDITS__: number
  __LANGUAGE__: string
  __IS_INITIALIZED__: boolean
  __AUTH_TOKEN__: string
}
