import { useEffect, useMemo, useRef, useState } from "react"
import { Button } from "../ui/button"
import { updateWindowToElement } from "../../utils/contentSize"
import type { UserDashboardData } from "../../../shared/backendAuth"
import { useToast } from "../../contexts/toast"
import { CheatbitMark } from "../Brand/CheatbitMark"

interface AccountDashboardDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type BillingLinkKind = "checkout" | "portal"

function billingProviderLabel(provider: UserDashboardData["billing"]["provider"] | undefined): string {
  if (provider === "dodo") {
    return "Dodo Payments"
  }

  if (provider === "stripe") {
    return "Stripe"
  }

  return "Billing"
}

function formatDate(value: string | null): string {
  if (!value) {
    return "Not set"
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return "Unknown"
  }

  return date.toLocaleString()
}

function formatShortDay(value: string): string {
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) {
    return value.slice(5)
  }

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })
}

function labelForAction(action: string): string {
  if (action === "solve") return "Solve"
  if (action === "debug") return "Debug"
  if (action === "screenshot") return "Screenshot"
  if (action === "live_interview") return "Live Interview"
  if (action === "computer_use") return "Computer Use"
  return action
}

function subscriptionStatusClasses(status: string): string {
  if (status === "active") {
    return "border-emerald-300/20 bg-emerald-300/15 text-emerald-100"
  }

  if (status === "trial") {
    return "border-sky-300/20 bg-sky-300/15 text-sky-100"
  }

  if (status === "past_due") {
    return "border-amber-300/20 bg-amber-300/15 text-amber-100"
  }

  return "border-red-300/20 bg-red-300/15 text-red-100"
}

async function copyTextToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }

  const textArea = document.createElement("textarea")
  textArea.value = value
  textArea.setAttribute("readonly", "true")
  textArea.style.position = "fixed"
  textArea.style.opacity = "0"
  document.body.appendChild(textArea)
  textArea.focus()
  textArea.select()

  const copied = document.execCommand("copy")
  document.body.removeChild(textArea)

  if (!copied) {
    throw new Error("Failed to copy the checkout link.")
  }
}

async function openUrlInBrowser(url: string): Promise<void> {
  if (window.electronAPI?.openExternal) {
    const result = await window.electronAPI.openExternal(url)
    if (result && !result.success) {
      throw new Error(result.error || "Failed to open the browser.")
    }
    return
  }

  if (window.electronAPI?.openLink) {
    const result = await window.electronAPI.openLink(url)
    if (result && !result.success) {
      throw new Error(result.error || "Failed to open the browser.")
    }
    return
  }

  const popup = window.open(url, "_blank", "noopener,noreferrer")
  if (!popup) {
    throw new Error("Failed to open the browser for checkout.")
  }
}

