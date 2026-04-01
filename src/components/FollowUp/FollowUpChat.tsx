import { AssistantChat } from "../Chat/AssistantChat"

export const FOLLOW_UP_CHAT_QUERY_KEY = ["follow_up_chat"] as const

interface FollowUpChatProps {
  currentContext: string
}

export function FollowUpChat({ currentContext }: FollowUpChatProps) {
  return (
    <AssistantChat
      queryKey={FOLLOW_UP_CHAT_QUERY_KEY}
      mode="follow_up"
      currentContext={currentContext}
      placeholder="Ask a follow-up..."
      maxHeightClassName="max-h-[13rem]"
      className="bg-transparent"
    />
  )
}
