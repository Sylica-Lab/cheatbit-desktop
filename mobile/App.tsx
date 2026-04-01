import { StatusBar } from "expo-status-bar"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ActivityIndicator,
  Alert,
  AppState,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import * as Clipboard from "expo-clipboard"
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera"
import {
  completeLocalPhonePairing,
  createBillingPortalSession,
  createCheckoutSession,
  getApiBaseUrl,
  getCurrentSession,
  getDashboard,
  getMessages,
  listThreads,
  login,
  register,
  sendLocalPhoneRelayEvent,
  sendMobileChat,
} from "./src/api"
import {
  clearStoredSession,
  loadStoredLocalRelayConnections,
  loadStoredSession,
  saveStoredLocalRelayConnections,
  saveStoredSession,
} from "./src/storage"
import {
  EMPTY_ANDROID_RELAY_CAPABILITY_STATE,
  getAndroidRelayCapabilityState,
  isAndroidRelayNativeAvailable,
  openInputMethodRelaySettings,
  openNotificationRelaySettings,
  showRelayInputMethodPicker,
  syncAndroidRelayConnections,
} from "./src/androidRelay"
import type {
  AndroidRelayCapabilityState,
  AuthSession,
  ChatThreadSummary,
  LocalPhonePairingQrPayload,
  LocalPhoneRelayConnection,
  LocalPhoneRelayEventSummary,
  PersistedChatMessage,
  UserDashboardData,
} from "./src/types"

type AuthMode = "login" | "register"
type AppTab = "chat" | "account" | "relay"

const COLORS = {
  bg: "#e9f5ff",
  hero: "#6ea8d9",
  card: "rgba(255,255,255,0.84)",
  cardStrong: "#ffffff",
  border: "rgba(13, 19, 28, 0.08)",
  text: "#102334",
  subtext: "#587087",
  accent: "#131313",
  accentSoft: "#eef8ff",
  mint: "#dff7ef",
  mintText: "#164a3a",
}

function formatDateLabel(value: string | null | undefined) {
  if (!value) {
    return "Never"
  }

  try {
    return new Date(value).toLocaleString()
  } catch (_error) {
    return value
  }
}

function parsePhonePairingPayload(rawValue: string): {
  apiBaseUrl: string
  pairingId: string
  pairingToken: string
} | null {
  const trimmed = String(rawValue || "").trim()
  if (!trimmed) {
    return null
  }

  const parseObjectPayload = (payload: {
    type?: string
    apiBaseUrl?: string
    pairingId?: string
    pairingToken?: string
  }) => {
    if (
      (payload?.type === "sylica-local-phone-relay" ||
        payload?.type === "sylica-phone-pair") &&
      typeof payload.apiBaseUrl === "string" &&
      typeof payload.pairingId === "string" &&
      typeof payload.pairingToken === "string"
    ) {
      return {
        apiBaseUrl: payload.apiBaseUrl.trim(),
        pairingId: payload.pairingId.trim(),
        pairingToken: payload.pairingToken.trim(),
      }
    }

    return null
  }

  if (trimmed.startsWith("{")) {
    try {
      const parsedPayload = parseObjectPayload(JSON.parse(trimmed) as {
        type?: string
        apiBaseUrl?: string
        pairingId?: string
        pairingToken?: string
      })

      if (parsedPayload) {
        return parsedPayload
      }
    } catch (_error) {
      return null
    }
  }

  try {
    const parsedUrl = new URL(trimmed)
    const wrappedPayload =
      parsedUrl.searchParams.get("payload") ||
      parsedUrl.searchParams.get("code") ||
      parsedUrl.searchParams.get("pairing")

    if (wrappedPayload) {
      return parsePhonePairingPayload(decodeURIComponent(wrappedPayload))
    }

    const parsedUrlPayload = parseObjectPayload({
      type: parsedUrl.searchParams.get("type") || "sylica-local-phone-relay",
      apiBaseUrl: parsedUrl.searchParams.get("apiBaseUrl") || undefined,
      pairingId: parsedUrl.searchParams.get("pairingId") || undefined,
      pairingToken: parsedUrl.searchParams.get("pairingToken") || undefined,
    })

    if (parsedUrlPayload) {
      return parsedUrlPayload
    }
  } catch (_error) {
    // Not a URL payload.
  }

  const segments = trimmed.split("|").map((segment) => segment.trim())
  if (segments.length !== 3) {
    return null
  }

  const [apiBaseUrl, pairingId, pairingToken] = segments
  if (!apiBaseUrl || !pairingId || !pairingToken) {
    return null
  }

  return {
    apiBaseUrl,
    pairingId,
    pairingToken,
  }
}

function relayEventPreview(event: LocalPhoneRelayEventSummary) {
  if (event.eventType === "clipboard") {
    return String(event.payload.text || "").trim().slice(0, 120) || "Clipboard text"
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
    String(event.payload.text || "").trim().slice(0, 120) ||
    "Phone note"
  )
}

function AuthButton(props: {
  label: string
  onPress: () => void
  disabled?: boolean
  variant?: "primary" | "secondary"
}) {
  const isPrimary = props.variant !== "secondary"
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled}
      style={[
        styles.button,
        isPrimary ? styles.primaryButton : styles.secondaryButton,
        props.disabled ? styles.buttonDisabled : null,
      ]}
    >
      <Text style={[styles.buttonText, isPrimary ? styles.primaryButtonText : styles.secondaryButtonText]}>
        {props.label}
      </Text>
    </Pressable>
  )
}

function SectionCard(props: {
  eyebrow?: string
  title: string
  subtitle?: string
  children: React.ReactNode
  compact?: boolean
}) {
  return (
    <View style={[styles.sectionCard, props.compact ? styles.sectionCardCompact : null]}>
      <View style={styles.sectionHeader}>
        <View style={styles.sectionHeaderText}>
          <View style={styles.sectionTitleRow}>
            {props.eyebrow ? <Text style={styles.sectionEyebrow}>{props.eyebrow}</Text> : null}
            <Text style={styles.sectionCardTitle}>{props.title}</Text>
          </View>
          {props.subtitle ? <Text style={styles.sectionCardSubtitle}>{props.subtitle}</Text> : null}
        </View>
      </View>
      <View style={styles.sectionCardBody}>{props.children}</View>
    </View>
  )
}

function StatTile(props: {
  label: string
  value: string | number
  tone?: "default" | "mint" | "dark"
}) {
  return (
    <View
      style={[
        styles.statTile,
        props.tone === "mint"
          ? styles.statTileMint
          : props.tone === "dark"
          ? styles.statTileDark
          : null,
      ]}
    >
      <Text
        style={[
          styles.statTileLabel,
          props.tone === "dark" ? styles.statTileLabelDark : null,
        ]}
      >
        {props.label}
      </Text>
      <Text
        style={[
          styles.statTileValue,
          props.tone === "dark" ? styles.statTileValueDark : null,
        ]}
      >
        {props.value}
      </Text>
    </View>
  )
}

