export type FollowUpRole = "user" | "assistant";
export type AssistantChatMode =
  | "follow_up"
  | "general"
  | "live_interview"
  | "computer_use";
export type LiveInterviewStatus = "idle" | "starting" | "running" | "stopping";
export type ComputerUseStatus =
  | "idle"
  | "starting"
  | "running"
  | "waiting_for_secret"
  | "stopping"
  | "completed"
  | "error";

export interface FollowUpChatTurn {
  role: FollowUpRole;
  content: string;
}

export interface TextFollowUpRequest {
  message: string;
  currentContext: string;
  chatHistory?: FollowUpChatTurn[];
  mode?: AssistantChatMode;
}

export interface TextFollowUpResponse {
  reply: string;
}

export interface FollowUpChatMessage extends FollowUpChatTurn {
  id: string;
  createdAt: number;
  pending?: boolean;
  error?: boolean;
}

export interface ChatThreadSummary {
  id: string;
  userId: string;
  mode: AssistantChatMode;
  title: string;
  preview: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastMessageAt: string | null;
}

export interface PersistedChatMessage extends FollowUpChatTurn {
  id: string;
  threadId: string;
  userId: string;
  createdAt: string | null;
}

export interface LiveInterviewState {
  status: LiveInterviewStatus;
  threadId: string | null;
  startedAt: string | null;
  lastUpdatedAt: string | null;
  isProcessing: boolean;
  latestTranscript: string;
  latestAnswer: string;
}

export interface LiveInterviewStartData {
  thread: ChatThreadSummary;
  state: LiveInterviewState;
}

export interface LiveInterviewInstructionData {
  thread: ChatThreadSummary;
  message: PersistedChatMessage;
  state: LiveInterviewState;
}

export interface LiveInterviewTranscriptData {
  state: LiveInterviewState;
}

export type BrowserAgentAction =
  | { type: "open_url"; url: string }
  | { type: "new_tab"; url?: string }
  | { type: "switch_tab"; tabIndex: number }
  | { type: "close_tab"; tabIndex?: number }
  | { type: "click"; targetId: string }
  | { type: "type"; targetId: string; text: string; submit?: boolean }
  | { type: "press_key"; key: string }
  | { type: "scroll"; direction: "up" | "down"; amount?: number }
  | { type: "select_option"; targetId: string; value: string }
  | { type: "upload_file"; targetId: string; filePath: string }
  | { type: "download_file"; targetId: string; suggestedPath?: string }
  | { type: "wait_for"; targetId?: string; timeoutMs?: number }
  | { type: "extract"; targetId?: string; question?: string }
  | { type: "finish"; result: string }
  | { type: "request_secret_input"; reason: string };

export interface ComputerUseState {
  status: ComputerUseStatus;
  threadId: string | null;
  task: string;
  currentUrl: string;
  currentTitle: string;
  currentAction: string;
  stepCount: number;
  needsSecretInput: boolean;
  latestError: string;
}

export interface ComputerUseStartData {
  thread: ChatThreadSummary;
  state: ComputerUseState;
}

export interface ComputerUseResumeData {
  state: ComputerUseState;
}

export const EMPTY_LIVE_INTERVIEW_STATE: LiveInterviewState = {
  status: "idle",
  threadId: null,
  startedAt: null,
  lastUpdatedAt: null,
  isProcessing: false,
  latestTranscript: "",
  latestAnswer: "",
};

export const EMPTY_COMPUTER_USE_STATE: ComputerUseState = {
  status: "idle",
  threadId: null,
  task: "",
  currentUrl: "",
  currentTitle: "",
  currentAction: "",
  stepCount: 0,
  needsSecretInput: false,
  latestError: "",
};
