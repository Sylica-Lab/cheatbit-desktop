console.log("Preload script starting...")
import { contextBridge, ipcRenderer } from "electron"
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

export const PROCESSING_EVENTS = {
  //global states
  UNAUTHORIZED: "processing-unauthorized",
  NO_SCREENSHOTS: "processing-no-screenshots",
  OUT_OF_CREDITS: "out-of-credits",
  API_KEY_INVALID: "api-key-invalid",

  //states for generating the initial solution
  INITIAL_START: "initial-start",
  PROBLEM_EXTRACTED: "problem-extracted",
  SOLUTION_SUCCESS: "solution-success",
  INITIAL_SOLUTION_ERROR: "solution-error",
  RESET: "reset",

  //states for processing the debugging
  DEBUG_START: "debug-start",
  DEBUG_SUCCESS: "debug-success",
  DEBUG_ERROR: "debug-error"
} as const

const LIVE_INTERVIEW_STATE_EVENT = "live-interview-state"
const COMPUTER_USE_STATE_EVENT = "computer-use-state"
const TEXT_FOLLOW_UP_STREAM_EVENT = "text-follow-up-stream"
const SOLUTION_STREAM_EVENT = "solution-stream"
const DESKTOP_UPDATE_STATE_EVENT = "updates:state"
const SHOW_UNINSTALL_OFFBOARDING_EVENT = "show-uninstall-offboarding"

// At the top of the file
console.log("Preload script is running")

