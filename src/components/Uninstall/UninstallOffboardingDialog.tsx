import React, { useEffect, useRef, useState } from "react"
import { Dialog, DialogContent } from "../ui/dialog"
import { useToast } from "../../contexts/toast"
import type { AuthState } from "../../../shared/backendAuth"
import { updateWindowToElement } from "../../utils/contentSize"

interface UninstallOffboardingDialogProps {
  open: boolean
  authState: AuthState
  onOpenChange: (open: boolean) => void
}

const UninstallOffboardingDialog: React.FC<UninstallOffboardingDialogProps> = ({
  open,
  authState,
  onOpenChange,
}) => {
  const { showToast } = useToast()
  const [isLaunchingUninstall, setIsLaunchingUninstall] = useState(false)
  const [isOpeningBilling, setIsOpeningBilling] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      const timer = window.setTimeout(() => {
        const restoreTarget = document.querySelector(
          "[data-app-shell='true'], [data-size-root='true']"
        ) as HTMLElement | null

        if (restoreTarget) {
          updateWindowToElement(restoreTarget)
        }
      }, 20)

      return () => {
        window.clearTimeout(timer)
      }
    }

    void window.electronAPI.updateContentDimensions({
      width: 620,
      height: 380,
    })

    const resize = () => {
      if (!panelRef.current) return
      updateWindowToElement(panelRef.current, { width: 48, height: 48 })
    }

    const timer = window.setTimeout(resize, 80)
    const observer = new ResizeObserver(resize)

    if (panelRef.current) {
      observer.observe(panelRef.current)
    }

    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
    }
  }, [open])

  const handleContinueUninstall = async () => {
    setIsLaunchingUninstall(true)
    const result = await window.electronAPI.beginUninstall()
    if (!result.success) {
      setIsLaunchingUninstall(false)
      showToast("Uninstall", result.error, "error")
    }
  }

  const handleOpenBilling = async () => {
    setIsOpeningBilling(true)
    try {
      const session = await window.electronAPI.createBillingPortalSession()
      if (!session.success || !session.url) {
        showToast(
          "Billing",
          session.error || "Could not open the billing portal.",
          "error"
        )
        return
      }

      const result = await window.electronAPI.openExternal(session.url)
      if (!result.success) {
        showToast("Billing", result.error || "Could not open the billing portal.", "error")
      }
    } finally {
      setIsOpeningBilling(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={panelRef}
        className="w-[min(92vw,38rem)] max-w-[38rem] border-white/15 bg-black/95 text-white"
        style={{ maxHeight: "calc(100vh - 32px)", overflowY: "auto" }}
      >
        <div className="space-y-4 p-1">
          <div className="space-y-2">
            <p className="text-[11px] uppercase tracking-[0.24em] text-white/45">
              Leaving Sylica AI
            </p>
            <h2 className="text-lg font-semibold">Before you uninstall</h2>
            <p className="text-sm leading-6 text-white/70">
              You can keep Sylica AI and return anytime, or continue with uninstall now.
            </p>
          </div>

          <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-sm text-white/75">
            Uninstalling will remove the desktop app. Your subscription and backend account are not deleted automatically.
          </div>

          <div className="flex flex-wrap justify-end gap-2">
            {authState.authenticated && (
              <button
                type="button"
                className="rounded-lg border border-white/10 px-3 py-2 text-sm text-white/80 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-60"
                onClick={() => {
                  void handleOpenBilling()
                }}
                disabled={isOpeningBilling || isLaunchingUninstall}
              >
                {isOpeningBilling ? "Opening Billing..." : "Manage Plan"}
              </button>
            )}

            <button
              type="button"
              className="rounded-lg border border-white/10 px-3 py-2 text-sm text-white/80 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-60"
              onClick={() => onOpenChange(false)}
              disabled={isLaunchingUninstall}
            >
              Keep Sylica AI
            </button>

            <button
              type="button"
              className="rounded-lg bg-white px-3 py-2 text-sm font-medium text-black transition-colors hover:bg-white/90 disabled:opacity-60"
              onClick={() => {
                void handleContinueUninstall()
              }}
              disabled={isLaunchingUninstall || isOpeningBilling}
            >
              {isLaunchingUninstall ? "Starting Uninstall..." : "Continue Uninstall"}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default UninstallOffboardingDialog
