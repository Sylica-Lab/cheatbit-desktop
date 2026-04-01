import React from "react"
import { Download, RefreshCw, RotateCw } from "lucide-react"
import type { DesktopUpdateState } from "../../../shared/desktopUpdates"
import { useToast } from "../../contexts/toast"

interface InlineUpdateButtonProps {
  state: DesktopUpdateState
  onDownload: () => Promise<{ success: true } | { success: false; error: string }>
  onInstall: () => Promise<{ success: true } | { success: false; error: string }>
}

export function shouldRenderInlineUpdateButton(
  state: DesktopUpdateState
): boolean {
  return (
    state.status === "available" ||
    state.status === "downloading" ||
    state.status === "downloaded"
  )
}

const InlineUpdateButton: React.FC<InlineUpdateButtonProps> = ({
  state,
  onDownload,
  onInstall,
}) => {
  const { showToast } = useToast()

  if (!shouldRenderInlineUpdateButton(state)) {
    return null
  }

  const isDownloading = state.status === "downloading"
  const isDownloaded = state.status === "downloaded"
  const buttonLabel = isDownloading
    ? `Downloading${typeof state.downloadPercent === "number" ? ` ${Math.round(state.downloadPercent)}%` : "..."}`
    : isDownloaded
      ? "Restart"
      : "Update"

  const handleClick = async () => {
    const result = isDownloaded ? await onInstall() : await onDownload()
    if (!result.success) {
      showToast("Update", result.error, "error")
    }
  }

  const Icon = isDownloaded ? RotateCw : isDownloading ? RefreshCw : Download

  return (
    <button
      type="button"
      className="sylica-dock-tab sylica-glass-chip flex h-9 items-center gap-1.5 rounded-2xl px-3 text-[11px] font-medium leading-none text-white disabled:cursor-not-allowed disabled:opacity-70"
      onClick={() => {
        void handleClick()
      }}
      disabled={isDownloading}
      aria-label={buttonLabel}
      title={state.version ? `${buttonLabel} ${state.version}` : buttonLabel}
      style={{ WebkitAppRegion: "no-drag" as const }}
    >
      <Icon className={`h-3.5 w-3.5 ${isDownloading ? "animate-spin" : ""}`} />
      <span>{buttonLabel}</span>
    </button>
  )
}

export default InlineUpdateButton
