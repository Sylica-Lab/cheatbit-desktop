import { useEffect, useMemo, useRef, useState } from "react"
import QRCode from "qrcode"
import { Copy, Link2, QrCode, RefreshCw, Smartphone } from "lucide-react"
import type {
  LocalPhoneRelayEventSummary,
  LocalPhoneRelayState,
} from "../../../shared/localPhoneRelay"
import { useToast } from "../../contexts/toast"
import { updateWindowToElement } from "../../utils/contentSize"

interface PhoneRelayWindowProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

function formatDateLabel(value: string | null): string {
  if (!value) {
    return "Never"
  }

  try {
    return new Date(value).toLocaleString()
  } catch (_error) {
    return value
  }
}

function relayEventPreview(event: LocalPhoneRelayEventSummary): string {
  if (event.eventType === "clipboard") {
    return String(event.payload.text || "").trim().slice(0, 140) || "Clipboard text"
  }

  if (event.eventType === "otp") {
    const code = String(event.payload.code || "").trim()
    const label = String(event.payload.label || "").trim()
    return label ? `${label}: ${code}` : code || "OTP"
  }

  if (event.eventType === "link") {
    return (
      String(event.payload.title || "").trim() ||
      String(event.payload.url || "").trim() ||
      "Shared link"
    )
  }

  return (
    String(event.payload.title || "").trim() ||
    String(event.payload.text || "").trim().slice(0, 140) ||
    "Quick note"
  )
}

function eventActionLabel(event: LocalPhoneRelayEventSummary): string {
  switch (event.eventType) {
    case "clipboard":
      return "Clipboard"
    case "otp":
      return "OTP"
    case "link":
      return "Link"
    default:
      return "Note"
  }
}

const EMPTY_STATE: LocalPhoneRelayState = {
  serverStatus: "offline",
  apiBaseUrl: null,
  desktopDeviceName: "Sylica AI Desktop",
  activePairing: null,
  activeManualCode: null,
  activeQrPayload: null,
  devices: [],
  events: [],
  lastError: null,
}

