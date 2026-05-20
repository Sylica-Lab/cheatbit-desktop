import React, { useEffect, useState, type CSSProperties } from "react"
import {
  Brain,
  Focus,
  LayoutDashboard,
  Mic2,
  MousePointer2,
  Sparkles,
} from "lucide-react"
import type { ComputerUseState } from "../../../shared/followUpChat"
import type { DesktopUpdateState } from "../../../shared/desktopUpdates"
import type { AgentState } from "../../../shared/agent"
import { useToast } from "../../contexts/toast"
import { COMMAND_KEY } from "../../utils/platform"
import { CheatbitMark } from "../Brand/CheatbitMark"
import InlineUpdateButton from "../Updates/InlineUpdateButton"
import {
  isRealtimeVoiceCurrentlyActive,
  isRealtimeVoiceCurrentlyHearing,
  isRealtimeVoiceCurrentlySpeaking,
} from "../Chat/AssistantChat"

function isComputerTaskActive(status: ComputerUseState["status"]): boolean {
  return (
    status === "starting" ||
    status === "running" ||
    status === "waiting_for_secret" ||
    status === "stopping"
  )
}

interface QueueCommandsProps {
  activeMode: "analyze" | "voice" | "live" | "agent"
  onOpenAnalyzeMode: () => void
  onOpenAgentMode: () => void
  onOpenVoiceMode?: () => void
  onTooltipVisibilityChange: (visible: boolean, height: number) => void
  screenshotCount?: number
  credits: number
  desktopUpdateState: DesktopUpdateState
  isMinimized: boolean
  onToggleMinimized: () => void
  computerUseState: ComputerUseState
  agentState: AgentState
  onDownloadUpdate: () => Promise<{ success: true } | { success: false; error: string }>
  onInstallUpdate: () => Promise<{ success: true } | { success: false; error: string }>
  onStartComputerTask: (task: string) => Promise<void> | void
  onStopComputerTask: () => Promise<void> | void
  onResumeComputerTask: () => Promise<void> | void
  isDockOnly?: boolean
}

