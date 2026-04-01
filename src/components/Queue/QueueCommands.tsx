import React, { useEffect, useState } from "react"
import {
  Computer,
  Focus,
  LayoutDashboard,
  Radio,
  ScanSearch,
  Smartphone,
} from "lucide-react"
import type { ComputerUseState } from "../../../shared/followUpChat"
import type { DesktopUpdateState } from "../../../shared/desktopUpdates"
import { useToast } from "../../contexts/toast"
import { COMMAND_KEY } from "../../utils/platform"
import { CheatbitMark } from "../Brand/CheatbitMark"
import InlineUpdateButton from "../Updates/InlineUpdateButton"

function isComputerTaskActive(status: ComputerUseState["status"]): boolean {
  return (
    status === "starting" ||
    status === "running" ||
    status === "waiting_for_secret" ||
    status === "stopping"
  )
}

interface QueueCommandsProps {
  activeMode: "analyze" | "chat"
  onModeChange: (mode: "analyze" | "chat") => void
  onTooltipVisibilityChange: (visible: boolean, height: number) => void
  screenshotCount?: number
  credits: number
  desktopUpdateState: DesktopUpdateState
  isMinimized: boolean
  onToggleMinimized: () => void
  modeSwitchLocked?: boolean
  computerUseState: ComputerUseState
  onDownloadUpdate: () => Promise<{ success: true } | { success: false; error: string }>
  onInstallUpdate: () => Promise<{ success: true } | { success: false; error: string }>
  onStartComputerTask: (task: string) => Promise<void> | void
  onStopComputerTask: () => Promise<void> | void
  onResumeComputerTask: () => Promise<void> | void
  isDockOnly?: boolean
}