export default function PhoneRelayWindow({
  open,
  onOpenChange,
}: PhoneRelayWindowProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const { showToast } = useToast()
  const [relayState, setRelayState] = useState<LocalPhoneRelayState>(EMPTY_STATE)
  const [desktopDeviceName, setDesktopDeviceName] = useState("Sylica AI Desktop")
  const [isLoading, setIsLoading] = useState(true)
  const [isPairingPending, setIsPairingPending] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState("")

  const apiBaseUrl = relayState.apiBaseUrl
  const statusLabel = useMemo(() => {
    if (relayState.serverStatus === "ready") return "Ready"
    if (relayState.serverStatus === "starting") return "Starting"
    if (relayState.serverStatus === "error") return "Needs attention"
    return "Offline"
  }, [relayState.serverStatus])

  useEffect(() => {
    let cancelled = false

    const loadState = async () => {
      const result = await window.electronAPI.getLocalPhoneRelayState()
      if (!cancelled && result.success) {
        setRelayState(result.data.state)
        setDesktopDeviceName(result.data.state.desktopDeviceName)
      }
      if (!cancelled) {
        setIsLoading(false)
      }
    }

    void loadState()
    const unsubscribe = window.electronAPI.onLocalPhoneRelayState((state) => {
      setRelayState(state)
      setDesktopDeviceName((current) =>
        current.trim() ? current : state.desktopDeviceName
      )
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const buildQr = async () => {
      if (!relayState.activeQrPayload) {
        setQrDataUrl("")
        return
      }

      try {
        const nextQr = await QRCode.toDataURL(
          JSON.stringify(relayState.activeQrPayload),
          {
            width: 220,
            margin: 1,
            color: {
              dark: "#102334",
              light: "#ffffff",
            },
          }
        )

        if (!cancelled) {
          setQrDataUrl(nextQr)
        }
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to generate local relay QR:", error)
          setQrDataUrl("")
        }
      }
    }

    void buildQr()
    return () => {
      cancelled = true
    }
  }, [relayState.activeQrPayload])

  useEffect(() => {
    if (!open) {
      return
    }

    if (!panelRef.current) {
      return
    }

    const resize = () => {
      if (!panelRef.current) {
        return
      }

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
  }, [
    open,
    relayState,
    isLoading,
    isPairingPending,
    qrDataUrl,
  ])

  useEffect(() => {
    if (!open) {
      return
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) {
        return
      }

      if (
        target instanceof Element &&
        target.closest("[data-panel-trigger='phone-relay']")
      ) {
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

  const copyText = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      showToast(label, "Copied to clipboard.", "success")
    } catch (_error) {
      showToast(label, "Failed to copy.", "error")
    }
  }

  const handleStartPairing = async () => {
    setIsPairingPending(true)
    const result = await window.electronAPI.createLocalPhonePairingSession({
      desktopDeviceName: desktopDeviceName.trim() || "Sylica AI Desktop",
    })
    setIsPairingPending(false)

    if (!result.success) {
      showToast("Relay Manager", result.error, "error")
      return
    }

    setRelayState(result.data.state)
    showToast("Relay Manager", "Scan the QR code in Sylica Mobile.", "success")
  }

  const handleOpenEvent = async (event: LocalPhoneRelayEventSummary) => {
    if (event.eventType !== "link") {
      return
    }

    const rawUrl = String(event.payload.url || "").trim()
    if (!rawUrl) {
      return
    }

    const result = await window.electronAPI.openExternal(rawUrl)
    if (!result.success) {
      showToast("Relay Manager", result.error || "Failed to open the link.", "error")
    }
  }

  if (!open) {
    return null
  }

  return (
    <div
      ref={panelRef}
      className="sylica-sheet-enter mt-3 flex-none overflow-hidden rounded-[26px] border border-white/10 bg-[#050505] text-white shadow-[0_24px_84px_rgba(0,0,0,0.52)] min-w-[56rem] max-w-[56rem]"
    >
      <div className="max-h-[38rem] space-y-3 overflow-y-auto bg-[radial-gradient(circle_at_top_left,_rgba(158,224,255,0.16),_transparent_24%),linear-gradient(180deg,_rgba(255,255,255,0.035),_rgba(255,255,255,0.01))] p-3.5 pb-4 sm:p-4">
        <div className="rounded-[22px] border border-white/10 bg-white/[0.04] px-4 py-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-[18px] bg-white text-[#102334] shadow-sm">
                <Smartphone className="h-4 w-4" />
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white/50">
                  Relay Manager
                </p>
                <h2 className="mt-1 text-[17px] font-semibold tracking-[-0.04em] text-white">
                  Local phone pairing
                </h2>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div className="rounded-full bg-white/10 px-3 py-1.5 text-[11px] font-medium text-white/82">
                {statusLabel}
              </div>
              <button
                type="button"
                className="rounded-full border border-white/10 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-white/5"
                onClick={() => onOpenChange(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <section className="flex min-h-[15rem] flex-col rounded-[22px] border border-white/10 bg-white/[0.035] p-3.5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-[0.2em] text-white/40">
                  Local Bridge
                </div>
                <div className="mt-1 text-[14px] font-semibold text-white">
                  Desktop endpoint
                </div>
              </div>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-white/10"
                onClick={() => {
                  setIsLoading(true)
                  void window.electronAPI.getLocalPhoneRelayState().then((result) => {
                    setIsLoading(false)
                    if (result.success) {
                      setRelayState(result.data.state)
                    } else {
                      showToast("Relay Manager", result.error, "error")
                    }
                  })
                }}
              >
                <RefreshCw className="h-3 w-3" />
                Refresh
              </button>
            </div>

            <div className="mt-3 flex-1 space-y-2.5">
              <div>
                <label className="block text-[10px] uppercase tracking-[0.18em] text-white/40">
                  Desktop name
                </label>
                <input
                  type="text"
                  value={desktopDeviceName}
                  onChange={(event) => setDesktopDeviceName(event.target.value)}
                  className="mt-1.5 w-full rounded-[16px] border border-white/10 bg-black/20 px-3 py-2 text-[12px] text-white outline-none transition-colors focus:border-white/20"
                  placeholder="Sylica AI Desktop"
                />
              </div>

              <div>
                <div className="text-[10px] uppercase tracking-[0.18em] text-white/40">
                  Local API URL
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <code className="flex-1 break-all rounded-[14px] border border-white/10 bg-white/[0.03] px-2.5 py-2 text-[10px] text-white/82">
                    {apiBaseUrl || (isLoading ? "Starting local relay…" : "No LAN address found")}
                  </code>
                  {apiBaseUrl ? (
                    <button
                      type="button"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-[12px] bg-white text-black hover:opacity-90"
                      onClick={() => {
                        void copyText(apiBaseUrl, "Local API URL")
                      }}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
              </div>

              <p className={`text-[10px] leading-5 ${relayState.lastError ? "text-red-300" : "text-white/52"}`}>
                {relayState.lastError || "Phone and desktop must be on the same Wi-Fi or local network."}
              </p>
            </div>
          </section>

          <section className="flex min-h-[15rem] flex-col rounded-[22px] border border-white/10 bg-white/[0.035] p-3.5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-[0.18em] text-white/40">
                  Pairing
                </div>
                <div className="mt-1 text-[14px] font-semibold text-white">
                  QR and manual code
                </div>
              </div>
              <button
                type="button"
                className="rounded-full bg-white px-3 py-1.5 text-[11px] font-medium text-black hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => {
                  void handleStartPairing()
                }}
                disabled={isPairingPending}
              >
                {isPairingPending
                  ? "Preparing…"
                  : relayState.activePairing
                    ? "Refresh"
                  : "Start"}
              </button>
            </div>

            {relayState.activePairing ? (
              <div className="grid flex-1 grid-cols-[132px_minmax(0,1fr)] gap-3">
                <div className="rounded-[16px] border border-white/10 bg-white p-2">
                  {qrDataUrl ? (
                    <img
                      src={qrDataUrl}
                      alt="Local relay QR"
                      className="h-auto w-full rounded-[10px]"
                    />
                  ) : (
                    <div className="flex h-[124px] items-center justify-center rounded-[10px] bg-slate-100 text-slate-500">
                      <QrCode className="h-6 w-6" />
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="text-[12px] font-medium text-white">
                    Waiting for Sylica Mobile to scan or paste this code.
                  </div>
                  <div className="text-[10px] text-white/52">
                    Expires {formatDateLabel(relayState.activePairing.expiresAt)}
                  </div>
                  <div className="rounded-[14px] border border-white/10 bg-white/[0.03] px-2.5 py-2 text-[10px] leading-5 text-white/72">
                    {relayState.activeManualCode}
                  </div>
                  <button
                    type="button"
                    className="rounded-full border border-white/10 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-white/5"
                    onClick={() => {
                      if (relayState.activeManualCode) {
                        void copyText(relayState.activeManualCode, "Pairing code")
                      }
                    }}
                  >
                    Copy Code
                  </button>
                </div>
              </div>
            ) : (
              <div className="rounded-[18px] border border-dashed border-white/10 bg-white/[0.03] px-3 py-3 text-[11px] leading-5 text-white/50">
                Start pairing to generate a QR code for Sylica Mobile.
              </div>
            )}
          </section>

          <section className="flex min-h-[15rem] flex-col rounded-[22px] border border-white/10 bg-white/[0.035] p-3.5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-[0.18em] text-white/40">
                  Devices
                </div>
                <div className="mt-1 text-[14px] font-semibold text-white">
                  Connected phones
                </div>
              </div>
              <div className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white/72">
                {relayState.devices.length}
              </div>
            </div>

            <div className="mt-3 flex-1 space-y-2 overflow-y-auto pr-1">
              {relayState.devices.length === 0 ? (
                <div className="rounded-[18px] border border-dashed border-white/10 bg-black/20 px-3 py-3 text-[11px] leading-5 text-white/50">
                  No paired device yet.
                </div>
              ) : (
                relayState.devices.map((device) => (
                  <div
                    key={device.id}
                    className="rounded-[16px] border border-white/10 bg-black/20 px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[12px] font-medium text-white">
                          {device.mobileDeviceName || "Mobile device"}
                        </div>
                        <div className="mt-1 text-[10px] text-white/52">
                          Desktop: {device.desktopDeviceName}
                        </div>
                      </div>
                      <span className="rounded-full border border-emerald-300/20 bg-emerald-300/15 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-emerald-100">
                        {device.status}
                      </span>
                    </div>
                    <div className="mt-1.5 text-[10px] text-white/45">
                      Last seen {formatDateLabel(device.lastSeenAt)}
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="flex min-h-[15rem] flex-col rounded-[22px] border border-white/10 bg-white/[0.035] p-3.5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-[0.18em] text-white/40">
                  Relay feed
                </div>
                <div className="mt-1 text-[14px] font-semibold text-white">
                  Incoming events
                </div>
              </div>
              <div className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white/72">
                {relayState.events.length}
              </div>
            </div>

            <div className="mt-3 flex-1 overflow-y-auto pr-1">
              {relayState.events.length === 0 ? (
                <div className="rounded-[18px] border border-dashed border-white/10 bg-black/20 px-3 py-3 text-[11px] leading-5 text-white/50">
                  Relay events will appear here once the mobile app sends them.
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {relayState.events.map((event) => (
                    <div
                      key={event.id}
                      className="min-h-[6.2rem] rounded-[16px] border border-white/10 bg-black/20 px-3 py-2"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-[10px] uppercase tracking-[0.16em] text-sky-100">
                            {eventActionLabel(event)}
                          </div>
                          <div className="mt-1 line-clamp-2 text-[11px] leading-5 text-white/75">
                            {relayEventPreview(event)}
                          </div>
                          <div className="mt-1 text-[10px] text-white/45">
                            {event.pairing.mobileDeviceName || "Mobile device"} • {formatDateLabel(event.createdAt)}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="shrink-0 rounded-full border border-white/10 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-white/5"
                          onClick={() => {
                            if (event.eventType === "link") {
                              void handleOpenEvent(event)
                              return
                            }

                            const value =
                              event.eventType === "link"
                                ? String(event.payload.url || "")
                                : event.eventType === "otp"
                                  ? String(event.payload.code || "")
                                  : String(event.payload.text || "")
                            void copyText(value, eventActionLabel(event))
                          }}
                        >
                          {event.eventType === "link" ? "Open" : "Copy"}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
