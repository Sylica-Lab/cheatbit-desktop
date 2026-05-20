export type AgentTaskStatus =
  | "idle"
  | "planning"
  | "awaiting_workspace"
  | "awaiting_approval"
  | "running"
  | "completed"
  | "error"
  | "stopped";

export type AgentPhaseStatus =
  | "pending"
  | "awaiting_approval"
  | "running"
  | "completed"
  | "rejected"
  | "error";

export type AgentEventType =
  | "info"
  | "thinking"
  | "approval"
  | "worker"
  | "artifact"
  | "error"
  | "done";

export type AgentArtifactType =
  | "code"
  | "design"
  | "presentation"
  | "research"
  | "document"
  | "other";

export interface AgentPhase {
  id: string;
  title: string;
  goal: string;
  status: AgentPhaseStatus;
  summary: string;
  requiresApproval: boolean;
}

export interface AgentEvent {
  id: string;
  taskId: string;
  type: AgentEventType;
  message: string;
  createdAt: string;
  phaseId?: string;
}

export interface AgentArtifact {
  id: string;
  type: AgentArtifactType;
  title: string;
  path: string;
  previewPath?: string;
  createdAt: string;
}

export interface AgentState {
  status: AgentTaskStatus;
  taskId: string | null;
  threadId: string | null;
  prompt: string;
  workspacePath: string;
  phases: AgentPhase[];
  activePhaseId: string | null;
  events: AgentEvent[];
  artifacts: AgentArtifact[];
  error: string;
}

export interface AgentStartData {
  state: AgentState;
}

export const EMPTY_AGENT_STATE: AgentState = {
  status: "idle",
  taskId: null,
  threadId: null,
  prompt: "",
  workspacePath: "",
  phases: [],
  activePhaseId: null,
  events: [],
  artifacts: [],
  error: "",
};