const QueueCommands: React.FC<QueueCommandsProps> = ({
  activeMode,
  onModeChange,
  onTooltipVisibilityChange,
  screenshotCount = 0,
  credits,
  desktopUpdateState,
  isMinimized,
  onToggleMinimized,
  modeSwitchLocked = false,
  computerUseState,
  onDownloadUpdate,
  onInstallUpdate,
  onStartComputerTask,
  onStopComputerTask,
  onResumeComputerTask,
  isDockOnly = false,
}) => {
  const { showToast } = useToast()
  const dragRegionStyle = { WebkitAppRegion: "drag" as const }
  const noDragStyle = { WebkitAppRegion: "no-drag" as const }
  const [isComputerPromptOpen, setIsComputerPromptOpen] = useState(false)
  const [computerTask, setComputerTask] = useState("")

  useEffect(() => {
    onTooltipVisibilityChange(false, 0)
  }, [isMinimized, onTooltipVisibilityChange])

  useEffect(() => {
    if (computerUseState.status !== "idle") {
      setIsComputerPromptOpen(false)
      setComputerTask("")
    }
  }, [computerUseState.status])

  const openAccountDashboard = () => {
    window.dispatchEvent(new CustomEvent("open-account-dashboard"))
  }

  const openPhoneRelayWindow = () => {
    window.dispatchEvent(new CustomEvent("open-phone-relay"))
  }

  const handleScreenshot = async () => {
    try {
      const result = await window.electronAPI.triggerScreenshot()
      if (!result.success) {
        showToast(
          "Error",
          result.error || "Failed to take screenshot",
          "error"
        )
      }
    } catch (error) {
      console.error("Error taking screenshot:", error)
      showToast("Error", "Failed to take screenshot", "error")
    }
  }

  const handleRegionScreenshot = async () => {
    try {
      const result = await window.electronAPI.triggerRegionScreenshot()
      if (result.canceled) {
        return
      }

      if (!result.success) {
        showToast(
          "Error",
          result.error || "Failed to capture selected area",
          "error"
        )
      }
    } catch (error) {
      console.error("Error taking region screenshot:", error)
      showToast("Error", "Failed to capture selected area", "error")
    }
  }

  const handleSolve = async () => {
    if (screenshotCount === 0) {
      return
    }

    try {
      const result = await window.electronAPI.triggerProcessScreenshots()
      if (!result.success) {
        showToast(
          "Error",
          result.error || "Failed to process screenshots",
          "error"
        )
      }
    } catch (error) {
      console.error("Error processing screenshots:", error)
      showToast("Error", "Failed to process screenshots", "error")
    }
  }

  const isComputerUseActive = isComputerTaskActive(computerUseState.status)
  const isWaitingForSecret =
    computerUseState.status === "waiting_for_secret" ||
    computerUseState.needsSecretInput
  const iconButtonClass =
    "sylica-dock-tab sylica-glass-chip flex h-7 w-7 shrink-0 items-center justify-center rounded-[16px] text-white/76 transition-colors hover:text-white"
  const chipButtonClass =
    "sylica-dock-tab sylica-glass-chip flex items-center gap-1.5 rounded-[16px] px-2 py-1.5 text-[10px] font-medium text-white/88 transition-colors hover:text-white"
  const keyHintClass =
    "rounded-[10px] border border-white/10 bg-white/[0.08] px-1.25 py-[3px] text-[9px] leading-none text-white/54"

  const handleComputerSubmit = async () => {
    const normalizedTask = computerTask.trim()
    if (!normalizedTask) {
      showToast("Computer Use", "Enter a browser task first.", "neutral")
      return
    }

    try {
      await onStartComputerTask(normalizedTask)
      setIsComputerPromptOpen(false)
      setComputerTask("")
    } catch (error) {
      showToast(
        "Computer Use",
        error instanceof Error ? error.message : "Failed to start browser task.",
        "error"
      )
    }
  }

  if (isMinimized) {
    return (
      <div className="w-fit">
        <div
          className="sylica-liquid-dock flex cursor-move items-center rounded-[16px] p-1 text-xs text-white/90"
          style={dragRegionStyle}
        >
          <button
            type="button"
            className="rounded-[14px] transition-transform hover:scale-[1.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
            onClick={onToggleMinimized}
            aria-label="Expand widget"
            title="Expand widget"
            style={noDragStyle}
          >
            <CheatbitMark
              className="h-8 w-8 rounded-[12px] border-white/8 bg-white/[0.02] p-0.5 shadow-none"
              rotating
            />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={isDockOnly ? "w-fit pt-1.5" : "w-full pt-1.5"}>
      <div
        className={`sylica-liquid-dock flex cursor-move items-center justify-between gap-2 rounded-[18px] px-2 py-1.5 text-xs text-white/90 ${
          isDockOnly ? "w-fit" : "w-full min-w-[284px]"
        }`}
        style={dragRegionStyle}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto whitespace-nowrap">
          <button
            type="button"
              className="rounded-[14px] transition-transform hover:scale-[1.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
            onClick={onToggleMinimized}
            aria-label="Minimize widget"
            title="Minimize widget"
            style={noDragStyle}
          >
            <CheatbitMark
                className="h-7 w-7 rounded-[12px] border-white/8 bg-white/[0.03] p-0.5 shadow-none"
                rotating
              />
            </button>

          {activeMode === "analyze" && (
            <>
              <button
                type="button"
                className={iconButtonClass}
                onClick={() => {
                  void handleRegionScreenshot()
                }}
                aria-label="Select area"
                title="Select Area"
                style={noDragStyle}
              >
                <Focus className="h-2.5 w-2.5" />
              </button>

              <button
                type="button"
                className={chipButtonClass}
                onClick={() => {
                  void handleScreenshot()
                }}
                style={noDragStyle}
              >
                <span className="max-w-[6.5rem] truncate text-[10px] leading-none">
                  {screenshotCount === 0
                    ? "Analyze"
                    : screenshotCount === 1
                    ? "Take second screenshot"
                    : screenshotCount === 2
                    ? "Take third screenshot"
                    : screenshotCount === 3
                    ? "Take fourth screenshot"
                    : screenshotCount === 4
                    ? "Take fifth screenshot"
                    : "Next will replace first screenshot"}
                </span>
                <div className="flex gap-1">
                  <span className={keyHintClass}>
                    {COMMAND_KEY}
                  </span>
                  <span className={keyHintClass}>
                    H
                  </span>
                  </div>
                </button>
            </>
          )}

          <div className="sylica-dock-pill flex shrink-0 items-center gap-1 rounded-full p-[3px]">
            <button
              type="button"
              className={`sylica-dock-tab flex min-w-[3.5rem] items-center justify-center gap-1 rounded-full px-2 py-1.5 text-[10px] font-medium transition-colors ${
                activeMode === "analyze"
                  ? "sylica-dock-tab-active"
                  : "text-white/[0.68] hover:text-white"
              } ${modeSwitchLocked ? "cursor-not-allowed opacity-45" : ""}`}
              onClick={() => onModeChange("analyze")}
              disabled={modeSwitchLocked}
              aria-label="Solve mode"
              title="Solve"
              style={noDragStyle}
            >
              <ScanSearch className="h-2.5 w-2.5" />
              <span>Solve</span>
            </button>
            <button
              type="button"
              className={`sylica-dock-tab flex min-w-[3.5rem] items-center justify-center gap-1 rounded-full px-2 py-1.5 text-[10px] font-medium transition-colors ${
                activeMode === "chat"
                  ? "sylica-dock-tab-active"
                  : "text-white/[0.68] hover:text-white"
              }`}
              onClick={() => onModeChange("chat")}
              aria-label="Live mode"
              title="Live"
              style={noDragStyle}
            >
              <Radio className="h-2.5 w-2.5" />
              <span>Live</span>
            </button>
          </div>

          {isComputerPromptOpen ? (
            <div
              className="sylica-dock-pill flex shrink-0 items-center gap-1.5 rounded-full px-1.5 py-1"
              style={noDragStyle}
            >
              <Computer className="h-2.5 w-2.5 text-[#7df9c7]" />
              <input
                type="text"
                value={computerTask}
                onChange={(event) => setComputerTask(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault()
                    void handleComputerSubmit()
                  }
                  if (event.key === "Escape") {
                    setIsComputerPromptOpen(false)
                    setComputerTask("")
                  }
                }}
                placeholder="What should Sylica do?"
                className="w-[9.75rem] bg-transparent text-[10px] leading-none text-white outline-none placeholder:text-white/35"
                autoFocus
              />
              <button
                type="button"
                className="rounded-full bg-[#dffcf1] px-2 py-1 text-[9.5px] font-semibold text-black"
                onClick={() => {
                  void handleComputerSubmit()
                }}
              >
                Run
              </button>
              <button
                type="button"
                className="rounded-full border border-white/10 px-2 py-1 text-[9.5px] text-white/72 hover:text-white"
                onClick={() => {
                  setIsComputerPromptOpen(false)
                  setComputerTask("")
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={`${iconButtonClass} ${
                isComputerUseActive
                  ? "bg-[rgba(159,247,214,0.14)] text-[#baf7df] hover:bg-[rgba(159,247,214,0.18)]"
                  : ""
              }`}
              onClick={() => {
                if (isComputerUseActive) {
                  return
                }
                setIsComputerPromptOpen(true)
              }}
              disabled={isComputerUseActive}
              aria-label="Computer Use"
              title="Computer Use"
              style={noDragStyle}
            >
              <Computer className="h-3 w-3" />
            </button>
          )}

          {activeMode === "analyze" && (
            <>
              {isComputerUseActive && (
                <div
                  className="flex shrink-0 items-center gap-1.5 rounded-full border border-[#7df9c7]/20 bg-[rgba(159,247,214,0.14)] px-2 py-1 text-[9.5px] text-[#e2fff3]"
                  style={noDragStyle}
                >
                  <span className="max-w-[7.5rem] truncate">
                    {isWaitingForSecret
                      ? "Waiting for manual login"
                      : computerUseState.currentAction || "Computer running"}
                  </span>
                  {isWaitingForSecret ? (
                    <button
                      type="button"
                      className="rounded-full bg-white/10 px-2 py-1 text-[9.5px] text-white hover:bg-white/15"
                      onClick={() => {
                        void onResumeComputerTask()
                      }}
                    >
                      Continue
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="rounded-full bg-white/10 px-2 py-1 text-[9.5px] text-white hover:bg-white/15"
                      onClick={() => {
                        void onStopComputerTask()
                      }}
                    >
                      Stop
                    </button>
                  )}
                </div>
              )}
              {screenshotCount > 0 && (
                <button
                  type="button"
                  className={`${chipButtonClass} ${
                    credits <= 0 ? "cursor-not-allowed opacity-50" : ""
                  }`}
                  onClick={() => {
                    void handleSolve()
                  }}
                  style={noDragStyle}
                >
                  <span className="text-[11px] leading-none">Solve</span>
                  <div className="flex gap-1">
                    <span className={keyHintClass}>
                      {COMMAND_KEY}
                    </span>
                    <span className={keyHintClass}>
                      ↵
                    </span>
                  </div>
                </button>
              )}
            </>
          )}

          {activeMode === "chat" && isComputerUseActive && (
            <div
              className="flex shrink-0 items-center gap-2 rounded-full border border-[#7df9c7]/20 bg-[rgba(159,247,214,0.14)] px-2.5 py-1 text-[10px] text-[#e2fff3]"
              style={noDragStyle}
            >
              <span className="max-w-[9rem] truncate">
                {isWaitingForSecret
                  ? "Waiting for manual login"
                  : computerUseState.currentAction || "Computer running"}
              </span>
              {isWaitingForSecret ? (
                <button
                  type="button"
                  className="rounded-full bg-white/10 px-2.5 py-1 text-[10px] text-white hover:bg-white/15"
                  onClick={() => {
                    void onResumeComputerTask()
                  }}
                >
                  Continue
                </button>
              ) : (
                <button
                  type="button"
                  className="rounded-full bg-white/10 px-2.5 py-1 text-[10px] text-white hover:bg-white/15"
                  onClick={() => {
                    void onStopComputerTask()
                  }}
                >
                  Stop
                </button>
              )}
            </div>
          )}
        </div>

        <div className="ml-2 flex shrink-0 items-center gap-2">
          <InlineUpdateButton
            state={desktopUpdateState}
            onDownload={onDownloadUpdate}
            onInstall={onInstallUpdate}
          />

          <button
            type="button"
            className={iconButtonClass}
            onClick={() => {
              openPhoneRelayWindow()
            }}
            data-panel-trigger="phone-relay"
            aria-label="Relay Manager"
            title="Relay Manager"
            style={noDragStyle}
          >
            <Smartphone className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            className={iconButtonClass}
            onClick={openAccountDashboard}
            data-panel-trigger="account-dashboard"
            aria-label="Dashboard"
            title="Dashboard"
            style={noDragStyle}
          >
            <LayoutDashboard className="h-3.5 w-3.5" />
          </button>

        </div>
      </div>
    </div>
  )
}

export default QueueCommands
