import SubscribedApp from "./_pages/SubscribedApp"
import {
  QueryClient,
  QueryClientProvider
} from "@tanstack/react-query"
import { useEffect, useState, useCallback, useRef, type CSSProperties } from "react"
import {
  Toast,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport
} from "./components/ui/toast"
import { ToastContext } from "./contexts/toast"
import { AccountDashboardDialog } from "./components/Account/AccountDashboardDialog"
import { AuthScreen } from "./components/Auth/AuthScreen"
import { SettingsDialog } from "./components/Settings/SettingsDialog"
import UninstallOffboardingDialog from "./components/Uninstall/UninstallOffboardingDialog"
import PhoneRelayWindow from "./components/PhoneRelay/PhoneRelayWindow"
import type { AuthState } from "../shared/backendAuth"
import {
  EMPTY_DESKTOP_UPDATE_STATE,
  type DesktopUpdateState,
} from "../shared/desktopUpdates"
import type {
  LocalPhoneRelayEventSummary,
  LocalPhoneRelayState,
} from "../shared/localPhoneRelay"
import {
  DEFAULT_WIDGET_SCALE,
  normalizeWidgetScale,
} from "../shared/aiConfig"
import type { ComputerUseState, LiveInterviewState } from "../shared/followUpChat"
import { updateWindowToElement } from "./utils/contentSize"

interface PhoneFileNotice {
  id: string
  fileName: string
  savedPath: string
  savedDirectory: string
  details: string
}

function phoneFilePayloadString(
  event: LocalPhoneRelayEventSummary,
  key: string
): string {
  return String(event.payload[key] || "").trim()
}

function formatPhoneFileBytes(value: unknown): string {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return ""
  }

  const units = ["B", "KB", "MB", "GB"]
  let size = bytes
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }

  return `${size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`
}

function buildPhoneFileNotice(
  event: LocalPhoneRelayEventSummary
): PhoneFileNotice {
  const fileName =
    phoneFilePayloadString(event, "savedFileName") ||
    phoneFilePayloadString(event, "originalFileName") ||
    "Phone file"
  const savedPath = phoneFilePayloadString(event, "savedPath")
  const savedDirectory = phoneFilePayloadString(event, "savedDirectory")
  const mimeType = phoneFilePayloadString(event, "mimeType")
  const size = formatPhoneFileBytes(event.payload.size)
  const deviceName = event.pairing.mobileDeviceName || "Phone"
  const kind =
    mimeType.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(fileName)
      ? "Image"
      : "File"
  const details = [kind, size, `from ${deviceName}`].filter(Boolean).join(" - ")

  return {
    id: event.id,
    fileName,
    savedPath,
    savedDirectory,
    details,
  }
}

const IDLE_ISLAND_DELAY_MS = 60_000

function applyWindowOpacityTier(opacity: number) {
  const clamped = Math.max(0, Math.min(1, opacity))
  const tier =
    clamped >= 0.98
      ? "solid"
      : clamped >= 0.85
        ? "high"
        : clamped >= 0.5
          ? "medium"
          : "low"
  document.documentElement.setAttribute("data-opacity-tier", tier)
}
const CLICK_THROUGH_HITBOX_SELECTOR = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "[role='button']",
  "[data-sylica-hitbox='true']",
  ".sylica-widget-dock",
  ".sylica-widget-layout",
  ".sylica-liquid-dock",
  ".sylica-liquid-shell",
  ".sylica-idle-island-strip",
  ".sylica-sheet-enter",
  ".pointer-events-auto",
].join(",")

// Create a React Query client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      gcTime: Infinity,
      retry: 1,
      refetchOnWindowFocus: false
    },
    mutations: {
      retry: 1
    }
  }
})