const QueueCommands: React.FC<QueueCommandsProps> = ({
  activeMode,
  onOpenAnalyzeMode,
  onOpenAgentMode,
  onOpenVoiceMode,
  onTooltipVisibilityChange,
  screenshotCount = 0,
  credits,
  desktopUpdateState,
  isMinimized,
  onToggleMinimized,
  computerUseState,
  agentState,
  onDownloadUpdate,
  onInstallUpdate,
  isDockOnly = false,
}) => {
  const { showToast } = useToast()
  const dragRegionStyle: CSSProperties = { WebkitAppRegion: "drag" }
  const noDragStyle: CSSProperties = { WebkitAppRegion: "no-drag" }
  const [isGuideCursorEnabled, setIsGuideCursorEnabled] = useState(true)
  // Seed from live globals so re-mounting the dock (e.g. after closing the
  // voice window) doesn't drop the active animation while voice keeps running.
  const [isVoiceActive, setIsVoiceActive] = useState(() =>
    isRealtimeVoiceCurrentlyActive()
  )
  const [isVoiceHearing, setIsVoiceHearing] = useState(() =>
    isRealtimeVoiceCurrentlyHearing()
  )
  const [isVoiceSpeaking, setIsVoiceSpeaking] = useState(() =>
    isRealtimeVoiceCurrentlySpeaking()
  )

  useEffect(() => {
    const handleVoiceActive = (event: Event) => {
      const detail = (event as CustomEvent<boolean>).detail
      setIsVoiceActive(Boolean(detail))
    }
    const handleVoiceHearing = (event: Event) => {
      const detail = (event as CustomEvent<boolean>).detail
      setIsVoiceHearing(Boolean(detail))
    }
    const handleVoiceSpeaking = (event: Event) => {
      const detail = (event as CustomEvent<boolean>).detail
      setIsVoiceSpeaking(Boolean(detail))
    }
    window.addEventListener("sylica-voice-active", handleVoiceActive)
    window.addEventListener("sylica-voice-hearing", handleVoiceHearing)
    window.addEventListener("sylica-voice-speaking", handleVoiceSpeaking)
    // Re-sync on mount in case voice was already running when the dock mounted.
    setIsVoiceActive(isRealtimeVoiceCurrentlyActive())
    setIsVoiceHearing(isRealtimeVoiceCurrentlyHearing())
    setIsVoiceSpeaking(isRealtimeVoiceCurrentlySpeaking())
    return () => {
      window.removeEventListener("sylica-voice-active", handleVoiceActive)
      window.removeEventListener("sylica-voice-hearing", handleVoiceHearing)
      window.removeEventListener("sylica-voice-speaking", handleVoiceSpeaking)
    }
  }, [])

  useEffect(() => {
    onTooltipVisibilityChange(false, 0)
  }, [isMinimized, onTooltipVisibilityChange])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await window.electronAPI.getGuideCursorState()
      if (!cancelled && result.success) {
        setIsGuideCursorEnabled(result.data.enabled)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const openAccountDashboard = () => {
    window.dispatchEvent(new CustomEvent("open-account-dashboard"))
  }
  const openPhoneRelayWindow = () => {
    window.dispatchEvent(new CustomEvent("open-phone-relay"))
  }

  const handleScreenshot = async () => {
    onOpenAnalyzeMode()
    try {
      const result = await window.electronAPI.triggerScreenshot()
      if (!result.success) {
        showToast("Error", result.error || "Failed to take screenshot", "error")
      }
    } catch (error) {
      console.error("Error taking screenshot:", error)
      showToast("Error", "Failed to take screenshot", "error")
    }
  }

  const handleRegionScreenshot = async () => {
    onOpenAnalyzeMode()
    try {
      const result = await window.electronAPI.triggerRegionScreenshot()
      if (result.canceled) return
      if (!result.success) {
        showToast("Error", result.error || "Failed to capture selected area", "error")
      }
    } catch (error) {
      console.error("Error taking region screenshot:", error)
      showToast("Error", "Failed to capture selected area", "error")
    }
  }

  const handleSolve = async () => {
    if (screenshotCount === 0) return
    try {
      const result = await window.electronAPI.triggerProcessScreenshots()
      if (!result.success) {
        showToast("Error", result.error || "Failed to process screenshots", "error")
      }
    } catch (error) {
      console.error("Error processing screenshots:", error)
      showToast("Error", "Failed to process screenshots", "error")
    }
  }

  const isComputerUseActive = isComputerTaskActive(computerUseState.status)
  const isAgentActive =
    agentState.status === "planning" ||
    agentState.status === "awaiting_workspace" ||
    agentState.status === "awaiting_approval" ||
    agentState.status === "running"

  const handleGuideCursorToggle = async () => {
    const nextEnabled = !isGuideCursorEnabled
    setIsGuideCursorEnabled(nextEnabled)
    const result = await window.electronAPI.setGuideCursorEnabled({ enabled: nextEnabled })
    if (!result.success) {
      setIsGuideCursorEnabled(!nextEnabled)
      showToast("AI Guide", result.error || "Failed to update guide cursor.", "error")
      return
    }
    setIsGuideCursorEnabled(result.data.enabled)
    showToast(
      "AI Guide",
      result.data.enabled
        ? "Guide cursor is on. Hover text and press Ctrl+Space."
        : "Guide cursor is off.",
      "neutral"
    )
  }

  if (isMinimized) {
    return (
      <div className="w-fit" style={{ animationDelay: "0ms" }}>
        <div
          data-sylica-size-box="true"
          className="sylica-widget-dock cursor-move"
          style={dragRegionStyle}
        >
          <button
            type="button"
            className="sylica-dock-btn"
            onClick={onToggleMinimized}
            aria-label="Expand"
            title="Expand"
            style={noDragStyle}
          >
            <CheatbitMark className="h-6 w-6" rotating />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={isDockOnly ? "w-fit" : "w-full"} style={{ animationDelay: "0ms" }}>
      <div
        data-sylica-size-box="true"
        className={`sylica-widget-dock cursor-move ${isDockOnly ? "w-fit" : "w-full"}`}
        style={{ ...dragRegionStyle, animationDelay: "0ms" }}
      >
        {/* Brand + Actions */}
        <div className="flex items-center gap-0.5 min-w-0 flex-1 overflow-x-auto">
          <button
            type="button"
            className="sylica-dock-btn shrink-0"
            onClick={onToggleMinimized}
            aria-label="Minimize"
            title="Minimize"
            style={{ ...noDragStyle, animationDelay: "30ms" }}
          >
            <CheatbitMark className="h-6 w-6" rotating />
          </button>

          <button
            type="button"
            className="sylica-dock-btn shrink-0"
            onClick={() => void handleRegionScreenshot()}
            aria-label="Select area"
            title={`Select area (${COMMAND_KEY}+Shift+H)`}
            style={{ ...noDragStyle, animationDelay: "60ms" }}
          >
            <Focus className="h-4 w-4" />
          </button>

          {screenshotCount > 0 && (
            <button
              type="button"
              className={`sylica-dock-btn shrink-0 ${credits <= 0 ? "opacity-40" : ""}`}
              onClick={() => {
                onOpenAnalyzeMode()
                void handleSolve()
              }}
              disabled={credits <= 0}
              aria-label="Solve"
              title={`Solve (${COMMAND_KEY}+Enter)`}
              style={{ ...noDragStyle, animationDelay: "120ms" }}
            >
              <Sparkles className="h-4 w-4" />
            </button>
          )}

        </div>

        {/* Active task pills — clickable, each routes to its own surface.
            When multiple are active we compact to icon-only chips so the dock
            doesn't blow out and push the right-side tools off-screen. */}
        {(() => {
          const showVoicePill =
            activeMode === "voice" || activeMode === "live" || isVoiceActive
          const activeCount =
            (isAgentActive ? 1 : 0) +
            (isComputerUseActive ? 1 : 0) +
            (showVoicePill ? 1 : 0)
          const compact = activeCount >= 2
          const pillBase =
            "sylica-active-pill flex shrink-0 items-center justify-center rounded-full border transition focus:outline-none"
          const pillSize = compact
            ? "h-6 w-6 p-0"
            : "gap-1.5 px-2 py-1 text-[9px] font-medium"

          return (
            <div className="flex shrink-0 items-center gap-1">
              {isAgentActive && (
                <button
                  type="button"
                  onClick={onOpenAgentMode}
                  className={`${pillBase} ${pillSize} border-white/10 bg-white/5 text-white/75 hover:bg-white/10 hover:text-white`}
                  aria-label="Open Agent — Working"
                  title="Agent is working — click to open Agent"
                  style={{ ...noDragStyle, animationDelay: "150ms" }}
                >
                  <span className="sylica-working-indicator scale-75" />
                  {!compact && <span>Working</span>}
                </button>
              )}

              {isComputerUseActive && (
                <button
                  type="button"
                  onClick={onOpenAgentMode}
                  className={`${pillBase} ${pillSize} border-white/10 bg-white/5 text-white/75 hover:bg-white/10 hover:text-white`}
                  aria-label="Open Agent — Computer Use"
                  title="Computer Use is running — click to open Agent"
                  style={{ ...noDragStyle, animationDelay: "165ms" }}
                >
                  <span className="sylica-listening-indicator scale-75" />
                  {!compact && <span>Using</span>}
                </button>
              )}

              {showVoicePill && (
                <button
                  type="button"
                  className={`${pillBase} ${pillSize} ${
                    isVoiceActive
                      ? isVoiceSpeaking
                        ? "sylica-voice-state-speaking border-white/25 bg-white/[0.12] text-white"
                        : "border-white/20 bg-white/10 text-white"
                      : "border-white/10 bg-white/5 text-white/70 hover:bg-white/10 hover:text-white"
                  }`}
                  onClick={() => onOpenVoiceMode?.()}
                  aria-label={
                    isVoiceActive
                      ? isVoiceSpeaking
                        ? "Voice is speaking — open Voice"
                        : isVoiceHearing
                          ? "Voice is hearing you — open Voice"
                          : "Voice is live — open Voice"
                      : "Open Voice"
                  }
                  title={
                    isVoiceActive
                      ? isVoiceSpeaking
                        ? "Speaking — click to open Voice"
                        : isVoiceHearing
                          ? "Hearing you — click to open Voice"
                          : "Listening — click to open Voice"
                      : "Open Voice"
                  }
                  style={{ ...noDragStyle, animationDelay: "175ms" }}
                >
                  {isVoiceActive ? (
                    <span
                      className={`sylica-voice-wave scale-75 ${
                        isVoiceSpeaking
                          ? "is-speaking"
                          : isVoiceHearing
                            ? "is-hearing"
                            : ""
                      }`}
                      aria-hidden
                    >
                      <span />
                      <span />
                      <span />
                      <span />
                    </span>
                  ) : (
                    <Mic2 className="h-3 w-3" />
                  )}
                  {!compact && (
                    <span>
                      {isVoiceActive
                        ? isVoiceSpeaking
                          ? "Speaking"
                          : "Listening"
                        : "Voice"}
                    </span>
                  )}
                </button>
              )}
            </div>
          )
        })()}

        {/* Tools */}
        <div className="flex items-center gap-0.5 shrink-0">
          <div className="sylica-dock-divider" style={{ animationDelay: "180ms" }} />

          <div style={{ animationDelay: "210ms" }}>
            <InlineUpdateButton
              state={desktopUpdateState}
              onDownload={onDownloadUpdate}
              onInstall={onInstallUpdate}
            />
          </div>

          <button
            type="button"
            className={`sylica-dock-btn ${isAgentActive || activeMode === "agent" ? "sylica-dock-btn-active" : ""}`}
            onClick={onOpenAgentMode}
            aria-label="Agent"
            title="Agent"
            style={{ ...noDragStyle, animationDelay: "240ms" }}
          >
            <Brain className="h-4 w-4" />
          </button>

          <button
            type="button"
            className={`sylica-dock-btn ${isGuideCursorEnabled ? "sylica-dock-btn-active" : ""}`}
            onClick={() => void handleGuideCursorToggle()}
            aria-label="Guide"
            title="AI Guide"
            style={{ ...noDragStyle, animationDelay: "270ms" }}
          >
            <MousePointer2 className="h-4 w-4" />
          </button>

          <button
            type="button"
            className="sylica-dock-btn"
            onClick={openAccountDashboard}
            aria-label="Dashboard"
            title="Dashboard"
            style={{ ...noDragStyle, animationDelay: "300ms" }}
          >
            <LayoutDashboard className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

export default QueueCommands