export function AccountDashboardDialog({
  open,
  onOpenChange,
}: AccountDashboardDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [dashboard, setDashboard] = useState<UserDashboardData | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [billingAction, setBillingAction] = useState<"checkout" | "portal" | null>(null)
  const [generatedBillingLink, setGeneratedBillingLink] = useState<{
    kind: BillingLinkKind
    url: string
  } | null>(null)
  const [billingLinkCopied, setBillingLinkCopied] = useState(false)
  const [error, setError] = useState("")
  const { showToast } = useToast()

  const highestDayTotal = useMemo(() => {
    if (!dashboard?.dailyActivity.length) return 1

    return (
      Math.max(
        ...dashboard.dailyActivity.map(
          (point) =>
            point.solves + point.debug + point.screenshots + point.blocked
        )
      ) || 1
    )
  }, [dashboard])

  const refreshDashboard = async () => {
    setError("")
    setIsLoading(true)

    try {
      setDashboard(await window.electronAPI.getAccountDashboard())
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "Failed to refresh dashboard."
      )
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return

    let isCancelled = false

    const loadDashboard = async () => {
      setIsLoading(true)
      setError("")

      try {
        const nextDashboard = await window.electronAPI.getAccountDashboard()
        if (!isCancelled) {
          setDashboard(nextDashboard)
        }
      } catch (loadError) {
        if (!isCancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Failed to load account dashboard."
          )
        }
      } finally {
        if (!isCancelled) {
          setIsLoading(false)
        }
      }
    }

    void loadDashboard()

    return () => {
      isCancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open) return

    const unsubscribe = window.electronAPI.onSubscriptionUpdated(() => {
      void refreshDashboard()
    })

    return () => {
      unsubscribe()
    }
  }, [open])

  useEffect(() => {
    if (!open || !panelRef.current) return

    const resize = () => {
      if (!panelRef.current) return
      updateWindowToElement(panelRef.current)
    }

    resize()

    const observer = new ResizeObserver(resize)
    observer.observe(panelRef.current)
    const timer = window.setTimeout(resize, 80)

    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
    }
  }, [open, dashboard, isLoading, error])

  useEffect(() => {
    if (open) return

    setGeneratedBillingLink(null)
    setBillingLinkCopied(false)
  }, [open])

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) {
        return
      }

      if (panelRef.current?.contains(target)) {
        return
      }

      onOpenChange(false)
    }

    document.addEventListener("pointerdown", handlePointerDown)
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown)
    }
  }, [open, onOpenChange])

  const handleCopyBillingLink = async () => {
    if (!generatedBillingLink) return

    try {
      await copyTextToClipboard(generatedBillingLink.url)
      setBillingLinkCopied(true)
      showToast(
        "Link Copied",
        generatedBillingLink.kind === "checkout"
          ? "Subscription link copied to the clipboard."
          : "Billing link copied to the clipboard.",
        "success"
      )
      window.setTimeout(() => {
        setBillingLinkCopied(false)
      }, 2000)
    } catch (copyError) {
      setError(
        copyError instanceof Error
          ? copyError.message
          : "Failed to copy the billing link."
      )
    }
  }

  const handleStartCheckout = async () => {
    setBillingAction("checkout")
    setError("")

    try {
      const session = await window.electronAPI.createCheckoutSession()
      setGeneratedBillingLink({ kind: "checkout", url: session.url })
      setBillingLinkCopied(false)
      await openUrlInBrowser(session.url)
      const providerLabel = billingProviderLabel(dashboard?.billing.provider)
      showToast(
        `${providerLabel} Checkout`,
        `Finish the $20/month subscription in your browser. If it does not open, copy the link below.`,
        "success"
      )
    } catch (checkoutError) {
      setError(
        checkoutError instanceof Error
          ? checkoutError.message
          : "Failed to open checkout."
      )
    } finally {
      setBillingAction(null)
    }
  }

  const handleOpenBillingPortal = async () => {
    setBillingAction("portal")
    setError("")

    try {
      const session = await window.electronAPI.createBillingPortalSession()
      setGeneratedBillingLink({ kind: "portal", url: session.url })
      setBillingLinkCopied(false)
      await openUrlInBrowser(session.url)
      const providerLabel = billingProviderLabel(dashboard?.billing.provider)
      showToast(
        "Billing Portal",
        `${providerLabel} billing management opened in your browser. If it does not open, copy the link below.`,
        "success"
      )
    } catch (portalError) {
      setError(
        portalError instanceof Error
          ? portalError.message
          : "Failed to open billing."
      )
    } finally {
      setBillingAction(null)
    }
  }

  const handleOpenSettings = () => {
    onOpenChange(false)
    window.setTimeout(() => {
      void window.electronAPI.openSettingsPortal()
    }, 0)
  }

  if (!open) {
    return null
  }

  return (
    <div
      ref={panelRef}
      className="sylica-sheet-enter mt-3 flex-none overflow-hidden rounded-[28px] border border-white/10 bg-[#050505] text-white shadow-[0_30px_100px_rgba(0,0,0,0.56)] min-w-[56rem] max-w-[56rem]"
    >
      <div className="max-h-[38rem] space-y-4 overflow-y-auto bg-[radial-gradient(circle_at_top_left,_rgba(125,249,199,0.16),_transparent_28%),radial-gradient(circle_at_top_right,_rgba(158,224,255,0.11),_transparent_22%),linear-gradient(180deg,_rgba(255,255,255,0.04),_rgba(255,255,255,0.01))] p-4 sm:p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <CheatbitMark className="h-11 w-11 rounded-[18px]" />
            <div className="space-y-1">
              <h2 className="text-[22px] font-semibold tracking-[-0.04em] text-white">
                Account Dashboard
              </h2>
              <p className="text-[13px] leading-5 text-white/62">
                Subscription, usage, and activity from the backend.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => {
                void refreshDashboard()
              }}
              className="border-white/10 bg-white/5 text-white hover:bg-white/10"
            >
              Refresh
            </Button>
            <Button
              variant="outline"
              onClick={handleOpenSettings}
              className="border-white/10 text-white hover:bg-white/5"
            >
              Settings
            </Button>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="border-white/10 text-white hover:bg-white/5"
            >
              Close
            </Button>
          </div>
        </div>

        {error ? (
          <div className="rounded-2xl border border-red-500/25 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-200">
            {error}
          </div>
        ) : null}

        {isLoading && !dashboard ? (
          <div className="rounded-[22px] border border-white/10 bg-white/5 px-4 py-8 text-center text-sm text-white/60">
            Loading account activity...
          </div>
        ) : null}

        {dashboard ? (
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-[minmax(0,1.1fr)_minmax(290px,0.9fr)]">
              <div className="rounded-[24px] border border-white/10 bg-[radial-gradient(circle_at_top_left,_rgba(125,249,199,0.14),_transparent_40%),rgba(255,255,255,0.03)] p-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-[0.22em] text-[#7df9c7]">
                      Account
                    </div>
                    <div className="mt-2 text-[28px] font-semibold tracking-[-0.05em] text-white">
                      {dashboard.user.name}
                    </div>
                    <div className="mt-1 break-all text-[13px] text-white/60">
                      {dashboard.user.email}
                    </div>
                    <div className="mt-3 text-[13px] leading-5 text-white/66">
                      Backend-tracked usage, subscription state, and request
                      history.
                    </div>
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <Button
                        onClick={() => {
                          void handleStartCheckout()
                        }}
                        disabled={
                          !dashboard.billing.checkoutEnabled ||
                          billingAction !== null ||
                          dashboard.billing.unlimited
                        }
                        className="rounded-xl bg-white px-4 py-2 text-[12px] text-black hover:bg-white/90 disabled:bg-white/20 disabled:text-white/45"
                      >
                        {dashboard.billing.unlimited
                          ? "Unlimited Active"
                          : billingAction === "checkout"
                          ? "Opening Checkout..."
                          : `Subscribe $${dashboard.billing.pricePerMonthUsd}/month`}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => {
                          void handleOpenBillingPortal()
                        }}
                        disabled={
                          !dashboard.billing.canManageBilling ||
                          billingAction !== null
                        }
                        className="border-white/10 text-white hover:bg-white/5 disabled:border-white/10 disabled:text-white/35"
                      >
                        {billingAction === "portal"
                          ? "Opening Billing..."
                          : "Manage Billing"}
                      </Button>
                    </div>
                    <div className="mt-2 text-[12px] text-white/52">
                      {dashboard.billing.statusMessage}
                    </div>
                    {generatedBillingLink ? (
                      <div className="mt-4 rounded-[20px] border border-white/10 bg-black/25 p-3">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                          <div className="min-w-0">
                            <div className="text-[10px] uppercase tracking-[0.18em] text-white/40">
                              {generatedBillingLink.kind === "checkout"
                                ? "Subscribe Link"
                                : "Billing Link"}
                            </div>
                            <div className="mt-2 break-all rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[12px] leading-5 text-white/72">
                              {generatedBillingLink.url}
                            </div>
                            <div className="mt-2 text-[12px] text-white/52">
                              Copy and paste this into any browser if automatic opening does not work.
                            </div>
                          </div>
                          <Button
                            variant="outline"
                            onClick={() => {
                              void handleCopyBillingLink()
                            }}
                            className="shrink-0 border-white/10 text-white hover:bg-white/5"
                          >
                            {billingLinkCopied
                              ? "Copied"
                              : generatedBillingLink.kind === "checkout"
                              ? "Copy Subscribe Link"
                              : "Copy Billing Link"}
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-white px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-black">
                      {dashboard.user.subscriptionPlan}
                    </span>
                    <span
                      className={`rounded-full border px-3 py-1 text-[10px] font-medium uppercase tracking-[0.18em] ${subscriptionStatusClasses(
                        dashboard.user.subscriptionStatus
                      )}`}
                    >
                      {dashboard.user.subscriptionStatus}
                    </span>
                    {dashboard.billing.cancelAtPeriodEnd ? (
                      <span className="rounded-full border border-amber-300/20 bg-amber-300/15 px-3 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-amber-100">
                        Ends at period end
                      </span>
                    ) : null}
                  </div>
                </div>

                <div className="mt-4 grid gap-2.5 sm:grid-cols-3">
                  <div className="rounded-2xl border border-white/10 bg-black/25 p-3">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-white/38">
                      Started
                    </div>
                    <div className="mt-1.5 text-[13px] text-white/82">
                      {formatDate(dashboard.user.subscriptionStartedAt)}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-black/25 p-3">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-white/38">
                      Renews
                    </div>
                    <div className="mt-1.5 text-[13px] text-white/82">
                      {formatDate(dashboard.user.subscriptionRenewsAt)}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-black/25 p-3">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-white/38">
                      Last Login
                    </div>
                    <div className="mt-1.5 text-[13px] text-white/82">
                      {formatDate(dashboard.user.lastLoginAt)}
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-[24px] border border-white/10 bg-white/[0.035] p-4">
                <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">
                  Lifetime Usage
                </div>
                <div className="mt-1.5 text-[13px] leading-5 text-white/60">
                  Totals recorded by the backend.
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2.5">
                  <div className="rounded-2xl border border-white/10 bg-black/25 p-3">
                    <div className="text-[10px] uppercase tracking-[0.16em] text-white/45">
                      Solves
                    </div>
                    <div className="mt-1.5 text-[24px] font-semibold text-white">
                      {dashboard.usage.totalSolveCount}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-black/25 p-3">
                    <div className="text-[10px] uppercase tracking-[0.16em] text-white/45">
                      Debug
                    </div>
                    <div className="mt-1.5 text-[24px] font-semibold text-white">
                      {dashboard.usage.totalDebugCount}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-black/25 p-3">
                    <div className="text-[10px] uppercase tracking-[0.16em] text-white/45">
                      Shots
                    </div>
                    <div className="mt-1.5 text-[24px] font-semibold text-white">
                      {dashboard.usage.totalScreenshotCount}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-[minmax(0,1.12fr)_minmax(300px,0.88fr)]">
              <div className="space-y-4">
                <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-[22px] border border-white/10 bg-white/[0.035] p-3.5">
                    <div className="text-[10px] uppercase tracking-[0.2em] text-white/40">
                      Requests Today
                    </div>
                    <div className="mt-2 text-[26px] font-semibold tracking-[-0.04em] text-white">
                      {dashboard.usage.requestsToday}
                    </div>
                    <div className="mt-1.5 text-[12px] text-white/58">
                      {dashboard.billing.unlimited
                        ? "Unlimited"
                        : `${dashboard.usage.remainingRequestsToday} remaining`}
                    </div>
                  </div>
                  <div className="rounded-[22px] border border-white/10 bg-white/[0.035] p-3.5">
                    <div className="text-[10px] uppercase tracking-[0.2em] text-white/40">
                      Screenshots Today
                    </div>
                    <div className="mt-2 text-[26px] font-semibold tracking-[-0.04em] text-white">
                      {dashboard.usage.screenshotsToday}
                    </div>
                    <div className="mt-1.5 text-[12px] text-white/58">
                      Captures do not count against the request cap.
                    </div>
                  </div>
                  <div className="rounded-[22px] border border-white/10 bg-white/[0.035] p-3.5">
                    <div className="text-[10px] uppercase tracking-[0.2em] text-white/40">
                      Requests / Hour
                    </div>
                    <div className="mt-2 text-[26px] font-semibold tracking-[-0.04em] text-white">
                      {dashboard.usage.requestsThisHour}
                    </div>
                    <div className="mt-1.5 text-[12px] text-white/58">
                      {dashboard.billing.unlimited
                        ? "Unlimited"
                        : `${dashboard.usage.remainingRequestsThisHour} remaining`}
                    </div>
                  </div>
                  <div className="rounded-[22px] border border-white/10 bg-white/[0.035] p-3.5">
                    <div className="text-[10px] uppercase tracking-[0.2em] text-white/40">
                      Blocked Today
                    </div>
                    <div className="mt-2 text-[26px] font-semibold tracking-[-0.04em] text-white">
                      {dashboard.usage.blockedAttemptsToday}
                    </div>
                    <div className="mt-1.5 text-[12px] text-white/58">
                      Last {formatDate(dashboard.usage.lastUsageAt)}
                    </div>
                  </div>
                </div>

                <div className="rounded-[24px] border border-white/10 bg-white/[0.035] p-4">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">
                        Activity
                      </div>
                      <div className="mt-1.5 text-[13px] leading-5 text-white/62">
                        Last 7 days of account activity.
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 text-[10px] uppercase tracking-[0.14em] text-white/50">
                      <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
                        7 day trend
                      </span>
                      <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
                        backend synced
                      </span>
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-7 gap-2.5">
                    {dashboard.dailyActivity.map((point) => {
                      const total =
                        point.solves +
                        point.debug +
                        point.screenshots +
                        point.blocked
                      const columnHeight = Math.max(
                        14,
                        Math.round((total / highestDayTotal) * 96)
                      )

                      return (
                        <div key={point.day} className="space-y-2 text-center">
                          <div className="flex h-32 items-end justify-center rounded-[18px] border border-white/10 bg-black/25 px-2 pb-2">
                            <div
                              className="w-full rounded-[14px] bg-gradient-to-t from-[#7df9c7] via-[#9ee0ff] to-white/90 shadow-[0_8px_24px_rgba(157,224,255,0.16)]"
                              style={{ height: `${columnHeight}px` }}
                            />
                          </div>
                          <div className="text-[10px] text-white/48">
                            {formatShortDay(point.day)}
                          </div>
                          <div className="text-[10px] text-white/70">
                            {total}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <div className="rounded-[24px] border border-white/10 bg-white/[0.035] p-4">
                  <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">
                    Rate Limits
                  </div>
                    <div className="mt-1.5 text-[13px] leading-5 text-white/60">
                      {dashboard.billing.unlimited
                      ? `Unlimited ${billingProviderLabel(
                          dashboard.billing.provider
                        )} access is active for this account.`
                      : "Free plan includes 20 daily requests with chat and screen tools included."}
                    </div>

                  <div className="mt-4 grid grid-cols-3 gap-2.5">
                    <div className="rounded-2xl border border-white/10 bg-black/25 p-3">
                      <div className="text-[11px] text-white/45">
                        Requests / day
                      </div>
                      <div className="mt-1.5 text-[24px] font-semibold text-white">
                        {dashboard.billing.unlimited
                          ? "Unlimited"
                          : dashboard.usage.remainingRequestsToday +
                            dashboard.usage.requestsToday}
                      </div>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-black/25 p-3">
                      <div className="text-[11px] text-white/45">
                        Req / hour
                      </div>
                      <div className="mt-1.5 text-[24px] font-semibold text-white">
                        {dashboard.billing.unlimited
                          ? "Unlimited"
                          : dashboard.user.subscriptionPlan === "free"
                          ? 20
                          : dashboard.user.rateLimits.requestsPerHour}
                      </div>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-black/25 p-3">
                      <div className="text-[11px] text-white/45">
                        Plan
                      </div>
                      <div className="mt-1.5 text-[24px] font-semibold text-white">
                        {dashboard.billing.unlimited ? "Pro" : "Free"}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="rounded-[24px] border border-white/10 bg-white/[0.035] p-4">
                  <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">
                    Recent Activity
                  </div>
                  <div className="mt-1.5 text-[13px] leading-5 text-white/60">
                    Latest recorded actions for this account.
                  </div>

                  <div className="mt-4 max-h-80 space-y-2 overflow-y-auto pr-1">
                    {dashboard.recentEvents.length === 0 ? (
                      <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-7 text-sm text-white/55">
                        No activity recorded yet.
                      </div>
                    ) : (
                      dashboard.recentEvents.map((event) => (
                        <div
                          key={event.id}
                          className="flex items-start justify-between gap-3 rounded-2xl border border-white/10 bg-black/20 px-3.5 py-3"
                        >
                          <div className="min-w-0">
                            <div className="text-[13px] font-medium text-white">
                              {labelForAction(event.action)}
                            </div>
                            <div className="mt-1 text-[11px] text-white/52">
                              {formatDate(event.createdAt)}
                            </div>
                            <div className="mt-1.5 text-[12px] leading-5 text-white/68">
                              {event.reason ||
                                "Request counted successfully."}
                            </div>
                          </div>
                          <span
                            className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] ${
                              event.allowed
                                ? "bg-[#7df9c7] text-black"
                                : "bg-red-500/20 text-red-200"
                            }`}
                          >
                            {event.allowed ? "Allowed" : "Blocked"}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