// Root component that provides the QueryClient
function App() {
  const [toastState, setToastState] = useState({
    open: false,
    title: "",
    description: "",
    variant: "neutral" as "neutral" | "success" | "error"
  })
  const [credits, setCredits] = useState<number>(999) // Unlimited credits
  const [currentLanguage, setCurrentLanguage] = useState<string>("python")
  const [isInitialized, setIsInitialized] = useState(false)
  const [authState, setAuthState] = useState<AuthState>({
    authenticated: false,
    session: null
  })
  // Note: Model selection is now handled via separate extraction/solution/debugging model settings
	
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isAccountDashboardOpen, setIsAccountDashboardOpen] = useState(false)
  const [isPhoneRelayOpen, setIsPhoneRelayOpen] = useState(false)
  const [isUninstallOffboardingOpen, setIsUninstallOffboardingOpen] =
    useState(false)
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState>(
    EMPTY_DESKTOP_UPDATE_STATE
  )
  const [phoneFileNotice, setPhoneFileNotice] = useState<PhoneFileNotice | null>(
    null
  )
  const [widgetScale, setWidgetScale] = useState(DEFAULT_WIDGET_SCALE)
  const [isScreenRecordingVisible, setIsScreenRecordingVisible] = useState(false)
  const [isIdleIsland, setIsIdleIsland] = useState(false)
  const [isRealtimeVoiceActive, setIsRealtimeVoiceActive] = useState(false)
  const [isLiveSessionActive, setIsLiveSessionActive] = useState(false)
  const [isComputerUseActive, setIsComputerUseActive] = useState(false)
  const appShellRef = useRef<HTMLDivElement>(null)
  const seenPhoneFileEventIdsRef = useRef<Set<string>>(new Set())
  const phoneFileNoticeTimerRef = useRef<number | null>(null)
  const widgetScaleSaveTimerRef = useRef<number | null>(null)
  const idleIslandTimerRef = useRef<number | null>(null)
  const hasAuxOpen =
    isSettingsOpen ||
    isAccountDashboardOpen ||
    isPhoneRelayOpen ||
    isUninstallOffboardingOpen
  const hasActiveForegroundSession =
    isRealtimeVoiceActive || isLiveSessionActive || isComputerUseActive
  const canUseIdleIsland =
    isInitialized &&
    authState.authenticated &&
    !hasAuxOpen &&
    !hasActiveForegroundSession
  const isIdleIslandVisible = canUseIdleIsland && isIdleIsland

  // Set unlimited credits
  const updateCredits = useCallback(() => {
    setCredits(999) // No credit limit in this version
    window.__CREDITS__ = 999
  }, [])

  // Helper function to safely update language
  const updateLanguage = useCallback((newLanguage: string) => {
    setCurrentLanguage(newLanguage)
    window.__LANGUAGE__ = newLanguage
  }, [])

  // Helper function to mark initialization complete
  const markInitialized = useCallback(() => {
    setIsInitialized(true)
    window.__IS_INITIALIZED__ = true
  }, [])

  // Show toast method
  const showToast = useCallback(
    (
      title: string,
      description: string,
      variant: "neutral" | "success" | "error"
    ) => {
      setToastState({
        open: true,
        title,
        description,
        variant
      })
    },
    []
  )

  const clearIdleIslandTimer = useCallback(() => {
    if (idleIslandTimerRef.current) {
      window.clearTimeout(idleIslandTimerRef.current)
      idleIslandTimerRef.current = null
    }
  }, [])

  const scheduleIdleIsland = useCallback(() => {
    clearIdleIslandTimer()

    if (!canUseIdleIsland) {
      return
    }

    idleIslandTimerRef.current = window.setTimeout(() => {
      idleIslandTimerRef.current = null
      setIsIdleIsland(true)
    }, IDLE_ISLAND_DELAY_MS)
  }, [canUseIdleIsland, clearIdleIslandTimer])

  const revealIdleIsland = useCallback(() => {
    setIsIdleIsland(false)
    scheduleIdleIsland()
  }, [scheduleIdleIsland])

  const noteUserActivity = useCallback(() => {
    if (isIdleIsland) {
      setIsIdleIsland(false)
    }
    scheduleIdleIsland()
  }, [isIdleIsland, scheduleIdleIsland])

  useEffect(() => {
    if (!canUseIdleIsland) {
      clearIdleIslandTimer()
      setIsIdleIsland(false)
      return
    }

    const activityEvents: Array<keyof WindowEventMap> = [
      "pointerdown",
      "pointermove",
      "keydown",
      "wheel",
      "touchstart",
      "focus",
    ]

    activityEvents.forEach((eventName) => {
      window.addEventListener(eventName, noteUserActivity)
    })
    scheduleIdleIsland()

    return () => {
      activityEvents.forEach((eventName) => {
        window.removeEventListener(eventName, noteUserActivity)
      })
      clearIdleIslandTimer()
    }
  }, [
    canUseIdleIsland,
    clearIdleIslandTimer,
    noteUserActivity,
    scheduleIdleIsland,
  ])

  useEffect(() => {
    if (!isInitialized || !authState.authenticated) {
      return
    }

    let cancelled = false
    const updateLiveActive = (state: LiveInterviewState) => {
      setIsLiveSessionActive(state.status !== "idle")
    }
    const updateComputerActive = (state: ComputerUseState) => {
      setIsComputerUseActive(state.status !== "idle")
    }

    void window.electronAPI.getLiveInterviewState().then((result) => {
      if (!cancelled && result.success) {
        updateLiveActive(result.data.state)
      }
    })
    void window.electronAPI.getComputerUseState().then((result) => {
      if (!cancelled && result.success) {
        updateComputerActive(result.data.state)
      }
    })

    const unsubscribeLive = window.electronAPI.onLiveInterviewState((state) => {
      updateLiveActive(state)
      noteUserActivity()
    })
    const unsubscribeComputer = window.electronAPI.onComputerUseState((state) => {
      updateComputerActive(state)
      noteUserActivity()
    })
    const unsubscribeVoice = window.electronAPI.onVoiceRealtimeEvent((event) => {
      setIsRealtimeVoiceActive(event.type !== "error")
      noteUserActivity()
    })
    const handleVoiceActive = (event: Event) => {
      const active = Boolean((event as CustomEvent<boolean>).detail)
      setIsRealtimeVoiceActive(active)
      noteUserActivity()
    }
    const handleSylicaActivity = () => {
      noteUserActivity()
    }

    window.addEventListener("sylica-voice-active", handleVoiceActive)
    window.addEventListener("sylica-active-use", handleSylicaActivity)

    return () => {
      cancelled = true
      unsubscribeLive()
      unsubscribeComputer()
      unsubscribeVoice()
      window.removeEventListener("sylica-voice-active", handleVoiceActive)
      window.removeEventListener("sylica-active-use", handleSylicaActivity)
    }
  }, [authState.authenticated, isInitialized, noteUserActivity])

  useEffect(() => {
    if (!isInitialized || !authState.authenticated) {
      return
    }

    if (isIdleIslandVisible) {
      void window.electronAPI.setMousePassthrough(false)
      return
    }

    if (isScreenRecordingVisible) {
      void window.electronAPI.setMousePassthrough(false)
      return
    }

    let passthroughEnabled = false

    const setPassthrough = (enabled: boolean) => {
      if (passthroughEnabled === enabled) {
        return
      }

      passthroughEnabled = enabled
      void window.electronAPI
        .setMousePassthrough(enabled)
        .catch((error) => {
          console.warn("Failed to update mouse passthrough:", error)
        })
    }

    const updatePassthroughForPoint = (clientX: number, clientY: number) => {
      const element = document.elementFromPoint(clientX, clientY)
      const isHitbox = Boolean(
        element instanceof Element &&
          element.closest(CLICK_THROUGH_HITBOX_SELECTOR)
      )

      setPassthrough(!isHitbox)
    }

    const handlePointerMove = (event: PointerEvent) => {
      updatePassthroughForPoint(event.clientX, event.clientY)
    }

    const handlePointerLeave = () => {
      setPassthrough(true)
    }

    window.addEventListener("pointermove", handlePointerMove, true)
    window.addEventListener("pointerleave", handlePointerLeave, true)

    return () => {
      window.removeEventListener("pointermove", handlePointerMove, true)
      window.removeEventListener("pointerleave", handlePointerLeave, true)
      void window.electronAPI.setMousePassthrough(false)
    }
  }, [
    authState.authenticated,
    isIdleIslandVisible,
    isInitialized,
    isScreenRecordingVisible,
  ])

  useEffect(() => {
    if (!isInitialized) {
      return
    }

    void window.electronAPI
      .setDynamicIslandMode({ collapsed: isIdleIslandVisible })
      .catch((error) => {
        console.warn("Failed to update dynamic island mode:", error)
      })

    return () => {
      if (isIdleIslandVisible) {
        void window.electronAPI.setDynamicIslandMode({ collapsed: false })
      }
    }
  }, [isIdleIslandVisible, isInitialized])

  // Initialize dropdown handler
  useEffect(() => {
    if (isInitialized) {
      // Process all types of dropdown elements with a shorter delay
      const timer = setTimeout(() => {
        // Find both native select elements and custom dropdowns
        const selectElements = document.querySelectorAll('select');
        const customDropdowns = document.querySelectorAll('.dropdown-trigger, [role="combobox"], button:has(.dropdown)');
        
        // Enable native selects
        selectElements.forEach(dropdown => {
          dropdown.disabled = false;
        });
        
        // Enable custom dropdowns by removing any disabled attributes
        customDropdowns.forEach(dropdown => {
          if (dropdown instanceof HTMLElement) {
            dropdown.removeAttribute('disabled');
            dropdown.setAttribute('aria-disabled', 'false');
          }
        });
        
        console.log(`Enabled ${selectElements.length} select elements and ${customDropdowns.length} custom dropdowns`);
      }, 1000);
      
      return () => clearTimeout(timer);
    }
  }, [isInitialized]);

  useEffect(() => {
    const unsubscribeOpacity = window.electronAPI.onWindowOpacityChanged(
      applyWindowOpacityTier
    )
    return () => {
      unsubscribeOpacity()
    }
  }, [])

  useEffect(() => {
    const handleVisibilityChanged = (event: Event) => {
      const visible = Boolean((event as CustomEvent<boolean>).detail)
      setIsScreenRecordingVisible(visible)
      if (visible) {
        void window.electronAPI.setMousePassthrough(false)
      }
    }

    window.addEventListener(
      "sylica-screen-recording-visibility-changed",
      handleVisibilityChanged
    )
    return () => {
      window.removeEventListener(
        "sylica-screen-recording-visibility-changed",
        handleVisibilityChanged
      )
    }
  }, [])

  // Listen for settings dialog open requests
  useEffect(() => {
    const unsubscribeSettings = window.electronAPI.onShowSettings(() => {
      console.log("Show settings dialog requested");
      setIsAccountDashboardOpen(false)
      setIsPhoneRelayOpen(false)
      setIsSettingsOpen(true)
    });
    
    return () => {
      unsubscribeSettings();
    };
  }, []);

  useEffect(() => {
    const handleOpenAccountDashboard = () => {
      setIsAccountDashboardOpen((previous) => {
        const nextOpen = !previous
        if (nextOpen) {
          setIsSettingsOpen(false)
          setIsPhoneRelayOpen(false)
        }
        return nextOpen
      })
    }
    const handleOpenPhoneRelay = () => {
      setIsPhoneRelayOpen((previous) => {
        const nextOpen = !previous
        if (nextOpen) {
          setIsSettingsOpen(false)
          setIsAccountDashboardOpen(false)
        }
        return nextOpen
      })
    }

    window.addEventListener("open-account-dashboard", handleOpenAccountDashboard)
    window.addEventListener("open-phone-relay", handleOpenPhoneRelay)
    return () => {
      window.removeEventListener(
        "open-account-dashboard",
        handleOpenAccountDashboard
      )
      window.removeEventListener("open-phone-relay", handleOpenPhoneRelay)
    }
  }, [])

  useEffect(() => {
    const unsubscribe = window.electronAPI.onSubscriptionUpdated(() => {
      void window.electronAPI
        .getAuthState()
        .then((nextAuthState) => {
          setAuthState(nextAuthState)
        })
        .catch((error) => {
          console.error("Failed to refresh auth state after billing return:", error)
        })
    })

    return () => {
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    const unsubscribe = window.electronAPI.onAuthStateUpdated((nextAuthState) => {
      setAuthState(nextAuthState)
      if (nextAuthState.authenticated) {
        showToast("Signed in", "Sylica is connected to your account.", "success")
        return
      }
      if (nextAuthState.error) {
        showToast("Login Failed", nextAuthState.error, "error")
      }
    })

    return () => {
      unsubscribe()
    }
  }, [showToast])

  useEffect(() => {
    let cancelled = false

    void window.electronAPI.getUpdateState().then((result) => {
      if (!cancelled && result.success) {
        setDesktopUpdateState(result.data.state)
      }
    })

    const unsubscribe = window.electronAPI.onUpdateState((state) => {
      setDesktopUpdateState(state)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const showPhoneFileNotice = useCallback((event: LocalPhoneRelayEventSummary) => {
    const nextNotice = buildPhoneFileNotice(event)
    setIsIdleIsland(false)
    setPhoneFileNotice(nextNotice)

    if (phoneFileNoticeTimerRef.current) {
      window.clearTimeout(phoneFileNoticeTimerRef.current)
    }

    phoneFileNoticeTimerRef.current = window.setTimeout(() => {
      setPhoneFileNotice((current) =>
        current?.id === nextNotice.id ? null : current
      )
      phoneFileNoticeTimerRef.current = null
    }, 5000)
  }, [])

  useEffect(() => {
    if (!isInitialized || !authState.authenticated) {
      return
    }

    let cancelled = false
    let unsubscribe: (() => void) | null = null
    const rememberFileEvents = (state: LocalPhoneRelayState) => {
      state.events
        .filter((event) => event.eventType === "file")
        .forEach((event) => seenPhoneFileEventIdsRef.current.add(event.id))
    }

    const handleRelayState = (state: LocalPhoneRelayState) => {
      const newFileEvent = state.events.find(
        (event) =>
          event.eventType === "file" &&
          !seenPhoneFileEventIdsRef.current.has(event.id)
      )

      rememberFileEvents(state)
      if (newFileEvent) {
        showPhoneFileNotice(newFileEvent)
      }
    }

    void window.electronAPI
      .getLocalPhoneRelayState()
      .then((result) => {
        if (cancelled) {
          return
        }

        if (result.success) {
          rememberFileEvents(result.data.state)
        }

        unsubscribe = window.electronAPI.onLocalPhoneRelayState(handleRelayState)
      })
      .catch((error) => {
        console.warn("Failed to initialize local phone relay listener:", error)
        if (!cancelled) {
          unsubscribe = window.electronAPI.onLocalPhoneRelayState(handleRelayState)
        }
      })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [authState.authenticated, isInitialized, showPhoneFileNotice])

  useEffect(() => {
    return () => {
      if (phoneFileNoticeTimerRef.current) {
        window.clearTimeout(phoneFileNoticeTimerRef.current)
        phoneFileNoticeTimerRef.current = null
      }
      if (widgetScaleSaveTimerRef.current) {
        window.clearTimeout(widgetScaleSaveTimerRef.current)
        widgetScaleSaveTimerRef.current = null
      }
      if (idleIslandTimerRef.current) {
        window.clearTimeout(idleIslandTimerRef.current)
        idleIslandTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    const unsubscribe = window.electronAPI.onShowUninstallOffboarding(() => {
      setIsUninstallOffboardingOpen(true)
    })

    return () => {
      unsubscribe()
    }
  }, [])

  const handleDownloadUpdate = useCallback(async () => {
    return window.electronAPI.downloadUpdate()
  }, [])

  const handleInstallUpdate = useCallback(async () => {
    return window.electronAPI.installUpdate()
  }, [])

  const handleWidgetScaleChange = useCallback(
    (nextScale: number) => {
      const normalizedScale = normalizeWidgetScale(nextScale)
      setWidgetScale(normalizedScale)

      if (widgetScaleSaveTimerRef.current) {
        window.clearTimeout(widgetScaleSaveTimerRef.current)
      }

      widgetScaleSaveTimerRef.current = window.setTimeout(() => {
        widgetScaleSaveTimerRef.current = null
        void window.electronAPI
          .updateConfig({ widgetScale: normalizedScale })
          .catch((error) => {
            console.error("Failed to save widget size:", error)
            showToast("Widget Size", "Failed to save widget size.", "error")
          })
      }, 180)
    },
    [showToast]
  )

  const handleOpenPhoneFile = useCallback(async () => {
    if (!phoneFileNotice) {
      return
    }

    const targetPath = phoneFileNotice.savedPath || phoneFileNotice.savedDirectory
    if (!targetPath) {
      showToast("Phone Upload", "No saved file path is available.", "error")
      return
    }

    const result = await window.electronAPI.openLocalPath(targetPath)
    if (!result.success) {
      showToast("Phone Upload", result.error || "Failed to open the file.", "error")
    }
  }, [phoneFileNotice, showToast])

  const handleCopyPhoneFilePath = useCallback(async () => {
    if (!phoneFileNotice) {
      return
    }

    const targetPath = phoneFileNotice.savedPath || phoneFileNotice.savedDirectory
    if (!targetPath) {
      showToast("Phone Upload", "No saved file path is available.", "error")
      return
    }

    try {
      await navigator.clipboard.writeText(targetPath)
      showToast("Phone Upload", "File path copied.", "success")
    } catch (_error) {
      showToast("Phone Upload", "Failed to copy the file path.", "error")
    }
  }, [phoneFileNotice, showToast])

  // Initialize basic app state
  useEffect(() => {
    // Load config and set values
    const initializeApp = async () => {
      try {
        // Set unlimited credits
        updateCredits()
        
        // Load config including language and model settings
        const [config, nextAuthState] = await Promise.all([
          window.electronAPI.getConfig(),
          window.electronAPI.getAuthState()
        ])
        
        // Load language preference
        if (config && config.language) {
          updateLanguage(config.language)
        } else {
          updateLanguage("python")
        }
        setWidgetScale(normalizeWidgetScale(config?.widgetScale))
        setIsScreenRecordingVisible(Boolean(config?.screenRecordingVisible))
        applyWindowOpacityTier(
          typeof config?.opacity === "number" ? config.opacity : 1
        )

        setAuthState(nextAuthState)
        
        // Model settings are now managed through the settings dialog
        // and stored in config as extractionModel, solutionModel, and debuggingModel
        
        markInitialized()
      } catch (error) {
        console.error("Failed to initialize app:", error)
        // Fallback to defaults
        updateLanguage("python")
        setAuthState({
          authenticated: false,
          session: null,
          error:
            error instanceof Error ? error.message : "Failed to initialize authentication."
        })
        markInitialized()
      }
    }
    
    initializeApp()

    // Event listeners for process events
    const onApiKeyInvalid = () => {
      showToast(
        "Provider Not Ready",
        "The selected provider is not configured, the key is invalid, or it is out of credits.",
        "error"
      )
      setIsSettingsOpen(true)
    }

    const onUnauthorized = () => {
      setAuthState({
        authenticated: false,
        session: null,
        error: "Please log in before using Sylica AI."
      })
      setIsAccountDashboardOpen(false)
      showToast("Login Required", "Please log in to continue.", "error")
    }

    // Setup API key invalid listener
    const unsubscribeApiKeyInvalid = window.electronAPI.onApiKeyInvalid(
      onApiKeyInvalid
    )
    const unsubscribeUnauthorized = window.electronAPI.onUnauthorized(
      onUnauthorized
    )

    // Define a no-op handler for solution success
    const unsubscribeSolutionSuccess = window.electronAPI.onSolutionSuccess(
      () => {
        console.log("Solution success - no credits deducted in this version")
        // No credit deduction in this version
      }
    )

    // Cleanup function
    return () => {
      unsubscribeApiKeyInvalid()
      unsubscribeUnauthorized()
      unsubscribeSolutionSuccess()
      window.__IS_INITIALIZED__ = false
      setIsInitialized(false)
    }
  }, [updateCredits, updateLanguage, markInitialized, showToast])

  const handleAuthenticated = useCallback((nextAuthState: AuthState) => {
    setAuthState(nextAuthState)
  }, [])

  const handleCloseSettings = useCallback((open: boolean) => {
    console.log('Settings dialog state changed:', open);
    setIsSettingsOpen(open);
  }, []);

  const handleCloseAccountDashboard = useCallback((open: boolean) => {
    setIsAccountDashboardOpen(open)
  }, [])

  useEffect(() => {
    if (
      !isInitialized ||
      !authState.authenticated ||
      !appShellRef.current
    ) {
      return
    }

    const timer = window.setTimeout(() => {
      if (!appShellRef.current) return
      updateWindowToElement(appShellRef.current)
    }, 60)

    return () => window.clearTimeout(timer)
  }, [
    isInitialized,
    authState.authenticated,
    isSettingsOpen,
    isAccountDashboardOpen,
    isPhoneRelayOpen,
    phoneFileNotice,
    widgetScale,
    isIdleIslandVisible,
  ])

  const widgetScaleStyle = {
    zoom: widgetScale,
  } as CSSProperties & { zoom: number }

  return (
    <QueryClientProvider client={queryClient}>
        <ToastProvider>
        <ToastContext.Provider value={{ showToast }}>
          <div className="relative inline-block bg-transparent">
            {isInitialized ? (
              authState.authenticated ? (
                <div
                  ref={appShellRef}
                  data-app-shell="true"
                  data-aux-open={
                    hasAuxOpen ? "true" : "false"
                  }
                  data-idle-island={isIdleIslandVisible ? "true" : "false"}
                  className="inline-flex flex-col items-start bg-transparent"
                >
                  {isIdleIslandVisible ? (
                    <button
                      type="button"
                      aria-label="Reveal Sylica AI"
                      data-sylica-hitbox="true"
                      data-sylica-size-box="true"
                      className="sylica-idle-island-strip"
                      onFocus={revealIdleIsland}
                      onPointerEnter={revealIdleIsland}
                      onClick={revealIdleIsland}
                    />
                  ) : (
                    <div style={widgetScaleStyle} className="origin-top-left">
                      {phoneFileNotice ? (
                        <div
                          data-sylica-size-box="true"
                          className="sylica-sheet-enter mb-1.5 flex h-8 w-[var(--sylica-widget-shell-width)] max-w-[var(--sylica-widget-shell-width)] items-center gap-2 rounded-full border border-white/8 bg-[#12141a] px-2.5 text-white shadow-[0_8px_24px_rgba(0,0,0,0.26)]"
                        >
                          <div className="min-w-0 flex-1 truncate text-[10.5px] font-medium tracking-[-0.01em] text-white/78">
                            <span className="font-semibold text-white">
                              {phoneFileNotice.fileName}
                            </span>
                            <span className="text-white/38"> - {phoneFileNotice.details}</span>
                          </div>
                          <button
                            type="button"
                            className="rounded-full bg-white px-2.5 py-0.5 text-[10px] font-semibold text-black transition hover:bg-white/90"
                            onClick={handleOpenPhoneFile}
                          >
                            Open
                          </button>
                          <button
                            type="button"
                            className="rounded-full border border-white/10 px-2.5 py-0.5 text-[10px] font-semibold text-white/82 transition hover:bg-white/10"
                            onClick={handleCopyPhoneFilePath}
                          >
                            Copy
                          </button>
                        </div>
                      ) : null}
                      <SubscribedApp
                        credits={credits}
                        currentLanguage={currentLanguage}
                        setLanguage={updateLanguage}
                        desktopUpdateState={desktopUpdateState}
                        onDownloadUpdate={handleDownloadUpdate}
                        onInstallUpdate={handleInstallUpdate}
                      />
                    </div>
                  )}
                  <SettingsDialog 
                    open={isSettingsOpen} 
                    onOpenChange={handleCloseSettings} 
                  />
                  <AccountDashboardDialog
                    open={isAccountDashboardOpen}
                    onOpenChange={handleCloseAccountDashboard}
                    widgetScale={widgetScale}
                    onWidgetScaleChange={handleWidgetScaleChange}
                  />
                  <PhoneRelayWindow
                    open={isPhoneRelayOpen}
                    onOpenChange={setIsPhoneRelayOpen}
                  />
                  <UninstallOffboardingDialog
                    open={isUninstallOffboardingOpen}
                    authState={authState}
                    onOpenChange={setIsUninstallOffboardingOpen}
                  />
                </div>
              ) : (
                <AuthScreen
                  initialError={authState.error}
                  onAuthenticated={handleAuthenticated}
                />
              )
            ) : (
              <div
                data-size-root="true"
                className="inline-flex items-center justify-center bg-transparent p-4"
              >
                <div className="flex flex-col items-center gap-3 rounded-xl border border-white/10 bg-black/70 px-5 py-4 text-white shadow-lg">
                  <div className="w-6 h-6 border-2 border-white/20 border-t-white/80 rounded-full animate-spin"></div>
                  <p className="text-sm text-white/60">
                    Initializing...
                  </p>
                </div>
              </div>
            )}
            {!authState.authenticated && (
              <UninstallOffboardingDialog
                open={isUninstallOffboardingOpen}
                authState={authState}
                onOpenChange={setIsUninstallOffboardingOpen}
              />
            )}
          </div>
          
          <Toast
            open={toastState.open}
            onOpenChange={(open) =>
              setToastState((prev) => ({ ...prev, open }))
            }
            variant={toastState.variant}
            duration={1500}
          >
            <ToastTitle>{toastState.title}</ToastTitle>
            <ToastDescription>{toastState.description}</ToastDescription>
          </Toast>
          <ToastViewport />
        </ToastContext.Provider>
      </ToastProvider>
    </QueryClientProvider>
  )
}

export default App
