import React, { useEffect, useState } from "react"
import {
  Computer,
  Focus,
  LayoutDashboard,
  Radio,
  ScanSearch,
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
          className="flex cursor-move items-center rounded-2xl border border-white/10 bg-black/[0.92] p-1.5 text-xs text-white/90 backdrop-blur-md"
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
              className="h-9 w-9 rounded-[14px] border-white/8 bg-white/[0.02] p-0.5 shadow-none"
              rotating
            />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full pt-2">
      <div
        className="flex w-full min-w-[320px] cursor-move items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/[0.92] px-3 py-2 text-xs text-white/90 backdrop-blur-md"
        style={dragRegionStyle}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto whitespace-nowrap">
          <button
            type="button"
            className="rounded-[12px] transition-transform hover:scale-[1.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
            onClick={onToggleMinimized}
            aria-label="Minimize widget"
            title="Minimize widget"
            style={noDragStyle}
          >
            <CheatbitMark
              className="h-7 w-7 rounded-[10px] border-white/8 bg-white/[0.02] p-0.5 shadow-none"
              rotating
            />
          </button>

          {activeMode === "analyze" && (
            <>
              <button
                type="button"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white/80 transition-colors hover:bg-white/10 hover:text-white"
                onClick={() => {
                  void handleRegionScreenshot()
                }}
                aria-label="Select area"
                title="Select Area"
                style={noDragStyle}
              >
                <Focus className="h-3.5 w-3.5" />
              </button>

              <button
                type="button"
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/10"
                onClick={() => {
                  void handleScreenshot()
                }}
                style={noDragStyle}
              >
                <span className="max-w-[8rem] truncate text-[11px] leading-none">
                  {screenshotCount === 0
                    ? "Analyze Screen"
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
                  <span className="rounded-md bg-white/10 px-1.5 py-1 text-[11px] leading-none text-white/70">
                    {COMMAND_KEY}
                  </span>
                  <span className="rounded-md bg-white/10 px-1.5 py-1 text-[11px] leading-none text-white/70">
                    H
                  </span>
                  </div>
                </button>
            </>
          )}

          <div className="flex shrink-0 items-center gap-1 rounded-full border border-white/10 bg-black/[0.6] p-0.5">
            <button
              type="button"
              className={`flex h-7 w-7 items-center justify-center rounded-full transition-colors ${
                activeMode === "analyze"
                  ? "bg-white text-black"
                  : "text-white/[0.68] hover:text-white"
              } ${modeSwitchLocked ? "cursor-not-allowed opacity-45" : ""}`}
              onClick={() => onModeChange("analyze")}
              disabled={modeSwitchLocked}
              aria-label="Solve mode"
              title="Solve"
              style={noDragStyle}
            >
              <ScanSearch className="h-3 w-3" />
            </button>
            <button
              type="button"
              className={`flex h-7 w-7 items-center justify-center rounded-full transition-colors ${
                activeMode === "chat"
                  ? "bg-white text-black"
                  : "text-white/[0.68] hover:text-white"
              }`}
              onClick={() => onModeChange("chat")}
              aria-label="Chat mode"
              title="Chat"
              style={noDragStyle}
            >
              <Radio className="h-3 w-3" />
            </button>
          </div>

          {isComputerPromptOpen ? (
            <div
              className="flex shrink-0 items-center gap-1 rounded-full border border-white/10 bg-black/55 px-2 py-1"
              style={noDragStyle}
            >
              <Computer className="h-3 w-3 text-[#7df9c7]" />
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
                className="w-[12rem] bg-transparent text-[11px] leading-none text-white outline-none placeholder:text-white/35"
                autoFocus
              />
              <button
                type="button"
                className="rounded-full bg-[#7df9c7] px-2 py-1 text-[10px] font-medium text-black"
                onClick={() => {
                  void handleComputerSubmit()
                }}
              >
                Run
              </button>
              <button
                type="button"
                className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-white/72 hover:text-white"
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
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors ${
                isComputerUseActive
                  ? "bg-[#17362d] text-[#baf7df] hover:bg-[#1d4338]"
                  : "text-white/80 hover:bg-white/10 hover:text-white"
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
              <Computer className="h-3.5 w-3.5" />
            </button>
          )}

          {activeMode === "analyze" && (
            <>
              {isComputerUseActive && (
                <div
                  className="flex shrink-0 items-center gap-2 rounded-full border border-[#7df9c7]/20 bg-[#17362d] px-2.5 py-1 text-[10px] text-[#d8ffef]"
                  style={noDragStyle}
                >
                  <span className="max-w-[8.5rem] truncate">
                    {isWaitingForSecret
                      ? "Waiting for manual login"
                      : computerUseState.currentAction || "Computer running"}
                  </span>
                  {isWaitingForSecret ? (
                    <button
                      type="button"
                      className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-white hover:bg-white/15"
                      onClick={() => {
                        void onResumeComputerTask()
                      }}
                    >
                      Continue
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-white hover:bg-white/15"
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
                  className={`flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/10 ${
                    credits <= 0 ? "cursor-not-allowed opacity-50" : ""
                  }`}
                  onClick={() => {
                    void handleSolve()
                  }}
                  style={noDragStyle}
                >
                  <span className="text-[11px] leading-none">Solve</span>
                  <div className="flex gap-1">
                    <span className="rounded-md bg-white/10 px-1.5 py-1 text-[11px] leading-none text-white/70">
                      {COMMAND_KEY}
                    </span>
                    <span className="rounded-md bg-white/10 px-1.5 py-1 text-[11px] leading-none text-white/70">
                      ↵
                    </span>
                  </div>
                </button>
              )}
            </>
          )}

          {activeMode === "chat" && isComputerUseActive && (
            <div
              className="flex shrink-0 items-center gap-2 rounded-full border border-[#7df9c7]/20 bg-[#17362d] px-2.5 py-1 text-[10px] text-[#d8ffef]"
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
                  className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-white hover:bg-white/15"
                  onClick={() => {
                    void onResumeComputerTask()
                  }}
                >
                  Continue
                </button>
              ) : (
                <button
                  type="button"
                  className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-white hover:bg-white/15"
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
            className="flex h-8 w-8 items-center justify-center rounded-lg text-white/80 transition-colors hover:bg-white/10 hover:text-white"
            onClick={openAccountDashboard}
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
