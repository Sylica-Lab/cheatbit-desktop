import { AssistantChat, GENERAL_CHAT_QUERY_KEY } from "./AssistantChat"

interface VoiceAssistantPanelProps {
  computerTaskRequest?: {
    id: string
    task: string
  } | null
  voiceAutoStartSignal?: string | null
  onComputerTaskRequestConsumed?: () => void
}

export function VoiceAssistantPanel({
  computerTaskRequest = null,
  voiceAutoStartSignal = null,
  onComputerTaskRequestConsumed,
}: VoiceAssistantPanelProps) {
  return (
    <div className="w-full min-w-0 overflow-visible" style={{ animationDelay: "150ms" }}>
      <AssistantChat
        queryKey={GENERAL_CHAT_QUERY_KEY}
        mode="general"
        panelMode="voice"
        voiceFocused
        computerTaskRequest={computerTaskRequest}
        voiceAutoStartSignal={voiceAutoStartSignal}
        onComputerTaskRequestConsumed={onComputerTaskRequestConsumed}
        placeholder="Talk, search web, or find files..."
        maxHeightClassName="max-h-[50vh]"
        className="w-full max-w-full min-w-0"
      />
    </div>
  )
}
