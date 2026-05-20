import { Mic2 } from "lucide-react"
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
    <div className="w-full min-w-0 space-y-2 overflow-visible" style={{ animationDelay: "150ms" }}>
      <div className="flex items-center gap-2 px-1 pb-1.5 text-white/90 sylica-panel-switch">
        <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/[0.06] text-white/85">
          <Mic2 className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold text-white/92 tracking-tight">
            Voice
          </div>
          <p className="mt-0.5 truncate text-[9px] text-white/48">
            Talk naturally — Sylica uses your screen when helpful.
          </p>
        </div>
      </div>

      <AssistantChat
        queryKey={GENERAL_CHAT_QUERY_KEY}
        mode="general"
        panelMode="voice"
        voiceFocused
        computerTaskRequest={computerTaskRequest}
        voiceAutoStartSignal={voiceAutoStartSignal}
        onComputerTaskRequestConsumed={onComputerTaskRequestConsumed}
        placeholder="Talk or type to Sylica..."
        maxHeightClassName="max-h-[50vh]"
        className="w-full max-w-full min-w-0"
      />
    </div>
  )
}

