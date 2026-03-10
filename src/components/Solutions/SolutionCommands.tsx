import React, { useEffect } from "react"
import { LayoutDashboard, Power } from "lucide-react"
import type { DesktopUpdateState } from "../../../shared/desktopUpdates"
import { useToast } from "../../contexts/toast"
import { COMMAND_KEY } from "../../utils/platform"
import InlineUpdateButton from "../Updates/InlineUpdateButton"

export interface SolutionCommandsProps {
  onTooltipVisibilityChange: (visible: boolean, height: number) => void
  isProcessing: boolean
  extraScreenshots?: Array<unknown>
  credits: number
  currentLanguage: string
  setLanguage: (language: string) => void
  desktopUpdateState: DesktopUpdateState
  onDownloadUpdate: () => Promise<{ success: true } | { success: false; error: string }>
  onInstallUpdate: () => Promise<{ success: true } | { success: false; error: string }>
}

const SolutionCommands: React.FC<SolutionCommandsProps> = ({
  onTooltipVisibilityChange,
  isProcessing,
  desktopUpdateState,
  onDownloadUpdate,
  onInstallUpdate,
}) => {
  const { showToast } = useToast()

  useEffect(() => {
    onTooltipVisibilityChange(false, 0)
  }, [onTooltipVisibilityChange])

  const openAccountDashboard = () => {
    window.dispatchEvent(new CustomEvent("open-account-dashboard"))
  }

  const handleQuitApp = async () => {
    try {
      const result = await window.electronAPI.quitApp()
      if (!result.success) {
        showToast("Error", result.error || "Failed to quit app", "error")
      }
    } catch (error) {
      console.error("Error quitting app:", error)
      showToast("Error", "Failed to quit app", "error")
    }
  }

  return (
    <div className="pt-2">
      <div className="flex w-fit items-center gap-4 rounded-xl border border-white/10 bg-black/[0.78] px-4 py-2 text-xs text-white/90 backdrop-blur-md">
        <button
          type="button"
          className="flex items-center gap-2 rounded px-2 py-1.5 transition-colors hover:bg-white/10"
          onClick={async () => {
            try {
              const result = await window.electronAPI.toggleMainWindow()
              if (!result.success) {
                showToast("Error", "Failed to toggle window", "error")
              }
            } catch (error) {
              console.error("Error toggling window:", error)
              showToast("Error", "Failed to toggle window", "error")
            }
          }}
        >
          <span className="text-[11px] leading-none">Show/Hide</span>
          <div className="flex gap-1">
            <span className="rounded-md bg-white/10 px-1.5 py-1 text-[11px] leading-none text-white/70">
              {COMMAND_KEY}
            </span>
            <span className="rounded-md bg-white/10 px-1.5 py-1 text-[11px] leading-none text-white/70">
              B
            </span>
          </div>
        </button>

        {!isProcessing && (
          <button
            type="button"
            className="flex items-center gap-2 rounded px-2 py-1.5 transition-colors hover:bg-white/10"
            onClick={async () => {
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
            }}
          >
            <span className="text-[11px] leading-none">New Screenshot</span>
            <div className="flex gap-1">
              <span className="rounded-md bg-white/10 px-1.5 py-1 text-[11px] leading-none text-white/70">
                {COMMAND_KEY}
              </span>
              <span className="rounded-md bg-white/10 px-1.5 py-1 text-[11px] leading-none text-white/70">
                H
              </span>
            </div>
          </button>
        )}

        <button
          type="button"
          className="flex items-center gap-2 rounded px-2 py-1.5 transition-colors hover:bg-white/10"
          onClick={async () => {
            try {
              const result = await window.electronAPI.triggerReset()
              if (!result.success) {
                showToast("Error", "Failed to reset", "error")
              }
            } catch (error) {
              console.error("Error resetting:", error)
              showToast("Error", "Failed to reset", "error")
            }
          }}
        >
          <span className="text-[11px] leading-none">Start Over</span>
          <div className="flex gap-1">
            <span className="rounded-md bg-white/10 px-1.5 py-1 text-[11px] leading-none text-white/70">
              {COMMAND_KEY}
            </span>
            <span className="rounded-md bg-white/10 px-1.5 py-1 text-[11px] leading-none text-white/70">
              R
            </span>
          </div>
        </button>

        <div className="mx-1 h-4 w-px bg-white/20" />

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
        >
          <LayoutDashboard className="h-3.5 w-3.5" />
        </button>

        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-white/75 transition-colors hover:bg-white/10 hover:text-red-200"
          onClick={() => {
            void handleQuitApp()
          }}
          aria-label="Quit"
          title="Quit"
        >
          <Power className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}

export default SolutionCommands