const electronAPI = {
  getAuthState: () => ipcRenderer.invoke("auth:get-state") as Promise<AuthState>,
  register: (payload: { name: string; email: string; password: string }) =>
    ipcRenderer.invoke("auth:register", payload) as Promise<AuthState>,
  login: (payload: { email: string; password: string }) =>
    ipcRenderer.invoke("auth:login", payload) as Promise<AuthState>,
  logout: () =>
    ipcRenderer.invoke("auth:logout") as Promise<{ success: boolean }>,
  getAccountDashboard: () =>
    ipcRenderer.invoke("auth:get-dashboard") as Promise<UserDashboardData>,
  createCheckoutSession: () =>
    ipcRenderer.invoke("auth:create-checkout-session") as Promise<BillingSessionResponse>,
  createBillingPortalSession: () =>
    ipcRenderer.invoke("auth:create-billing-portal-session") as Promise<BillingSessionResponse>,
  requestMicrophoneAccess: () =>
    ipcRenderer.invoke("permissions:request-microphone") as Promise<{
      granted: boolean
      status: string
      error?: string
    }>,
  listChatThreads: (payload?: { mode?: AssistantChatMode }) =>
    ipcRenderer.invoke("chat:list-threads", payload) as Promise<
      { success: true; data: { threads: ChatThreadSummary[] } } | { success: false; error: string }
    >,
  createChatThread: (payload?: { mode?: AssistantChatMode; title?: string }) =>
    ipcRenderer.invoke("chat:create-thread", payload) as Promise<
      { success: true; data: { thread: ChatThreadSummary } } | { success: false; error: string }
    >,
  getChatMessages: (payload: { threadId: string }) =>
    ipcRenderer.invoke("chat:get-messages", payload) as Promise<
      {
        success: true
        data: { thread: ChatThreadSummary; messages: PersistedChatMessage[] }
      } | { success: false; error: string }
    >,
  appendChatMessage: (payload: {
    threadId: string
    role: "user" | "assistant"
    content: string
  }) =>
    ipcRenderer.invoke("chat:append-message", payload) as Promise<
      {
        success: true
        data: { thread: ChatThreadSummary; message: PersistedChatMessage }
      } | { success: false; error: string }
    >,
  getLiveInterviewState: () =>
    ipcRenderer.invoke("live:get-state") as Promise<
      { success: true; data: { state: LiveInterviewState } } | { success: false; error: string }
    >,
  startLiveInterview: () =>
    ipcRenderer.invoke("live:start") as Promise<
      { success: true; data: LiveInterviewStartData } | { success: false; error: string }
    >,
  stopLiveInterview: () =>
    ipcRenderer.invoke("live:stop") as Promise<
      { success: true; data: { state: LiveInterviewState } } | { success: false; error: string }
    >,
  addLiveInterviewInstruction: (payload: { content: string }) =>
    ipcRenderer.invoke("live:add-instruction", payload) as Promise<
      { success: true; data: LiveInterviewInstructionData } | { success: false; error: string }
    >,
  addLiveInterviewTranscript: (payload: { content: string }) =>
    ipcRenderer.invoke("live:add-transcript", payload) as Promise<
      { success: true; data: LiveInterviewTranscriptData } | { success: false; error: string }
    >,
  addLiveInterviewAudioChunk: (payload: { audioBase64: string; mimeType: string }) =>
    ipcRenderer.invoke("live:add-audio-chunk", payload) as Promise<
      { success: true; data: LiveInterviewTranscriptData } | { success: false; error: string }
    >,
  getComputerUseState: () =>
    ipcRenderer.invoke("computer-use:get-state") as Promise<
      { success: true; data: { state: ComputerUseState } } | { success: false; error: string }
    >,
  startComputerUseTask: (payload: { task: string }) =>
    ipcRenderer.invoke("computer-use:start-task", payload) as Promise<
      { success: true; data: ComputerUseStartData } | { success: false; error: string }
    >,
  stopComputerUseTask: () =>
    ipcRenderer.invoke("computer-use:stop-task") as Promise<
      { success: true; data: { state: ComputerUseState } } | { success: false; error: string }
    >,
  resumeComputerUseAfterSecret: () =>
    ipcRenderer.invoke("computer-use:resume-after-secret") as Promise<
      { success: true; data: ComputerUseResumeData } | { success: false; error: string }
    >,
  submitTextFollowUp: (payload: TextFollowUpRequest) =>
    ipcRenderer.invoke("submit-text-follow-up", payload) as Promise<
      { success: true; data: TextFollowUpResponse } | { success: false; error: string }
    >,
  onTextFollowUpStream: (callback: (event: TextFollowUpStreamEvent) => void) => {
    const subscription = (_: unknown, event: TextFollowUpStreamEvent) => callback(event)
    ipcRenderer.on(TEXT_FOLLOW_UP_STREAM_EVENT, subscription)
    return () => {
      ipcRenderer.removeListener(TEXT_FOLLOW_UP_STREAM_EVENT, subscription)
    }
  },
  // Original methods
  openSubscriptionPortal: async (authData: { id: string; email: string }) => {
    return ipcRenderer.invoke("open-subscription-portal", authData)
  },
  openSettingsPortal: () => ipcRenderer.invoke("open-settings-portal"),
  beginUninstall: () =>
    ipcRenderer.invoke("app:begin-uninstall") as Promise<
      { success: true } | { success: false; error: string }
    >,
  updateContentDimensions: (dimensions: { width: number; height: number }) =>
    ipcRenderer.invoke("update-content-dimensions", dimensions),
  clearStore: () => ipcRenderer.invoke("clear-store"),
  getScreenshots: () => ipcRenderer.invoke("get-screenshots"),
  deleteScreenshot: (path: string) =>
    ipcRenderer.invoke("delete-screenshot", path),
  toggleMainWindow: async () => {
    console.log("toggleMainWindow called from preload")
    try {
      const result = await ipcRenderer.invoke("toggle-window")
      console.log("toggle-window result:", result)
      return result
    } catch (error) {
      console.error("Error in toggleMainWindow:", error)
      throw error
    }
  },
  quitApp: () => ipcRenderer.invoke("quit-app"),
  // Event listeners
  onScreenshotTaken: (
    callback: (data: { path: string; preview: string }) => void
  ) => {
    const subscription = (_: any, data: { path: string; preview: string }) =>
      callback(data)
    ipcRenderer.on("screenshot-taken", subscription)
    return () => {
      ipcRenderer.removeListener("screenshot-taken", subscription)
    }
  },
  onResetView: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("reset-view", subscription)
    return () => {
      ipcRenderer.removeListener("reset-view", subscription)
    }
  },
  onSolutionStart: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on(PROCESSING_EVENTS.INITIAL_START, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.INITIAL_START, subscription)
    }
  },
  onDebugStart: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on(PROCESSING_EVENTS.DEBUG_START, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.DEBUG_START, subscription)
    }
  },
  onDebugSuccess: (callback: (data: any) => void) => {
    ipcRenderer.on("debug-success", (_event, data) => callback(data))
    return () => {
      ipcRenderer.removeListener("debug-success", (_event, data) =>
        callback(data)
      )
    }
  },
  onDebugError: (callback: (error: string) => void) => {
    const subscription = (_: any, error: string) => callback(error)
    ipcRenderer.on(PROCESSING_EVENTS.DEBUG_ERROR, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.DEBUG_ERROR, subscription)
    }
  },
  onSolutionError: (callback: (error: string) => void) => {
    const subscription = (_: any, error: string) => callback(error)
    ipcRenderer.on(PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR, subscription)
    return () => {
      ipcRenderer.removeListener(
        PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
        subscription
      )
    }
  },
  onProcessingNoScreenshots: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on(PROCESSING_EVENTS.NO_SCREENSHOTS, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.NO_SCREENSHOTS, subscription)
    }
  },
  onOutOfCredits: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on(PROCESSING_EVENTS.OUT_OF_CREDITS, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.OUT_OF_CREDITS, subscription)
    }
  },
  onProblemExtracted: (callback: (data: any) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on(PROCESSING_EVENTS.PROBLEM_EXTRACTED, subscription)
    return () => {
      ipcRenderer.removeListener(
        PROCESSING_EVENTS.PROBLEM_EXTRACTED,
        subscription
      )
    }
  },
  onSolutionSuccess: (callback: (data: any) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on(PROCESSING_EVENTS.SOLUTION_SUCCESS, subscription)
    return () => {
      ipcRenderer.removeListener(
        PROCESSING_EVENTS.SOLUTION_SUCCESS,
        subscription
      )
    }
  },
  onSolutionStream: (callback: (data: any) => void) => {
    const subscription = (_: unknown, data: any) => callback(data)
    ipcRenderer.on(SOLUTION_STREAM_EVENT, subscription)
    return () => {
      ipcRenderer.removeListener(SOLUTION_STREAM_EVENT, subscription)
    }
  },
  onUnauthorized: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on(PROCESSING_EVENTS.UNAUTHORIZED, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.UNAUTHORIZED, subscription)
    }
  },
  onLiveInterviewState: (callback: (state: LiveInterviewState) => void) => {
    const subscription = (_: unknown, state: LiveInterviewState) => callback(state)
    ipcRenderer.on(LIVE_INTERVIEW_STATE_EVENT, subscription)
    return () => {
      ipcRenderer.removeListener(LIVE_INTERVIEW_STATE_EVENT, subscription)
    }
  },
  onComputerUseState: (callback: (state: ComputerUseState) => void) => {
    const subscription = (_: unknown, state: ComputerUseState) => callback(state)
    ipcRenderer.on(COMPUTER_USE_STATE_EVENT, subscription)
    return () => {
      ipcRenderer.removeListener(COMPUTER_USE_STATE_EVENT, subscription)
    }
  },
  // External URL handler
  openLink: (url: string) => ipcRenderer.invoke("openLink", url),
  triggerScreenshot: () => ipcRenderer.invoke("trigger-screenshot"),
  triggerRegionScreenshot: () => ipcRenderer.invoke("trigger-region-screenshot"),
  triggerProcessScreenshots: () =>
    ipcRenderer.invoke("trigger-process-screenshots"),
  triggerReset: () => ipcRenderer.invoke("trigger-reset"),
  triggerMoveLeft: () => ipcRenderer.invoke("trigger-move-left"),
  triggerMoveRight: () => ipcRenderer.invoke("trigger-move-right"),
  triggerMoveUp: () => ipcRenderer.invoke("trigger-move-up"),
  triggerMoveDown: () => ipcRenderer.invoke("trigger-move-down"),
  onSubscriptionUpdated: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("subscription-updated", subscription)
    return () => {
      ipcRenderer.removeListener("subscription-updated", subscription)
    }
  },
  onSubscriptionPortalClosed: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("subscription-portal-closed", subscription)
    return () => {
      ipcRenderer.removeListener("subscription-portal-closed", subscription)
    }
  },
  onReset: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on(PROCESSING_EVENTS.RESET, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.RESET, subscription)
    }
  },
  getUpdateState: () =>
    ipcRenderer.invoke("updates:get-state") as Promise<
      { success: true; data: { state: DesktopUpdateState } } | { success: false; error: string }
    >,
  downloadUpdate: () =>
    ipcRenderer.invoke("updates:download") as Promise<
      { success: true; data?: { state: DesktopUpdateState } } | { success: false; error: string }
    >,
  installUpdate: () =>
    ipcRenderer.invoke("updates:install") as Promise<
      { success: true } | { success: false; error: string }
    >,
  onUpdateState: (callback: (state: DesktopUpdateState) => void) => {
    const subscription = (_: unknown, state: DesktopUpdateState) => callback(state)
    ipcRenderer.on(DESKTOP_UPDATE_STATE_EVENT, subscription)
    return () => {
      ipcRenderer.removeListener(DESKTOP_UPDATE_STATE_EVENT, subscription)
    }
  },
  decrementCredits: () => ipcRenderer.invoke("decrement-credits"),
  onCreditsUpdated: (callback: (credits: number) => void) => {
    const subscription = (_event: any, credits: number) => callback(credits)
    ipcRenderer.on("credits-updated", subscription)
    return () => {
      ipcRenderer.removeListener("credits-updated", subscription)
    }
  },
  getPlatform: () => process.platform,
  
  // Configuration methods
  getConfig: () => ipcRenderer.invoke("get-config"),
  updateConfig: (config: Partial<AppConfig>) => 
    ipcRenderer.invoke("update-config", config),
  onShowSettings: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("show-settings-dialog", subscription)
    return () => {
      ipcRenderer.removeListener("show-settings-dialog", subscription)
    }
  },
  onShowUninstallOffboarding: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on(SHOW_UNINSTALL_OFFBOARDING_EVENT, subscription)
    return () => {
      ipcRenderer.removeListener(SHOW_UNINSTALL_OFFBOARDING_EVENT, subscription)
    }
  },
  validateApiKey: (apiKey: string, provider?: ApiProvider) => 
    ipcRenderer.invoke("validate-api-key", apiKey, provider),
  openExternal: (url: string) => ipcRenderer.invoke("open-external-url", url),
  onApiKeyInvalid: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on(PROCESSING_EVENTS.API_KEY_INVALID, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.API_KEY_INVALID, subscription)
    }
  },
  removeListener: (eventName: string, callback: (...args: any[]) => void) => {
    ipcRenderer.removeListener(eventName, callback)
  },
  onDeleteLastScreenshot: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("delete-last-screenshot", subscription)
    return () => {
      ipcRenderer.removeListener("delete-last-screenshot", subscription)
    }
  },
  deleteLastScreenshot: () => ipcRenderer.invoke("delete-last-screenshot")
}

// Before exposing the API
console.log(
  "About to expose electronAPI with methods:",
  Object.keys(electronAPI)
)

// Expose the API
contextBridge.exposeInMainWorld("electronAPI", electronAPI)

console.log("electronAPI exposed to window")

// Add this focus restoration handler
ipcRenderer.on("restore-focus", () => {
  // Try to focus the active element if it exists
  const activeElement = document.activeElement as HTMLElement
  if (activeElement && typeof activeElement.focus === "function") {
    activeElement.focus()
  }
})

// Remove auth-callback handling - no longer needed