function BottomTabButton(props: {
  active: boolean
  label: string
  glyph: string
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={props.onPress}
      style={[styles.bottomTabButton, props.active ? styles.bottomTabButtonActive : null]}
    >
      <Text style={[styles.bottomTabGlyph, props.active ? styles.bottomTabGlyphActive : null]}>
        {props.glyph}
      </Text>
      <Text style={[styles.bottomTabLabel, props.active ? styles.bottomTabLabelActive : null]}>
        {props.label}
      </Text>
    </Pressable>
  )
}

export default function App() {
  const [session, setSession] = useState<AuthSession | null>(null)
  const [dashboard, setDashboard] = useState<UserDashboardData | null>(null)
  const [threads, setThreads] = useState<ChatThreadSummary[]>([])
  const [messages, setMessages] = useState<PersistedChatMessage[]>([])
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [tab, setTab] = useState<AppTab>("chat")
  const [authMode, setAuthMode] = useState<AuthMode>("login")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [chatInput, setChatInput] = useState("")
  const [errorMessage, setErrorMessage] = useState("")
  const [isBooting, setIsBooting] = useState(true)
  const [isAuthPending, setIsAuthPending] = useState(false)
  const [isChatPending, setIsChatPending] = useState(false)
  const [isAccountPending, setIsAccountPending] = useState(false)
  const [phoneDevices, setPhoneDevices] = useState<LocalPhoneRelayConnection[]>([])
  const [phoneRelayEvents, setPhoneRelayEvents] = useState<LocalPhoneRelayEventSummary[]>([])
  const [selectedPairingId, setSelectedPairingId] = useState<string | null>(null)
  const [pairingCode, setPairingCode] = useState("")
  const [mobileDeviceName, setMobileDeviceName] = useState(
    Platform.OS === "android" ? "Android phone" : "Phone"
  )
  const [clipboardRelayLabel, setClipboardRelayLabel] = useState("")
  const [otpCode, setOtpCode] = useState("")
  const [otpLabel, setOtpLabel] = useState("")
  const [linkUrl, setLinkUrl] = useState("")
  const [linkTitle, setLinkTitle] = useState("")
  const [noteText, setNoteText] = useState("")
  const [noteTitle, setNoteTitle] = useState("")
  const [isRelayPending, setIsRelayPending] = useState(false)
  const [showScanner, setShowScanner] = useState(false)
  const [cameraPermission, requestCameraPermission] = useCameraPermissions()
  const [androidRelayState, setAndroidRelayState] = useState<AndroidRelayCapabilityState>(
    EMPTY_ANDROID_RELAY_CAPABILITY_STATE
  )
  const lastClipboardTextRef = useRef("")
  const isAutoClipboardSyncingRef = useRef(false)
  const appStateRef = useRef(AppState.currentState)
  const backendUrl = useMemo(() => getApiBaseUrl(), [])
  const androidRelayNativeAvailable = useMemo(
    () => isAndroidRelayNativeAvailable(),
    []
  )

  const mergeSession = useCallback(
    async (nextSession: AuthSession) => {
      setSession(nextSession)
      await saveStoredSession(nextSession)
    },
    []
  )

  const resetAuthedState = useCallback(async () => {
    setSession(null)
    setDashboard(null)
    setThreads([])
    setMessages([])
    setActiveThreadId(null)
    setPhoneDevices([])
    setPhoneRelayEvents([])
    setSelectedPairingId(null)
    setPairingCode("")
    setShowScanner(false)
    setTab("chat")
    await clearStoredSession()
  }, [])

  const handleAuthedError = useCallback(
    async (error: unknown) => {
      const message =
        error instanceof Error ? error.message : "Something went wrong."

      if (message.toLowerCase().includes("sign in") || message.toLowerCase().includes("authentication")) {
        await resetAuthedState()
      }

      setErrorMessage(message)
    },
    [resetAuthedState]
  )

  const refreshThreadsAndDashboard = useCallback(
    async (nextSession: AuthSession, preferredThreadId?: string | null) => {
      const [nextDashboard, nextThreads] = await Promise.all([
        getDashboard(nextSession.token),
        listThreads(nextSession.token),
      ])

      setDashboard(nextDashboard)
      const sortedThreads = nextThreads
        .filter((thread) => thread.mode === "general")
        .sort((a, b) => {
          const aValue = a.lastMessageAt || a.updatedAt || a.createdAt || ""
          const bValue = b.lastMessageAt || b.updatedAt || b.createdAt || ""
          return aValue < bValue ? 1 : -1
        })

      setThreads(sortedThreads)

      const nextThreadId =
        preferredThreadId && sortedThreads.some((thread) => thread.id === preferredThreadId)
          ? preferredThreadId
          : sortedThreads[0]?.id || null

      setActiveThreadId(nextThreadId)
    },
    []
  )

  const refreshPhoneRelay = useCallback(async () => {
    const devices = await loadStoredLocalRelayConnections()
    await syncAndroidRelayConnections(devices)
    setPhoneDevices(devices)
    setSelectedPairingId((current) => {
      if (current && devices.some((device) => device.id === current)) {
        return current
      }

      return devices[0]?.id || null
    })
  }, [])

  const refreshAndroidRelayState = useCallback(async () => {
    setAndroidRelayState(await getAndroidRelayCapabilityState())
  }, [])

  useEffect(() => {
    let cancelled = false

    const bootstrap = async () => {
      try {
        const storedSession = await loadStoredSession()
        if (!storedSession) {
          return
        }

        const nextSession = await getCurrentSession(storedSession.token)
        if (cancelled) {
          return
        }

        await mergeSession(nextSession)
        await Promise.all([
          refreshThreadsAndDashboard(nextSession),
          refreshPhoneRelay(),
      ])
      await refreshAndroidRelayState()
    } catch (error) {
        if (!cancelled) {
          await resetAuthedState()
        }
      } finally {
        if (!cancelled) {
          setIsBooting(false)
        }
      }
    }

    void bootstrap()

    return () => {
      cancelled = true
    }
  }, [
    mergeSession,
    refreshAndroidRelayState,
    refreshPhoneRelay,
    refreshThreadsAndDashboard,
    resetAuthedState,
  ])

  useEffect(() => {
    if (!session?.token || !activeThreadId) {
      setMessages([])
      return
    }

    let cancelled = false

    const loadThreadMessages = async () => {
      try {
        const nextMessages = await getMessages(session.token, activeThreadId)
        if (!cancelled) {
          setMessages(nextMessages)
        }
      } catch (error) {
        if (!cancelled) {
          await handleAuthedError(error)
        }
      }
    }

    void loadThreadMessages()

    return () => {
      cancelled = true
    }
  }, [activeThreadId, handleAuthedError, session?.token])

  useEffect(() => {
    if (tab !== "relay") {
      return
    }

    void refreshPhoneRelay()
    void refreshAndroidRelayState()
  }, [refreshAndroidRelayState, refreshPhoneRelay, tab])

  useEffect(() => {
    let cancelled = false

    const primeClipboard = async () => {
      try {
        const currentClipboardText = (await Clipboard.getStringAsync()).trim()
        if (!cancelled) {
          lastClipboardTextRef.current = currentClipboardText
        }
      } catch (_error) {
        // Ignore clipboard primer failures.
      }
    }

    void primeClipboard()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const selectedDevice =
      phoneDevices.find((device) => device.id === selectedPairingId) || phoneDevices[0] || null

    if (!selectedDevice) {
      return
    }

    let cancelled = false

    const relayClipboardToDesktop = async () => {
      if (
        cancelled ||
        isAutoClipboardSyncingRef.current ||
        appStateRef.current !== "active"
      ) {
        return
      }

      try {
        const clipboardText = (await Clipboard.getStringAsync()).trim()
        if (!clipboardText || clipboardText === lastClipboardTextRef.current) {
          return
        }

        isAutoClipboardSyncingRef.current = true

        const event = await sendLocalPhoneRelayEvent({
          apiBaseUrl: selectedDevice.apiBaseUrl,
          pairingId: selectedDevice.id,
          deviceToken: selectedDevice.deviceToken,
          eventType: "clipboard",
          payload: {
            text: clipboardText,
            label: "Auto sync",
          },
        })

        if (cancelled) {
          return
        }

        lastClipboardTextRef.current = clipboardText
        setPhoneRelayEvents((previousEvents) => [event, ...previousEvents].slice(0, 8))
      } catch (_error) {
        // Avoid noisy foreground errors for automatic clipboard relay.
      } finally {
        isAutoClipboardSyncingRef.current = false
      }
    }

    void relayClipboardToDesktop()

    const subscription = Clipboard.addClipboardListener(() => {
      void relayClipboardToDesktop()
    })

    const appStateSubscription = AppState.addEventListener("change", (nextState) => {
      appStateRef.current = nextState
      if (nextState === "active") {
        void relayClipboardToDesktop()
        void refreshAndroidRelayState()
      }
    })

    const intervalId = setInterval(() => {
      void relayClipboardToDesktop()
    }, 1200)

    return () => {
      cancelled = true
      subscription.remove()
      appStateSubscription.remove()
      clearInterval(intervalId)
    }
  }, [phoneDevices, refreshAndroidRelayState, selectedPairingId])

  const submitAuth = async () => {
    setErrorMessage("")

    if (!email.trim() || !password.trim() || (authMode === "register" && !name.trim())) {
      setErrorMessage("Enter the required fields first.")
      return
    }

    setIsAuthPending(true)
    try {
      const nextSession =
        authMode === "register"
          ? await register({
              name: name.trim(),
              email: email.trim(),
              password: password,
            })
          : await login({
              email: email.trim(),
              password: password,
            })

      await mergeSession(nextSession)
      await Promise.all([
        refreshThreadsAndDashboard(nextSession),
        refreshPhoneRelay(),
      ])
      setPassword("")
      setTab("chat")
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Authentication failed."
      )
    } finally {
      setIsAuthPending(false)
      setIsBooting(false)
    }
  }

  const handleSend = async () => {
    const trimmedMessage = chatInput.trim()
    if (!session?.token || !trimmedMessage || isChatPending) {
      return
    }

    setErrorMessage("")
    setIsChatPending(true)

    const optimisticUserId = `temp-user-${Date.now()}`
    const optimisticAssistantId = `temp-assistant-${Date.now()}`

    setMessages((previousMessages) => [
      ...previousMessages,
      {
        id: optimisticUserId,
        threadId: activeThreadId || "draft",
        userId: session.user.id,
        role: "user",
        content: trimmedMessage,
        createdAt: new Date().toISOString(),
      },
      {
        id: optimisticAssistantId,
        threadId: activeThreadId || "draft",
        userId: session.user.id,
        role: "assistant",
        content: "Thinking...",
        createdAt: new Date().toISOString(),
      },
    ])
    setChatInput("")

    try {
      const response = await sendMobileChat(session.token, {
        threadId: activeThreadId,
        message: trimmedMessage,
      })

      const nextSession: AuthSession = {
        ...session,
        usage: response.usage,
      }
      await mergeSession(nextSession)
      await refreshThreadsAndDashboard(nextSession, response.thread.id)

      setMessages((previousMessages) =>
        previousMessages.map((message) => {
          if (message.id === optimisticUserId) {
            return response.userMessage
          }
          if (message.id === optimisticAssistantId) {
            return response.assistantMessage
          }
          return message
        })
      )
    } catch (error) {
      setMessages((previousMessages) =>
        previousMessages.map((message) =>
          message.id === optimisticAssistantId
            ? { ...message, content: error instanceof Error ? error.message : "Failed to send." }
            : message
        )
      )
      await handleAuthedError(error)
    } finally {
      setIsChatPending(false)
    }
  }

  const handleOpenBilling = async (kind: "checkout" | "portal") => {
    if (!session?.token) {
      return
    }

    setIsAccountPending(true)
    setErrorMessage("")
    try {
      const response =
        kind === "checkout"
          ? await createCheckoutSession(session.token)
          : await createBillingPortalSession(session.token)

      await Linking.openURL(response.url)
    } catch (error) {
      await handleAuthedError(error)
    } finally {
      setIsAccountPending(false)
    }
  }

  const submitPairing = async (rawPayload: string) => {
    const parsedPayload = parsePhonePairingPayload(rawPayload)
    if (!parsedPayload) {
      setErrorMessage("That pairing code is not valid.")
      return
    }

    setIsRelayPending(true)
    setErrorMessage("")
    try {
      const pairedDevice = await completeLocalPhonePairing({
        apiBaseUrl: parsedPayload.apiBaseUrl,
        pairingId: parsedPayload.pairingId,
        pairingToken: parsedPayload.pairingToken,
        mobileDeviceName: mobileDeviceName.trim() || "Sylica Mobile",
      })

      const nextDevices = [
        pairedDevice,
        ...phoneDevices.filter((device) => device.id !== pairedDevice.id),
      ]
      await saveStoredLocalRelayConnections(nextDevices)
      await refreshPhoneRelay()
      await refreshAndroidRelayState()
      setSelectedPairingId(pairedDevice.id)
      setPairingCode("")
      setShowScanner(false)
      Alert.alert("Phone paired", "This phone can now relay signals into the desktop app.")
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to pair with the desktop."
      )
    } finally {
      setIsRelayPending(false)
    }
  }

  const handleBarcodeScanned = ({ data }: BarcodeScanningResult) => {
    if (isRelayPending) {
      return
    }

    void submitPairing(data)
  }

  const handleOpenScanner = async () => {
    setErrorMessage("")

    if (!cameraPermission?.granted) {
      const permission = await requestCameraPermission()
      if (!permission.granted) {
        setErrorMessage("Camera access is required to scan the pairing QR.")
        return
      }
    }

    setShowScanner(true)
  }

  const submitRelayEvent = async (input: {
    eventType: "clipboard" | "otp" | "link" | "note"
    payload: Record<string, unknown>
    successMessage: string
    reset: () => void
  }) => {
    if (!selectedPairingId) {
      setErrorMessage("Pair a desktop first.")
      return
    }

    const selectedDevice = phoneDevices.find((device) => device.id === selectedPairingId)
    if (!selectedDevice) {
      setErrorMessage("That desktop pairing is no longer available.")
      return
    }

    setIsRelayPending(true)
    setErrorMessage("")
    try {
      const event = await sendLocalPhoneRelayEvent({
        apiBaseUrl: selectedDevice.apiBaseUrl,
        pairingId: selectedDevice.id,
        deviceToken: selectedDevice.deviceToken,
        eventType: input.eventType,
        payload: input.payload,
      })
      input.reset()
      setPhoneRelayEvents((previousEvents) => [event, ...previousEvents].slice(0, 8))
      Alert.alert("Sent", input.successMessage)
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to send to the desktop."
      )
    } finally {
      setIsRelayPending(false)
    }
  }

  const handleRelayClipboard = async () => {
    const clipboardText = (await Clipboard.getStringAsync()).trim()
    if (!clipboardText) {
      setErrorMessage("Your clipboard is empty.")
      return
    }

    lastClipboardTextRef.current = clipboardText

    void submitRelayEvent({
      eventType: "clipboard",
      payload: { text: clipboardText, label: clipboardRelayLabel.trim() || null },
      successMessage: "Clipboard text was sent to your desktop.",
      reset: () => setClipboardRelayLabel(""),
    })
  }

  const handleRelayOtp = async () => {
    const trimmedCode = otpCode.trim()
    if (!trimmedCode) {
      setErrorMessage("Enter the OTP code first.")
      return
    }

    void submitRelayEvent({
      eventType: "otp",
      payload: { code: trimmedCode, label: otpLabel.trim() || null },
      successMessage: "OTP code sent to the desktop app.",
      reset: () => {
        setOtpCode("")
        setOtpLabel("")
      },
    })
  }

  const handleRelayLink = async () => {
    const trimmedUrl = linkUrl.trim()
    if (!trimmedUrl) {
      setErrorMessage("Paste the link first.")
      return
    }

    void submitRelayEvent({
      eventType: "link",
      payload: { url: trimmedUrl, title: linkTitle.trim() || null },
      successMessage: "Link sent to the desktop app.",
      reset: () => {
        setLinkUrl("")
        setLinkTitle("")
      },
    })
  }

  const handleRelayNote = async () => {
    const trimmedNote = noteText.trim()
    if (!trimmedNote) {
      setErrorMessage("Write the note first.")
      return
    }

    void submitRelayEvent({
      eventType: "note",
      payload: { text: trimmedNote, title: noteTitle.trim() || null },
      successMessage: "Note sent to the desktop app.",
      reset: () => {
        setNoteText("")
        setNoteTitle("")
      },
    })
  }

  const ensureAndroidRelayNative = useCallback(() => {
    if (androidRelayNativeAvailable) {
      return true
    }

    Alert.alert(
      "Android build required",
      "Notification access and the Sylica keyboard only work in the Android app build. They do not work inside Expo Go."
    )
    return false
  }, [androidRelayNativeAvailable])

  const activeThread = threads.find((thread) => thread.id === activeThreadId) || null
  const selectedPhoneDevice =
    phoneDevices.find((device) => device.id === selectedPairingId) || phoneDevices[0] || null

  if (isBooting) {
    return (
      <SafeAreaView style={styles.bootContainer}>
        <StatusBar style="dark" />
        <ActivityIndicator size="large" color={COLORS.accent} />
        <Text style={styles.bootText}>Loading Sylica AI Mobile…</Text>
      </SafeAreaView>
    )
  }

  if (!session) {
    return (
      <SafeAreaView style={styles.screen}>
        <StatusBar style="dark" />
        <KeyboardAvoidingView
          style={styles.authWrapper}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={styles.authBackdropOrbOne} />
          <View style={styles.authBackdropOrbTwo} />

          <View style={styles.authHero}>
            <View style={styles.authTopRow}>
              <View style={styles.logoWrap}>
                <Text style={styles.logoGlyph}>S</Text>
              </View>
              <View style={styles.authBadge}>
                <Text style={styles.authBadgeText}>MOBILE</Text>
              </View>
            </View>
            <Text style={styles.heroEyebrow}>SYLICA AI</Text>
            <Text style={styles.heroTitle}>Minimal mobile companion.</Text>
            <Text style={styles.heroBody}>
              Continue chat, manage billing, and keep your paired relay devices close in one clean app.
            </Text>
            <View style={styles.authFeatureRow}>
              <View style={styles.authFeatureChip}>
                <Text style={styles.authFeatureChipText}>Chat</Text>
              </View>
              <View style={styles.authFeatureChip}>
                <Text style={styles.authFeatureChipText}>Relay</Text>
              </View>
              <View style={styles.authFeatureChip}>
                <Text style={styles.authFeatureChipText}>Account</Text>
              </View>
            </View>
          </View>

          <View style={styles.authCard}>
            <View style={styles.authModeRow}>
              <Pressable
                onPress={() => setAuthMode("login")}
                style={[styles.authModeButton, authMode === "login" ? styles.authModeButtonActive : null]}
              >
                <Text style={[styles.authModeText, authMode === "login" ? styles.authModeTextActive : null]}>
                  Sign in
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setAuthMode("register")}
                style={[styles.authModeButton, authMode === "register" ? styles.authModeButtonActive : null]}
              >
                <Text style={[styles.authModeText, authMode === "register" ? styles.authModeTextActive : null]}>
                  Create account
                </Text>
              </Pressable>
            </View>

            {authMode === "register" && (
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="Full name"
                placeholderTextColor={COLORS.subtext}
                style={styles.input}
                autoCapitalize="words"
              />
            )}
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder="Email"
              placeholderTextColor={COLORS.subtext}
              style={styles.input}
              keyboardType="email-address"
              autoCapitalize="none"
            />
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder="Password"
              placeholderTextColor={COLORS.subtext}
              style={styles.input}
              secureTextEntry
            />

            {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}

            <AuthButton
              label={isAuthPending ? "Please wait…" : authMode === "login" ? "Sign in" : "Create account"}
              onPress={() => {
                void submitAuth()
              }}
              disabled={isAuthPending}
            />

            <Text style={styles.backendHint}>Backend: {backendUrl}</Text>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="dark" />
      <View style={styles.appBackdropOrbOne} />
      <View style={styles.appBackdropOrbTwo} />

      <View style={styles.appHeader}>
        <View style={styles.appHeaderText}>
          <Text style={styles.heroEyebrow}>SYLICA AI MOBILE</Text>
          <Text style={styles.headerTitle}>
            {tab === "chat" ? "Chat" : tab === "relay" ? "Relay" : "Account"}
          </Text>
          <Text style={styles.headerSubtitle}>
            {tab === "chat"
              ? activeThread?.title || "Continue your mobile conversation"
              : tab === "relay"
              ? selectedPhoneDevice
                ? `Connected to ${selectedPhoneDevice.desktopDeviceName}`
                : "Pair this phone to the desktop relay"
              : dashboard?.billing.statusMessage || "Manage plan and activity"}
          </Text>
        </View>
        <Pressable
          onPress={() => {
            void resetAuthedState()
          }}
          style={styles.logoutButton}
        >
          <Text style={styles.logoutText}>Log out</Text>
        </Pressable>
      </View>

      {errorMessage ? <Text style={styles.errorBanner}>{errorMessage}</Text> : null}

      {tab === "chat" ? (
        <View style={styles.pageShell}>
          <View style={styles.tileGrid}>
            <StatTile
              label="Plan"
              value={(dashboard?.user.subscriptionPlan || session.user.subscriptionPlan).toUpperCase()}
              tone="dark"
            />
            <StatTile
              label="Requests today"
              value={dashboard?.usage.requestsToday ?? session.usage.requestsToday}
            />
          </View>

          <View style={styles.inlineRow}>
            <Text style={styles.sectionTitle}>Threads</Text>
            <AuthButton
              label="New"
              variant="secondary"
              onPress={() => {
                setActiveThreadId(null)
                setMessages([])
              }}
            />
          </View>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.threadRail}
          >
            {threads.map((thread) => (
              <Pressable
                key={thread.id}
                onPress={() => setActiveThreadId(thread.id)}
                style={[styles.threadChip, thread.id === activeThreadId ? styles.threadChipActive : null]}
              >
                <Text
                  numberOfLines={1}
                  style={[styles.threadChipTitle, thread.id === activeThreadId ? styles.threadChipTitleActive : null]}
                >
                  {thread.title}
                </Text>
                <Text
                  numberOfLines={1}
                  style={[styles.threadChipMeta, thread.id === activeThreadId ? styles.threadChipMetaActive : null]}
                >
                  {thread.preview || "No messages yet"}
                </Text>
              </Pressable>
            ))}
          </ScrollView>

          <SectionCard
            eyebrow="Conversation"
            title={activeThread ? "Current thread" : "New chat"}
            subtitle="Fast mobile replies from the same Sylica backend."
            compact
          >
            <ScrollView
              style={styles.messagesCard}
              contentContainerStyle={styles.messagesList}
              showsVerticalScrollIndicator={false}
            >
              {messages.length === 0 ? (
                <View style={styles.emptyState}>
                  <Text style={styles.emptyTitle}>
                    {activeThread ? "No messages in this thread yet." : "Start a new mobile chat."}
                  </Text>
                  <Text style={styles.emptyBody}>
                    Keep the conversation going without opening the desktop widget.
                  </Text>
                </View>
              ) : (
                messages.map((message) => (
                  <View
                    key={message.id}
                    style={[
                      styles.messageBubble,
                      message.role === "user" ? styles.userBubble : styles.assistantBubble,
                    ]}
                  >
                    <Text style={styles.messageMeta}>{message.role === "user" ? "You" : "Sylica AI"}</Text>
                    <Text style={styles.messageText}>{message.content}</Text>
                    <Text style={styles.messageTime}>{formatDateLabel(message.createdAt)}</Text>
                  </View>
                ))
              )}
            </ScrollView>
          </SectionCard>

          <View style={styles.composerDock}>
            <TextInput
              value={chatInput}
              onChangeText={setChatInput}
              placeholder="Ask Sylica on mobile…"
              placeholderTextColor={COLORS.subtext}
              style={styles.composerInput}
              multiline
            />
            <AuthButton
              label={isChatPending ? "Sending…" : "Send"}
              onPress={() => {
                void handleSend()
              }}
              disabled={isChatPending || chatInput.trim().length === 0}
            />
          </View>
        </View>
      ) : tab === "relay" ? (
        <ScrollView style={styles.pageShell} contentContainerStyle={styles.pageScrollContent}>
          <View style={styles.tileGrid}>
            <StatTile label="Paired" value={phoneDevices.length} tone="mint" />
            <StatTile
              label="Relay events"
              value={phoneRelayEvents.length}
            />
          </View>

          <SectionCard
            eyebrow="Pairing"
            title="Pair this phone"
            subtitle="Scan the desktop QR or paste the fallback pairing code."
          >
            <TextInput
              value={mobileDeviceName}
              onChangeText={setMobileDeviceName}
              placeholder="Device name"
              placeholderTextColor={COLORS.subtext}
              style={styles.input}
            />

            {showScanner ? (
              <View style={styles.scannerCard}>
                <CameraView
                  style={styles.scannerView}
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  onBarcodeScanned={handleBarcodeScanned}
                />
                <AuthButton
                  label="Close scanner"
                  variant="secondary"
                  onPress={() => setShowScanner(false)}
                />
              </View>
            ) : (
              <View style={styles.splitButtonRow}>
                <AuthButton
                  label="Scan QR"
                  onPress={() => {
                    void handleOpenScanner()
                  }}
                  disabled={isRelayPending}
                />
              </View>
            )}

            <TextInput
              value={pairingCode}
              onChangeText={setPairingCode}
              placeholder="Paste pairing code"
              placeholderTextColor={COLORS.subtext}
              style={styles.input}
              autoCapitalize="none"
            />

            <AuthButton
              label={isRelayPending ? "Pairing…" : "Pair with code"}
              variant="secondary"
              onPress={() => {
                void submitPairing(pairingCode)
              }}
              disabled={isRelayPending || pairingCode.trim().length === 0}
            />
          </SectionCard>

          <SectionCard
            eyebrow="Devices"
            title="Connected desktops"
            subtitle={selectedPhoneDevice ? "Choose where relay events should land." : "No paired desktop yet."}
          >
            <View style={styles.cardList}>
              {phoneDevices.length === 0 ? (
                <Text style={styles.accountHint}>No paired desktop yet.</Text>
              ) : (
                phoneDevices.map((device) => (
                  <Pressable
                    key={device.id}
                    onPress={() => setSelectedPairingId(device.id)}
                    style={[
                      styles.deviceRow,
                      device.id === selectedPairingId ? styles.deviceRowActive : null,
                    ]}
                  >
                    <View style={styles.deviceRowBody}>
                      <Text style={styles.deviceRowTitle}>{device.desktopDeviceName}</Text>
                      <Text style={styles.deviceRowMeta}>
                        {device.mobileDeviceName || "This phone"} • {formatDateLabel(device.lastSeenAt)}
                      </Text>
                    </View>
                    <Text style={styles.deviceStatus}>{device.status}</Text>
                  </Pressable>
                ))
              )}
            </View>
          </SectionCard>

          <SectionCard
            eyebrow="Automation"
            title="Background relay"
            subtitle="Notifications and OTPs can run in the background. Clipboard is broader when the Sylica keyboard is active."
          >
            <View style={styles.statusStack}>
              <View style={styles.statusTile}>
                <View style={styles.statusTileBody}>
                  <Text style={styles.statusTileTitle}>Notification listener</Text>
                  <Text style={styles.statusTileText}>
                    {androidRelayState.notificationAccessEnabled
                      ? "Enabled"
                      : "Grant access for automatic notification and OTP relay."}
                  </Text>
                </View>
                <AuthButton
                  label={androidRelayState.notificationAccessEnabled ? "Open" : "Enable"}
                  variant="secondary"
                  onPress={() => {
                    if (!ensureAndroidRelayNative()) {
                      return
                    }
                    void openNotificationRelaySettings()
                  }}
                />
              </View>

              <View style={styles.statusTile}>
                <View style={styles.statusTileBody}>
                  <Text style={styles.statusTileTitle}>Sylica keyboard</Text>
                  <Text style={styles.statusTileText}>
                    {androidRelayState.imeSelected
                      ? "Active now. Clipboard can sync while the keyboard is in use."
                      : androidRelayState.imeEnabled
                      ? "Enabled. Switch to Sylica when you need broader clipboard relay."
                      : "Enable the keyboard to relay clipboard while typing in other apps."}
                  </Text>
                </View>
                <AuthButton
                  label={androidRelayState.imeEnabled ? "Keyboard list" : "Enable"}
                  variant="secondary"
                  onPress={() => {
                    if (!ensureAndroidRelayNative()) {
                      return
                    }
                    void openInputMethodRelaySettings()
                  }}
                />
              </View>
            </View>

            {androidRelayState.imeEnabled ? (
              <AuthButton
                label="Switch to Sylica keyboard"
                variant="secondary"
                onPress={() => {
                  if (!ensureAndroidRelayNative()) {
                    return
                  }
                  void showRelayInputMethodPicker()
                }}
              />
            ) : null}

            {!androidRelayNativeAvailable ? (
              <Text style={styles.accountHint}>
                Native Android relay features work only in the Android build, not Expo Go.
              </Text>
            ) : null}
          </SectionCard>

          <SectionCard
            eyebrow="Quick relay"
            title="Send something now"
            subtitle="Use quick tiles for clipboard, OTPs, links, and notes."
          >
            <View style={styles.relayTileGrid}>
              <View style={styles.relayTile}>
                <Text style={styles.relayTileTitle}>Clipboard</Text>
                <TextInput
                  value={clipboardRelayLabel}
                  onChangeText={setClipboardRelayLabel}
                  placeholder="Optional label"
                  placeholderTextColor={COLORS.subtext}
                  style={styles.compactInput}
                />
                <AuthButton
                  label={isRelayPending ? "Sending…" : "Resend current clipboard"}
                  onPress={() => {
                    void handleRelayClipboard()
                  }}
                  disabled={isRelayPending || !selectedPairingId}
                />
              </View>

              <View style={styles.relayTile}>
                <Text style={styles.relayTileTitle}>OTP</Text>
                <TextInput
                  value={otpCode}
                  onChangeText={setOtpCode}
                  placeholder="OTP code"
                  placeholderTextColor={COLORS.subtext}
                  style={styles.compactInput}
                />
                <TextInput
                  value={otpLabel}
                  onChangeText={setOtpLabel}
                  placeholder="Optional label"
                  placeholderTextColor={COLORS.subtext}
                  style={styles.compactInput}
                />
                <AuthButton
                  label="Send OTP"
                  variant="secondary"
                  onPress={() => {
                    void handleRelayOtp()
                  }}
                  disabled={isRelayPending || !selectedPairingId}
                />
              </View>

              <View style={styles.relayTile}>
                <Text style={styles.relayTileTitle}>Link</Text>
                <TextInput
                  value={linkUrl}
                  onChangeText={setLinkUrl}
                  placeholder="https://example.com"
                  placeholderTextColor={COLORS.subtext}
                  style={styles.compactInput}
                  autoCapitalize="none"
                />
                <TextInput
                  value={linkTitle}
                  onChangeText={setLinkTitle}
                  placeholder="Optional title"
                  placeholderTextColor={COLORS.subtext}
                  style={styles.compactInput}
                />
                <AuthButton
                  label="Send link"
                  variant="secondary"
                  onPress={() => {
                    void handleRelayLink()
                  }}
                  disabled={isRelayPending || !selectedPairingId}
                />
              </View>

              <View style={styles.relayTile}>
                <Text style={styles.relayTileTitle}>Note</Text>
                <TextInput
                  value={noteTitle}
                  onChangeText={setNoteTitle}
                  placeholder="Optional title"
                  placeholderTextColor={COLORS.subtext}
                  style={styles.compactInput}
                />
                <TextInput
                  value={noteText}
                  onChangeText={setNoteText}
                  placeholder="Write the note"
                  placeholderTextColor={COLORS.subtext}
                  style={[styles.compactInput, styles.noteInput]}
                  multiline
                />
                <AuthButton
                  label="Send note"
                  variant="secondary"
                  onPress={() => {
                    void handleRelayNote()
                  }}
                  disabled={isRelayPending || !selectedPairingId}
                />
              </View>
            </View>
          </SectionCard>

          <SectionCard
            eyebrow="Feed"
            title="Recent relay events"
            subtitle="Latest items sent from this phone to the desktop."
            compact
          >
            <View style={styles.cardList}>
              {phoneRelayEvents.length === 0 ? (
                <Text style={styles.accountHint}>Nothing relayed yet.</Text>
              ) : (
                phoneRelayEvents.slice(0, 8).map((event) => (
                  <View key={event.id} style={styles.eventTile}>
                    <View style={styles.eventTileHeader}>
                      <Text style={styles.eventAction}>{event.eventType.toUpperCase()}</Text>
                      <Text style={styles.eventTime}>{formatDateLabel(event.createdAt)}</Text>
                    </View>
                    <Text style={styles.eventPreview}>{relayEventPreview(event)}</Text>
                  </View>
                ))
              )}
            </View>
          </SectionCard>
        </ScrollView>
      ) : (
        <ScrollView style={styles.pageShell} contentContainerStyle={styles.pageScrollContent}>
          <SectionCard
            eyebrow="Subscription"
            title={(dashboard?.user.subscriptionPlan || session.user.subscriptionPlan).toUpperCase()}
            subtitle={dashboard?.billing.statusMessage || "Billing status is loading."}
          >
            <View style={styles.tileGrid}>
              <StatTile
                label="Requests today"
                value={dashboard?.usage.requestsToday ?? session.usage.requestsToday}
              />
              <StatTile
                label="Hourly left"
                value={dashboard?.usage.remainingRequestsThisHour ?? session.usage.remainingRequestsThisHour}
                tone="mint"
              />
              <StatTile
                label="Solves left"
                value={dashboard?.usage.remainingSolveDaily ?? session.usage.remainingSolveDaily}
              />
              <StatTile
                label="Last usage"
                value={formatDateLabel(dashboard?.usage.lastUsageAt ?? session.usage.lastUsageAt)}
              />
            </View>
          </SectionCard>

          <SectionCard
            eyebrow="Billing"
            title="Plan actions"
            subtitle="Open checkout or billing management when available."
          >
            <View style={styles.splitButtonRow}>
              {dashboard?.billing.checkoutEnabled ? (
                <AuthButton
                  label={isAccountPending ? "Opening…" : "Upgrade"}
                  onPress={() => {
                    void handleOpenBilling("checkout")
                  }}
                  disabled={isAccountPending}
                />
              ) : null}
              {dashboard?.billing.canManageBilling ? (
                <AuthButton
                  label={isAccountPending ? "Opening…" : "Manage Plan"}
                  variant="secondary"
                  onPress={() => {
                    void handleOpenBilling("portal")
                  }}
                  disabled={isAccountPending}
                />
              ) : null}
            </View>
          </SectionCard>

          <SectionCard
            eyebrow="Activity"
            title="Recent account events"
            subtitle="Latest usage and billing-related actions."
            compact
          >
            <View style={styles.cardList}>
              {(dashboard?.recentEvents || []).slice(0, 6).map((event) => (
                <View key={event.id} style={styles.eventTile}>
                  <View style={styles.eventTileHeader}>
                    <Text style={styles.eventAction}>{event.action}</Text>
                    <Text style={styles.eventTime}>{formatDateLabel(event.createdAt)}</Text>
                  </View>
                  <Text style={styles.eventPreview}>{event.reason || "Account activity"}</Text>
                </View>
              ))}
              {!dashboard?.recentEvents?.length ? (
                <Text style={styles.accountHint}>No recent events yet.</Text>
              ) : null}
            </View>
          </SectionCard>
        </ScrollView>
      )}

      <View style={styles.bottomDock}>
        <BottomTabButton
          active={tab === "chat"}
          label="Chat"
          glyph="◌"
          onPress={() => setTab("chat")}
        />
        <BottomTabButton
          active={tab === "relay"}
          label="Relay"
          glyph="≈"
          onPress={() => setTab("relay")}
        />
        <BottomTabButton
          active={tab === "account"}
          label="Account"
          glyph="◔"
          onPress={() => setTab("account")}
        />
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  bootContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    backgroundColor: COLORS.bg,
  },
  bootText: {
    color: COLORS.text,
    fontSize: 15,
  },
  authWrapper: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 20,
    paddingVertical: 24,
    gap: 16,
  },
  authBackdropOrbOne: {
    position: "absolute",
    top: 16,
    right: -20,
    width: 180,
    height: 180,
    borderRadius: 999,
    backgroundColor: "rgba(110,168,217,0.18)",
  },
  authBackdropOrbTwo: {
    position: "absolute",
    left: -40,
    bottom: 80,
    width: 200,
    height: 200,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.45)",
  },
  authHero: {
    borderRadius: 32,
    backgroundColor: COLORS.hero,
    padding: 22,
    gap: 12,
    overflow: "hidden",
  },
  authTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  logoWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#ffffff",
    alignItems: "center",
    justifyContent: "center",
  },
  logoGlyph: {
    fontSize: 28,
    fontWeight: "700",
    color: "#4f46ff",
  },
  heroEyebrow: {
    color: "rgba(255,255,255,0.78)",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1.4,
  },
  heroTitle: {
    color: "#ffffff",
    fontSize: 32,
    lineHeight: 36,
    fontWeight: "600",
  },
  heroBody: {
    color: "rgba(255,255,255,0.92)",
    fontSize: 15,
    lineHeight: 22,
  },
  authBadge: {
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.16)",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  authBadgeText: {
    color: "#ffffff",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
  },
  authFeatureRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingTop: 4,
  },
  authFeatureChip: {
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.16)",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  authFeatureChipText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "600",
  },
  authCard: {
    borderRadius: 28,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 18,
    gap: 12,
  },
  authModeRow: {
    flexDirection: "row",
    backgroundColor: "rgba(16,35,52,0.06)",
    borderRadius: 16,
    padding: 4,
  },
  authModeButton: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    paddingVertical: 10,
  },
  authModeButtonActive: {
    backgroundColor: "#ffffff",
  },
  authModeText: {
    color: COLORS.subtext,
    fontSize: 14,
    fontWeight: "600",
  },
  authModeTextActive: {
    color: COLORS.text,
  },
  input: {
    borderRadius: 16,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 14,
    paddingVertical: 13,
    color: COLORS.text,
    fontSize: 15,
  },
  errorText: {
    color: "#b42318",
    fontSize: 13,
    lineHeight: 18,
  },
  backendHint: {
    color: COLORS.subtext,
    fontSize: 12,
  },
  button: {
    minHeight: 46,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  primaryButton: {
    backgroundColor: COLORS.accent,
  },
  secondaryButton: {
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    fontSize: 15,
    fontWeight: "700",
  },
  primaryButtonText: {
    color: "#ffffff",
  },
  secondaryButtonText: {
    color: COLORS.text,
  },
  appHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 8,
    gap: 12,
  },
  appHeaderText: {
    flex: 1,
    gap: 4,
  },
  headerTitle: {
    color: COLORS.text,
    fontSize: 26,
    fontWeight: "700",
    lineHeight: 30,
  },
  headerSubtitle: {
    color: COLORS.subtext,
    fontSize: 13,
    lineHeight: 18,
  },
  logoutButton: {
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.86)",
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  logoutText: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: "700",
  },
  errorBanner: {
    marginHorizontal: 20,
    marginBottom: 6,
    color: "#b42318",
    fontSize: 13,
  },
  pageShell: {
    flex: 1,
    paddingHorizontal: 20,
  },
  pageScrollContent: {
    gap: 10,
    paddingBottom: 126,
  },
  appBackdropOrbOne: {
    position: "absolute",
    top: 70,
    right: -32,
    width: 180,
    height: 180,
    borderRadius: 999,
    backgroundColor: "rgba(110,168,217,0.16)",
  },
  appBackdropOrbTwo: {
    position: "absolute",
    left: -40,
    bottom: 80,
    width: 220,
    height: 220,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.5)",
  },
  tileGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 8,
  },
  statTile: {
    flexBasis: "47%",
    flexGrow: 1,
    minHeight: 70,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.68)",
    borderWidth: 1,
    borderColor: "rgba(16,35,52,0.08)",
    paddingHorizontal: 14,
    paddingVertical: 12,
    justifyContent: "center",
    gap: 4,
  },
  statTileMint: {
    backgroundColor: "rgba(212, 244, 232, 0.72)",
    borderColor: "rgba(22,74,58,0.08)",
  },
  statTileDark: {
    backgroundColor: COLORS.accent,
    borderColor: "rgba(0,0,0,0.12)",
  },
  statTileLabel: {
    color: COLORS.subtext,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  statTileLabelDark: {
    color: "rgba(255,255,255,0.62)",
  },
  statTileValue: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: "800",
    lineHeight: 22,
  },
  statTileValueDark: {
    color: "#ffffff",
  },
  inlineRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 6,
  },
  sectionCard: {
    paddingVertical: 6,
    gap: 8,
    marginBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(16,35,52,0.08)",
  },
  sectionCardCompact: {
    paddingBottom: 6,
  },
  sectionHeader: {
    gap: 4,
  },
  sectionHeaderText: {
    gap: 4,
  },
  sectionTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
  },
  sectionEyebrow: {
    color: COLORS.subtext,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.9,
    textTransform: "uppercase",
  },
  sectionCardTitle: {
    color: COLORS.text,
    fontSize: 17,
    fontWeight: "700",
    lineHeight: 20,
  },
  sectionCardSubtitle: {
    color: COLORS.subtext,
    fontSize: 12,
    lineHeight: 17,
  },
  sectionCardBody: {
    gap: 8,
    paddingTop: 2,
  },
  sectionTitle: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: "700",
  },
  threadRail: {
    gap: 8,
    paddingBottom: 10,
  },
  threadChip: {
    width: 148,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.62)",
    borderWidth: 1,
    borderColor: "rgba(16,35,52,0.08)",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 3,
  },
  threadChipActive: {
    backgroundColor: COLORS.cardStrong,
    borderColor: "rgba(19,19,19,0.12)",
  },
  threadChipTitle: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: "700",
  },
  threadChipTitleActive: {
    color: COLORS.text,
  },
  threadChipMeta: {
    color: COLORS.subtext,
    fontSize: 11,
  },
  threadChipMetaActive: {
    color: COLORS.subtext,
  },
  messagesCard: {
    maxHeight: 360,
    minHeight: 220,
  },
  messagesList: {
    gap: 8,
    paddingBottom: 4,
  },
  emptyState: {
    paddingVertical: 20,
    gap: 8,
  },
  emptyTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: "700",
  },
  emptyBody: {
    color: COLORS.subtext,
    fontSize: 14,
    lineHeight: 20,
  },
  messageBubble: {
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  userBubble: {
    alignSelf: "flex-end",
    backgroundColor: COLORS.mint,
    maxWidth: "86%",
  },
  assistantBubble: {
    alignSelf: "flex-start",
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: COLORS.border,
    maxWidth: "94%",
  },
  messageMeta: {
    color: COLORS.subtext,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  messageText: {
    color: COLORS.text,
    fontSize: 14,
    lineHeight: 20,
  },
  messageTime: {
    color: COLORS.subtext,
    fontSize: 11,
  },
  composerDock: {
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: "rgba(16,35,52,0.08)",
    padding: 10,
    gap: 8,
    marginBottom: 112,
  },
  composerInput: {
    minHeight: 44,
    maxHeight: 96,
    color: COLORS.text,
    fontSize: 14,
    textAlignVertical: "top",
  },
  cardList: {
    gap: 8,
  },
  accountHint: {
    color: COLORS.subtext,
    fontSize: 14,
    lineHeight: 20,
  },
  splitButtonRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  scannerCard: {
    borderRadius: 18,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(16,35,52,0.08)",
    backgroundColor: "rgba(255,255,255,0.72)",
    gap: 8,
    padding: 8,
  },
  scannerView: {
    height: 260,
    borderRadius: 18,
    overflow: "hidden",
  },
  deviceRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.64)",
    borderWidth: 1,
    borderColor: "rgba(16,35,52,0.08)",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  deviceRowActive: {
    borderColor: "rgba(22,74,58,0.16)",
    backgroundColor: COLORS.mint,
  },
  deviceRowBody: {
    flex: 1,
    gap: 2,
  },
  deviceRowTitle: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: "700",
  },
  deviceRowMeta: {
    color: COLORS.subtext,
    fontSize: 11,
    lineHeight: 15,
  },
  deviceStatus: {
    color: COLORS.mintText,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  statusStack: {
    gap: 8,
  },
  statusTile: {
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: "rgba(16,35,52,0.08)",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
  },
  statusTileBody: {
    gap: 4,
  },
  statusTileTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: "700",
  },
  statusTileText: {
    color: COLORS.subtext,
    fontSize: 12,
    lineHeight: 17,
  },
  relayTileGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  relayTile: {
    width: "48%",
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: "rgba(16,35,52,0.08)",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  relayTileTitle: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: "700",
  },
  compactInput: {
    borderRadius: 14,
    backgroundColor: "rgba(16,35,52,0.05)",
    borderWidth: 1,
    borderColor: "rgba(16,35,52,0.08)",
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: COLORS.text,
    fontSize: 13,
  },
  noteInput: {
    minHeight: 88,
    textAlignVertical: "top",
  },
  eventTile: {
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.56)",
    borderWidth: 1,
    borderColor: "rgba(16,35,52,0.08)",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 6,
  },
  eventTileHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  eventAction: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: "700",
  },
  eventTime: {
    color: COLORS.subtext,
    fontSize: 11,
  },
  eventPreview: {
    color: COLORS.subtext,
    fontSize: 12,
    lineHeight: 16,
  },
  bottomDock: {
    position: "absolute",
    left: 18,
    right: 18,
    bottom: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    borderRadius: 28,
    backgroundColor: "rgba(255,255,255,0.94)",
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 10,
    shadowColor: "#6ea8d9",
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.14,
    shadowRadius: 24,
    elevation: 10,
  },
  bottomTabButton: {
    flex: 1,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 10,
  },
  bottomTabButtonActive: {
    backgroundColor: COLORS.accent,
  },
  bottomTabGlyph: {
    color: COLORS.subtext,
    fontSize: 17,
    fontWeight: "700",
  },
  bottomTabGlyphActive: {
    color: "#ffffff",
  },
  bottomTabLabel: {
    color: COLORS.subtext,
    fontSize: 12,
    fontWeight: "700",
  },
  bottomTabLabelActive: {
    color: "#ffffff",
  },
})
