import { AssistantChat, GENERAL_CHAT_QUERY_KEY } from "./AssistantChat"

interface GeneralChatPanelProps {
  computerTaskRequest?: {
    id: string
    task: string
  } | null
  onComputerTaskRequestConsumed?: () => void
}

export function GeneralChatPanel({
  computerTaskRequest = null,
  onComputerTaskRequestConsumed,
}: GeneralChatPanelProps) {
  return (
    <div className="w-[22rem] min-w-[22rem] max-w-[22rem] space-y-3">
      <AssistantChat
        queryKey={GENERAL_CHAT_QUERY_KEY}
        mode="general"
        computerTaskRequest={computerTaskRequest}
        onComputerTaskRequestConsumed={onComputerTaskRequestConsumed}
        placeholder="Message Sylica AI..."
        maxHeightClassName="max-h-[22rem]"
        className="w-full min-w-0"
      />
    </div>
  )
}
