import { useEffect, useMemo, useRef, useState } from "react"
import { Button } from "../ui/button"
import { updateWindowToElement } from "../../utils/contentSize"
import type { UserDashboardData } from "../../../shared/backendAuth"
import type {
  LocalPhoneRelayEventSummary,
  LocalPhoneRelayState,
} from "../../../shared/localPhoneRelay"
import { DEFAULT_WIDGET_SCALE } from "../../../shared/aiConfig"
import { useToast } from "../../contexts/toast"

interface AccountDashboardDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  widgetScale: number
  onWidgetScaleChange: (scale: number) => void
}

type BillingLinkKind = "checkout" | "portal"

function billingProviderLabel(provider: UserDashboardData["billing"]["provider"] | undefined): string {
  if (provider === "dodo") return "Dodo Payments"
  if (provider === "stripe") return "Stripe"
  return "Billing"
}

function getInitials(name: string): string {
  if (!name) return "U"
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "U"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

type DashboardTab = "overview" | "activity" | "apps" | "relay" | "billing"

const TABS: { id: DashboardTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "activity", label: "Activity" },
  { id: "apps", label: "Apps" },
  { id: "relay", label: "Relay" },
  { id: "billing", label: "Billing" },
]

function formatDate(value: string | null): string {
  if (!value) return "Not set"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Unknown"
  return date.toLocaleString()
}

