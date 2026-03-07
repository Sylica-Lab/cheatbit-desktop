export type FollowUpRole = "user" | "assistant";

export interface FollowUpChatTurn {
  role: FollowUpRole;
  content: string;
}

export interface TextFollowUpRequest {
  message: string;
  currentContext: string;
  chatHistory?: FollowUpChatTurn[];
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
