export type FollowUpRole = "user" | "assistant";
export type AssistantChatMode =
  | "follow_up"
  | "general"
  | "live_interview"
  | "computer_use"
  | "agent";
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
  requestId?: string;
  message: string;
  rawMessage?: string;
  currentContext: string;
  chatHistory?: FollowUpChatTurn[];
  mode?: AssistantChatMode;
  includeScreenContext?: boolean;
  voiceMode?: boolean;
}

export interface TextFollowUpResponse {
  reply: string;
}

export interface TextFollowUpStreamEvent {
  requestId: string;
  content: string;
  done: boolean;
  error?: string;
}

export type VoiceRealtimeEvent =
  | { type: "ready"; owner?: "widget" | "cursor" }
  | { type: "session_updated"; owner?: "widget" | "cursor" }
  | { type: "speech_started"; owner?: "widget" | "cursor" }
  | { type: "speech_stopped"; owner?: "widget" | "cursor" }
  | { type: "input_transcript_delta"; delta: string; owner?: "widget" | "cursor" }
  | { type: "input_transcript"; transcript: string; owner?: "widget" | "cursor" }
  | { type: "text_delta"; text: string; owner?: "widget" | "cursor" }
  | { type: "audio_delta"; audio: string; owner?: "widget" | "cursor" }
  | { type: "response_done"; owner?: "widget" | "cursor" }
  | { type: "error"; error: string; owner?: "widget" | "cursor" };

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
  | { type: "system_open"; target: string }
  | { type: "system_list_dir"; path: string; recursive?: boolean; pattern?: string }
  | { type: "system_search_files"; query: string; maxResults?: number }
  | { type: "system_read_file"; path: string; encoding?: "utf8" | "base64" }
  | {
      type: "system_write_file"
      path: string
      content: string
      encoding?: "utf8" | "base64"
      append?: boolean
    }
  | { type: "system_delete"; path: string; recursive?: boolean }
  | { type: "system_copy"; source: string; destination: string; recursive?: boolean; overwrite?: boolean }
  | { type: "system_move"; source: string; destination: string; overwrite?: boolean }
  | { type: "system_run_powershell"; command: string; elevated?: boolean; cwd?: string }
  | { type: "system_run_cmd"; command: string; cwd?: string }
  | { type: "system_screenshot"; region?: { x: number; y: number; width: number; height: number } }
  | { type: "system_get_state" }
  | { type: "exa_search"; query: string; numResults?: number }
  | { type: "screen_get_info" }
  | { type: "mouse_move"; x: number; y: number }
  | {
      type: "mouse_click"
      x?: number
      y?: number
      button?: "left" | "right" | "middle"
      double?: boolean
    }
  | {
      type: "mouse_drag"
      fromX: number
      fromY: number
      toX: number
      toY: number
      button?: "left" | "right" | "middle"
    }
  | { type: "mouse_scroll"; deltaY: number; x?: number; y?: number }
  | { type: "keyboard_type"; text: string; delayMs?: number }
  | { type: "keyboard_press"; keys: string }
  | { type: "narrate"; message: string }
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