function formatShortDay(value: string): string {
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value.slice(5)
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function labelForAction(action: string): string {
  const map: Record<string, string> = {
    solve: "Solve",
    debug: "Debug",
    screenshot: "Screenshot",
    live_interview: "Live Interview",
    computer_use: "Computer Use",
    agent: "Agent Mode",
  }
  return map[action] || action
}

function relayServerStatusLabel(status: LocalPhoneRelayState["serverStatus"]): string {
  if (status === "ready") return "Ready"
  if (status === "starting") return "Starting"
  if (status === "offline") return "Offline"
  if (status === "error") return "Error"
  return status
}

function relayServerStatusClasses(status: LocalPhoneRelayState["serverStatus"]): string {
  if (status === "ready") return "text-emerald-400"
  if (status === "starting") return "text-sky-400"
  if (status === "error") return "text-red-400"
  return "text-white/50"
}

function shortRelayPreview(event: LocalPhoneRelayEventSummary): string {
  const p = event.payload
  switch (event.eventType) {
    case "clipboard":
      return String(p.text || "").trim().slice(0, 120) || "Clipboard"
    case "otp": {
      const code = String(p.code || "").trim()
      const label = String(p.label || "").trim()
      return label ? `${label}: ${code}` : code || "OTP"
    }
    case "link":
      return String(p.title || "").trim() || String(p.url || "").trim() || "Shared link"
    case "notification": {
      const parts = [p.appName, p.title, p.text].map((x) => String(x || "").trim()).filter(Boolean)
      return parts.join(" · ").slice(0, 120) || "Notification"
    }
    case "file": {
      const name = String(p.savedFileName || p.originalFileName || "").trim() || "Phone file"
      return name
    }
    case "screen_result":
      return String(p.answer || "").trim().slice(0, 120) || String(p.code || "").trim().slice(0, 120) || "Screen result"
    default:
      return String(event.eventType).replace(/_/g, " ")
  }
}

export function AccountDashboardDialog({
  open,
  onOpenChange,
  widgetScale,
  onWidgetScaleChange,
}: AccountDashboardDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [dashboard, setDashboard] = useState<UserDashboardData | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [billingAction, setBillingAction] = useState<"checkout" | "portal" | null>(null)
  const [integrationAction, setIntegrationAction] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<DashboardTab>("overview")
  const [generatedBillingLink, setGeneratedBillingLink] = useState<{ kind: BillingLinkKind; url: string } | null>(null)
  const [billingLinkCopied, setBillingLinkCopied] = useState(false)
  const [relayState, setRelayState] = useState<LocalPhoneRelayState | null>(null)
  const [relayUnavailable, setRelayUnavailable] = useState(false)
  const [error, setError] = useState("")
  const { showToast } = useToast()
  const widgetScalePercent = Math.round(widgetScale * 100)

  const highestDayTotal = useMemo(() => {
    if (!dashboard?.dailyActivity.length) return 1
    return Math.max(...dashboard.dailyActivity.map((p) => p.solves + p.debug + p.screenshots + p.blocked)) || 1
  }, [dashboard])

  const refreshDashboard = async () => {
    setError("")
    setIsLoading(true)
    try {
      setDashboard(await window.electronAPI.getAccountDashboard())
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to refresh dashboard.")
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const load = async () => {
      setIsLoading(true)
      setError("")
      try {
        const d = await window.electronAPI.getAccountDashboard()
        if (!cancelled) setDashboard(d)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load dashboard.")
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const unsub = window.electronAPI.onSubscriptionUpdated(() => void refreshDashboard())
    return () => unsub()
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
  }, [open, dashboard, isLoading, error, widgetScale, activeTab, relayState])

  useEffect(() => {
    if (open) return
    setGeneratedBillingLink(null)
    setBillingLinkCopied(false)
    setActiveTab("overview")
  }, [open])

  useEffect(() => {
    if (!open) return
    const handle = (e: PointerEvent) => {
      const t = e.target
      if (!(t instanceof Node)) return
      if (t instanceof Element && t.closest("[data-panel-trigger='account-dashboard']")) return
      if (panelRef.current?.contains(t)) return
      onOpenChange(false)
    }
    document.addEventListener("pointerdown", handle)
    return () => document.removeEventListener("pointerdown", handle)
  }, [open, onOpenChange])

  useEffect(() => {
    if (!open) return
    const api = window.electronAPI
    if (!api?.getLocalPhoneRelayState || !api?.onLocalPhoneRelayState) {
      setRelayUnavailable(true)
      setRelayState(null)
      return
    }
    setRelayUnavailable(false)
    void api.getLocalPhoneRelayState().then((r) => {
      if (r.success && r.data?.state) setRelayState(r.data.state)
    })
    const unsub = api.onLocalPhoneRelayState((s) => setRelayState(s))
    return () => unsub()
  }, [open])

  const copyText = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      showToast("Copied", "Copied to clipboard.", "success")
    } catch {
      showToast("Error", "Failed to copy.", "error")
    }
  }

  const handleStartCheckout = async () => {
    setBillingAction("checkout")
    setError("")
    try {
      const s = await window.electronAPI.createCheckoutSession()
      setGeneratedBillingLink({ kind: "checkout", url: s.url })
      setBillingLinkCopied(false)
      await window.electronAPI.openExternal(s.url)
      showToast("Checkout", "Complete subscription in your browser.", "success")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start checkout.")
    } finally {
      setBillingAction(null)
    }
  }

  const handleOpenBillingPortal = async () => {
    setBillingAction("portal")
    setError("")
    try {
      const s = await window.electronAPI.createBillingPortalSession()
      setGeneratedBillingLink({ kind: "portal", url: s.url })
      setBillingLinkCopied(false)
      await window.electronAPI.openExternal(s.url)
      showToast("Billing", "Billing portal opened.", "success")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to open billing.")
    } finally {
      setBillingAction(null)
    }
  }

  const handleOpenSettings = () => {
    onOpenChange(false)
    window.setTimeout(() => void window.electronAPI.openSettingsPortal(), 0)
  }

  const handleOpenRelayManager = () => {
    onOpenChange(false)
    window.setTimeout(() => window.dispatchEvent(new CustomEvent("open-phone-relay")), 0)
  }

  const handleConnectIntegration = async (provider: "google" | "notion", label: string) => {
    setIntegrationAction(`connect:${provider}`)
    setError("")
    try {
      const s = await window.electronAPI.createIntegrationConnectSession({ provider })
      await window.electronAPI.openExternal(s.url)
      showToast(`${label} Connection`, "Complete authorization in your browser, then refresh.", "success")
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed to start ${label} connection.`)
    } finally {
      setIntegrationAction(null)
    }
  }

  const handleDisconnectIntegration = async (provider: "google" | "notion", label: string) => {
    setIntegrationAction(`disconnect:${provider}`)
    setError("")
    try {
      await window.electronAPI.disconnectIntegration({ provider })
      await refreshDashboard()
      showToast(`${label} Disconnected`, `${label} access removed.`, "success")
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed to disconnect ${label}.`)
    } finally {
      setIntegrationAction(null)
    }
  }

  if (!open) return null

  return (
    <div
      ref={panelRef}
      className="sylica-sheet-enter mt-3 flex-none overflow-hidden rounded-[28px] border border-white/10 bg-[#050505] text-white shadow-[0_30px_100px_rgba(0,0,0,0.56)] min-w-[56rem] max-w-[56rem]"
    >
      <div className="max-h-[40rem] overflow-y-auto bg-[radial-gradient(circle_at_top_left,_rgba(125,249,199,0.12),_transparent_30%),radial-gradient(circle_at_top_right,_rgba(158,224,255,0.08),_transparent_25%),linear-gradient(180deg,_rgba(255,255,255,0.03),_rgba(255,255,255,0.01))]">
        {/* Header */}
        <div className="px-6 pt-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-[#9ff7d6] via-[#8be7ff] to-[#7f97ff] text-black font-semibold text-lg shadow-lg shadow-[#7df9c7]/20">
                {dashboard ? getInitials(dashboard.user.name) : "··"}
              </div>
              <div>
                <div className="text-xs uppercase tracking-[0.2em] text-[#7df9c7]">Account Dashboard</div>
                <div className="text-xl font-semibold tracking-tight text-white">{dashboard?.user.name || "Loading..."}</div>
                <div className="text-sm text-white/50">{dashboard?.user.email || ""}</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void refreshDashboard()}
                disabled={isLoading}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-white/70 hover:bg-white/5 hover:text-white transition-colors disabled:opacity-50"
              >
                <svg viewBox="0 0 24 24" fill="none" className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`}>
                  <path d="M3 12a9 9 0 0114.5-7.1L21 8M21 4v4h-4M21 12a9 9 0 01-14.5 7.1L3 16M3 20v-4h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Refresh
              </button>
              <button
                onClick={handleOpenSettings}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-white/70 hover:bg-white/5 hover:text-white transition-colors"
              >
                Settings
              </button>
              <button
                onClick={() => onOpenChange(false)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-white/50 hover:bg-white/5 hover:text-white transition-colors"
              >
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          </div>

          {/* Pills */}
          {dashboard && (
            <div className="mt-4 flex flex-wrap gap-2">
              <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-black">{dashboard.user.subscriptionPlan}</span>
              <span className={`rounded-full px-3 py-1 text-xs font-medium uppercase tracking-wider ${
                dashboard.user.subscriptionStatus === "active" ? "bg-emerald-500/15 text-emerald-400" :
                dashboard.user.subscriptionStatus === "trial" ? "bg-sky-500/15 text-sky-400" :
                dashboard.user.subscriptionStatus === "past_due" ? "bg-amber-500/15 text-amber-400" :
                "bg-red-500/15 text-red-400"
              }`}>
                {dashboard.user.subscriptionStatus}
              </span>
              {dashboard.billing.unlimited && (
                <span className="rounded-full bg-[#7df9c7]/15 px-3 py-1 text-xs font-medium text-[#7df9c7]">Unlimited</span>
              )}
            </div>
          )}
        </div>

        {/* Tabs */}
        <div className="mt-6 border-b border-white/10 px-6">
          <div className="flex gap-6">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`relative pb-3 text-sm font-medium transition-colors ${
                  activeTab === tab.id ? "text-white" : "text-white/50 hover:text-white/70"
                }`}
              >
                {tab.label}
                {activeTab === tab.id && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#7df9c7]" />
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="space-y-6 p-6">
          {error && (
            <div className="flex items-start gap-2 rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-200">
              <svg viewBox="0 0 24 24" fill="none" className="mt-0.5 h-4 w-4 shrink-0">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
                <path d="M12 8v5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              {error}
            </div>
          )}

          {isLoading && !dashboard && (
            <div className="flex items-center justify-center py-12 text-white/50">
              <svg viewBox="0 0 24 24" fill="none" className="mr-2 h-5 w-5 animate-spin">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
                <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              Loading...
            </div>
          )}

          {dashboard && (
            <>
              {/* ===== OVERVIEW ===== */}
              {activeTab === "overview" && (
                <div className="space-y-6 sylica-panel-switch">
                  {/* Stats row */}
                  <div className="grid gap-6 sm:grid-cols-4">
                    <Stat value={String(dashboard.usage.requestsToday)} label="Requests today" sub={dashboard.billing.unlimited ? "Unlimited" : `${dashboard.usage.remainingRequestsToday} remaining`} />
                    <Stat value={String(dashboard.usage.solvesToday)} label="Solves today" sub={`${dashboard.usage.totalSolveCount} lifetime`} />
                    <Stat value={String(dashboard.usage.requestsThisHour)} label="Requests / hour" sub={dashboard.billing.unlimited ? "Unlimited" : `${dashboard.usage.remainingRequestsThisHour} remaining`} />
                    <Stat value={String(dashboard.usage.blockedAttemptsToday)} label="Blocked" sub={`Last used ${formatDate(dashboard.usage.lastUsageAt)}`} />
                  </div>

                  {/* Subscription + Lifetime */}
                  <div className="grid gap-6 md:grid-cols-2">
                    <div>
                      <h3 className="text-xs uppercase tracking-[0.2em] text-[#7df9c7]">Subscription</h3>
                      <p className="mt-1 text-sm text-white/60">{dashboard.billing.statusMessage}</p>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <Button
                          onClick={() => void handleStartCheckout()}
                          disabled={!dashboard.billing.checkoutEnabled || billingAction !== null || dashboard.billing.unlimited}
                          className="rounded-lg bg-white px-4 py-2 text-sm text-black hover:bg-white/90 disabled:opacity-40"
                        >
                          {dashboard.billing.unlimited ? "Unlimited Active" : billingAction === "checkout" ? "Opening..." : `Subscribe $${dashboard.billing.pricePerMonthUsd}/month`}
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => void handleOpenBillingPortal()}
                          disabled={!dashboard.billing.canManageBilling || billingAction !== null}
                          className="rounded-lg border-white/20 px-4 py-2 text-sm text-white hover:bg-white/5"
                        >
                          Manage billing
                        </Button>
                      </div>
                      <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                        <div>
                          <span className="text-white/40">Started:</span>
                          <div className="text-white/80">{formatDate(dashboard.user.subscriptionStartedAt)}</div>
                        </div>
                        <div>
                          <span className="text-white/40">Renews:</span>
                          <div className="text-white/80">{formatDate(dashboard.user.subscriptionRenewsAt)}</div>
                        </div>
                      </div>
                    </div>

                    <div>
                      <h3 className="text-xs uppercase tracking-[0.2em] text-[#7df9c7]">Lifetime usage</h3>
                      <div className="mt-4 space-y-2">
                        <LifetimeRow label="Solves" value={dashboard.usage.totalSolveCount} color="#9ff7d6" />
                        <LifetimeRow label="Debug" value={dashboard.usage.totalDebugCount} color="#8be7ff" />
                        <LifetimeRow label="Screenshots" value={dashboard.usage.totalScreenshotCount} color="#7f97ff" />
                      </div>
                    </div>
                  </div>

                  {/* Mini activity */}
                  <div>
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs uppercase tracking-[0.2em] text-[#7df9c7]">7-Day Activity</h3>
                      <button onClick={() => setActiveTab("activity")} className="text-xs text-white/50 hover:text-white">View all</button>
                    </div>
                    <div className="mt-3 flex items-end gap-2">
                      {dashboard.dailyActivity.map((p) => {
                        const total = p.solves + p.debug + p.screenshots + p.blocked
                        const h = Math.max(4, (total / highestDayTotal) * 64)
                        return (
                          <div key={p.day} className="flex flex-1 flex-col items-center gap-1">
                            <div className="w-full rounded-t bg-gradient-to-t from-[#7df9c7] to-[#8be7ff]" style={{ height: `${h}px` }} />
                            <span className="text-[10px] text-white/40">{formatShortDay(p.day)}</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
              )}

              {/* ===== ACTIVITY ===== */}
              {activeTab === "activity" && (
                <div className="space-y-6 sylica-panel-switch">
                  <div>
                    <h3 className="text-xs uppercase tracking-[0.2em] text-[#7df9c7]">Last 7 Days</h3>
                    <div className="mt-4 flex items-end gap-3">
                      {dashboard.dailyActivity.map((p) => {
                        const total = p.solves + p.debug + p.screenshots + p.blocked
                        const h = Math.max(8, (total / highestDayTotal) * 120)
                        return (
                          <div key={p.day} className="flex flex-1 flex-col items-center gap-2">
                            <div className="relative w-full rounded-xl bg-white/5 p-2">
                              <div className="w-full rounded-lg bg-gradient-to-t from-[#7df9c7] via-[#8be7ff] to-white/80" style={{ height: `${h}px` }} />
                            </div>
                            <span className="text-xs text-white/40">{formatShortDay(p.day)}</span>
                            <span className="text-xs font-medium text-white/70">{total}</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  <div>
                    <h3 className="text-xs uppercase tracking-[0.2em] text-[#7df9c7]">Recent events</h3>
                    <div className="mt-4 divide-y divide-white/10">
                      {dashboard.recentEvents.length === 0 ? (
                        <p className="py-8 text-center text-sm text-white/40">No activity recorded yet.</p>
                      ) : (
                        dashboard.recentEvents.map((e) => (
                          <div key={e.id} className="flex items-start gap-3 py-3">
                            <div className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${e.allowed ? "bg-[#7df9c7]/20 text-[#7df9c7]" : "bg-red-500/20 text-red-400"}`}>
                              {e.allowed ? (
                                <svg viewBox="0 0 24 24" fill="none" className="h-3 w-3"><path d="M5 12l4 4 10-10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                              ) : (
                                <svg viewBox="0 0 24 24" fill="none" className="h-3 w-3"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
                              )}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-medium text-white">{labelForAction(e.action)}</span>
                                <span className="text-xs text-white/40">{formatDate(e.createdAt)}</span>
                              </div>
                              <p className="mt-0.5 text-sm text-white/60">{e.reason || "Request counted successfully."}</p>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* ===== APPS ===== */}
              {activeTab === "apps" && (
                <div className="space-y-6 sylica-panel-switch">
                  <div className="grid gap-4 md:grid-cols-3">
                    {dashboard.integrations.map((i) => {
                      const busy = integrationAction === `connect:${i.provider}` || integrationAction === `disconnect:${i.provider}`
                      return (
                        <div key={i.app} className="rounded-xl bg-white/[0.03] p-4">
                          <div className="flex items-start justify-between">
                            <div className="flex items-center gap-3">
                              <ProviderIcon provider={i.provider} connected={i.connected} />
                              <div>
                                <div className="font-medium text-white">{i.label}</div>
                                {i.sharedConnectionLabel && <div className="text-[10px] uppercase tracking-wider text-[#7df9c7]">{i.sharedConnectionLabel}</div>}
                              </div>
                            </div>
                            <span className={`text-[10px] uppercase tracking-wider ${i.connected ? "text-[#7df9c7]" : i.configured ? "text-white/60" : "text-amber-400"}`}>
                              {i.connected ? "Connected" : i.configured ? "Ready" : "Setup"}
                            </span>
                          </div>
                          <p className="mt-2 text-sm text-white/50">{i.statusText}</p>
                          <div className="mt-3 flex flex-wrap gap-1">
                            {i.supports.map((s) => (
                              <span key={s} className="rounded bg-white/5 px-2 py-0.5 text-[10px] text-white/60">{s}</span>
                            ))}
                          </div>
                          <Button
                            onClick={() => void (i.connected ? handleDisconnectIntegration(i.provider, i.provider === "google" ? "Google" : "Notion") : handleConnectIntegration(i.provider, i.provider === "google" ? "Google" : "Notion"))}
                            disabled={busy || (!i.configured && !i.connected)}
                            className={`mt-3 rounded-lg px-3 py-1.5 text-xs ${i.connected ? "border border-white/20 bg-transparent text-white hover:bg-white/5" : "bg-white text-black hover:bg-white/90"} disabled:opacity-40`}
                          >
                            {busy ? (i.connected ? "Disconnecting..." : "Opening...") : i.connected ? "Disconnect" : "Connect"}
                          </Button>
                        </div>
                      )
                    })}
                  </div>

                  <div>
                    <h3 className="text-xs uppercase tracking-[0.2em] text-[#7df9c7]">Supported commands</h3>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <CommandExamples
                        title="Gmail"
                        examples={["Show my latest Gmail messages", 'Search Gmail for "invoice"', 'Draft Gmail to alice@example.com subject "Follow-up"']}
                      />
                      <CommandExamples
                        title="Calendar + Notion"
                        examples={["Show my upcoming calendar events", 'Create calendar event "Team sync" on 2026-03-20 at 3pm', 'Create Notion page "Interview Notes"']}
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* ===== RELAY ===== */}
              {activeTab === "relay" && (
                <div className="space-y-6 sylica-panel-switch">
                  <div className="flex items-start justify-between rounded-xl bg-white/[0.03] p-4">
                    <div>
                      <h3 className="text-xs uppercase tracking-[0.2em] text-[#7df9c7]">Phone Relay</h3>
                      <p className="mt-1 text-sm text-white/60">Mirror OTPs, clipboard, camera, and commands from your phone.</p>
                      <div className="mt-3 flex gap-2">
                        <Button onClick={handleOpenRelayManager} className="rounded-lg bg-white px-4 py-2 text-sm text-black hover:bg-white/90">Open relay manager</Button>
                        <Button
                          variant="outline"
                          onClick={() => {
                            if (!window.electronAPI?.getLocalPhoneRelayState) return
                            void window.electronAPI.getLocalPhoneRelayState().then((r) => {
                              if (r.success && r.data?.state) {
                                setRelayState(r.data.state)
                                showToast("Relay", "Status refreshed.", "success")
                              }
                            })
                          }}
                          disabled={relayUnavailable}
                          className="rounded-lg border-white/20 px-4 py-2 text-sm text-white hover:bg-white/5 disabled:opacity-40"
                        >
                          Refresh
                        </Button>
                      </div>
                    </div>
                  </div>

                  {relayUnavailable ? (
                    <p className="text-sm text-amber-400/80">Local phone relay is not available in this environment.</p>
                  ) : !relayState ? (
                    <p className="text-sm text-white/50">Loading relay status...</p>
                  ) : (
                    <>
                      <div className="grid gap-4 sm:grid-cols-4">
                        <div className="rounded-xl bg-white/[0.03] p-3">
                          <div className="text-xs text-white/40">Server</div>
                          <div className={`text-lg font-medium ${relayServerStatusClasses(relayState.serverStatus)}`}>{relayServerStatusLabel(relayState.serverStatus)}</div>
                        </div>
                        <div className="rounded-xl bg-white/[0.03] p-3">
                          <div className="text-xs text-white/40">Desktop</div>
                          <div className="truncate text-sm font-medium text-white">{relayState.desktopDeviceName}</div>
                        </div>
                        <div className="rounded-xl bg-white/[0.03] p-3">
                          <div className="text-xs text-white/40">Pairings</div>
                          <div className="text-lg font-medium text-white">{relayState.devices.length}</div>
                        </div>
                        <div className="rounded-xl bg-white/[0.03] p-3">
                          <div className="text-xs text-white/40">Events</div>
                          <div className="text-lg font-medium text-white">{relayState.events.length}</div>
                        </div>
                      </div>

                      {relayState.lastError && <p className="text-sm text-red-300">{relayState.lastError}</p>}

                      <div>
                        <h3 className="text-xs uppercase tracking-[0.2em] text-[#7df9c7]">Recent relay events</h3>
                        <div className="mt-3 divide-y divide-white/10">
                          {relayState.events.slice(0, 8).map((e) => (
                            <div key={e.id} className="flex items-start gap-3 py-3">
                              <span className="mt-0.5 text-[10px] uppercase tracking-wider text-[#7df9c7]">{e.eventType.replace(/_/g, " ")}</span>
                              <div className="min-w-0 flex-1">
                                <p className="text-sm text-white/70">{shortRelayPreview(e)}</p>
                                <p className="text-xs text-white/40">{formatDate(e.createdAt)} · {e.source}</p>
                              </div>
                            </div>
                          ))}
                          {relayState.events.length === 0 && <p className="py-4 text-sm text-white/40">No relay events yet.</p>}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* ===== BILLING ===== */}
              {activeTab === "billing" && (
                <div className="space-y-6 sylica-panel-switch">
                  <div className="rounded-xl bg-white/[0.03] p-5">
                    <h3 className="text-xs uppercase tracking-[0.2em] text-[#7df9c7]">Subscription</h3>
                    <div className="mt-1 text-2xl font-semibold text-white">{dashboard.billing.unlimited ? "Sylica AI Pro" : `$${dashboard.billing.pricePerMonthUsd}/month`}</div>
                    <p className="mt-1 text-sm text-white/60">{dashboard.billing.statusMessage}</p>
                    <div className="mt-4 flex gap-2">
                      <Button
                        onClick={() => void handleStartCheckout()}
                        disabled={!dashboard.billing.checkoutEnabled || billingAction !== null || dashboard.billing.unlimited}
                        className="rounded-lg bg-white px-4 py-2 text-sm text-black hover:bg-white/90 disabled:opacity-40"
                      >
                        {dashboard.billing.unlimited ? "Unlimited Active" : billingAction === "checkout" ? "Opening..." : `Subscribe $${dashboard.billing.pricePerMonthUsd}/month`}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => void handleOpenBillingPortal()}
                        disabled={!dashboard.billing.canManageBilling || billingAction !== null}
                        className="rounded-lg border-white/20 px-4 py-2 text-sm text-white hover:bg-white/5"
                      >
                        Manage billing
                      </Button>
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                      <div><span className="text-white/40">Started:</span><div className="text-white/80">{formatDate(dashboard.user.subscriptionStartedAt)}</div></div>
                      <div><span className="text-white/40">Renews:</span><div className="text-white/80">{formatDate(dashboard.user.subscriptionRenewsAt)}</div></div>
                      <div><span className="text-white/40">Provider:</span><div className="text-white/80">{billingProviderLabel(dashboard.billing.provider)}</div></div>
                      <div><span className="text-white/40">Plan:</span><div className="text-white/80">{dashboard.billing.unlimited ? "Pro" : "Free"}</div></div>
                    </div>
                  </div>

                  {generatedBillingLink && (
                    <div className="rounded-xl bg-white/[0.03] p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-xs text-white/40">{generatedBillingLink.kind === "checkout" ? "Subscribe link" : "Billing link"}</div>
                          <code className="mt-1 block break-all rounded bg-black/30 px-3 py-2 text-xs text-[#7df9c7]">{generatedBillingLink.url}</code>
                        </div>
                        <Button
                          variant="outline"
                          onClick={() => {
                            void copyText(generatedBillingLink.url)
                            setBillingLinkCopied(true)
                            window.setTimeout(() => setBillingLinkCopied(false), 2000)
                          }}
                          className="shrink-0 rounded-lg border-white/20 px-3 py-1.5 text-xs text-white hover:bg-white/5"
                        >
                          {billingLinkCopied ? "Copied" : "Copy"}
                        </Button>
                      </div>
                    </div>
                  )}

                  <div className="grid gap-4 sm:grid-cols-3">
                    <div className="rounded-xl bg-white/[0.03] p-4">
                      <div className="text-xs text-white/40">Requests / day</div>
                      <div className="text-xl font-semibold text-white">{dashboard.billing.unlimited ? "∞" : dashboard.usage.remainingRequestsToday + dashboard.usage.requestsToday}</div>
                    </div>
                    <div className="rounded-xl bg-white/[0.03] p-4">
                      <div className="text-xs text-white/40">Requests / hour</div>
                      <div className="text-xl font-semibold text-white">{dashboard.billing.unlimited ? "∞" : dashboard.user.subscriptionPlan === "free" ? 10 : dashboard.user.rateLimits.requestsPerHour}</div>
                    </div>
                    <div className="rounded-xl bg-white/[0.03] p-4">
                      <div className="text-xs text-white/40">Plan</div>
                      <div className="text-xl font-semibold text-white">{dashboard.billing.unlimited ? "Pro" : "Free"}</div>
                    </div>
                  </div>

                  <div className="rounded-xl bg-white/[0.03] p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-xs uppercase tracking-[0.2em] text-[#7df9c7]">Widget size</h3>
                        <p className="text-sm text-white/60">Resize the main widget to fit your screen.</p>
                      </div>
                      <button onClick={() => onWidgetScaleChange(DEFAULT_WIDGET_SCALE)} className="text-xs text-white/50 hover:text-white">Reset</button>
                    </div>
                    <div className="mt-3 flex items-center gap-3">
                      <span className="text-xs text-white/40">60%</span>
                      <input
                        type="range"
                        min={60}
                        max={140}
                        step={5}
                        value={widgetScalePercent}
                        onChange={(e) => onWidgetScaleChange(Number(e.target.value) / 100)}
                        className="flex-1 accent-[#7df9c7]"
                      />
                      <span className="text-xs text-white/40">140%</span>
                    </div>
                    <div className="mt-2 text-center text-xs font-medium text-white">{widgetScalePercent}%</div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Stat({ value, label, sub }: { value: string; label: string; sub: string }) {
  return (
    <div>
      <div className="text-2xl font-semibold text-white">{value}</div>
      <div className="text-xs uppercase tracking-wider text-white/40">{label}</div>
      <div className="mt-0.5 text-xs text-white/50">{sub}</div>
    </div>
  )
}

function LifetimeRow({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
        <span className="text-sm text-white/70">{label}</span>
      </div>
      <span className="text-lg font-medium text-white">{value}</span>
    </div>
  )
}

function ProviderIcon({ provider, connected }: { provider: string; connected: boolean }) {
  const className = `h-5 w-5 ${connected ? "text-[#7df9c7]" : "text-white/50"}`
  if (provider === "google") {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={className}>
        <path d="M22 12c0-5.5-4.5-10-10-10S2 6.5 2 12s4.5 10 10 10 10-4.5 10-10z" fill="currentColor" fillOpacity="0.1" />
        <path d="M12 11v3h4.5c-.2 1.3-1.5 3.8-4.5 3.8-2.7 0-4.9-2.2-4.9-5s2.2-5 4.9-5c1.5 0 2.5.7 3.1 1.2l2.1-2C16.4 6.2 14.3 5 12 5c-4.4 0-8 3.6-8 8s3.6 8 8 8c4.6 0 7.7-3.2 7.7-7.8 0-.5 0-1-.1-1.2H12z" fill="currentColor" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M4 4h16v16H4V4z" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function CommandExamples({ title, examples }: { title: string; examples: string[] }) {
  return (
    <div className="rounded-xl bg-white/[0.03] p-4">
      <h4 className="font-medium text-white">{title}</h4>
      <div className="mt-2 space-y-1">
        {examples.map((ex, i) => (
          <div key={i} className="rounded bg-black/20 px-2 py-1.5 font-mono text-xs text-white/70">{ex}</div>
        ))}
      </div>
    </div>
  )
}
