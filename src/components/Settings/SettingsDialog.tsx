import { useEffect, useRef, useState } from "react"
import { Eye, EyeOff, Power } from "lucide-react"
import { Button } from "../ui/button"
import { useToast } from "../../contexts/toast"
import { updateWindowToElement } from "../../utils/contentSize"
import { COMMAND_KEY } from "../../utils/platform"
import { CheatbitMark } from "../Brand/CheatbitMark"
import {
  type ApiProvider,
  type AppConfig,
  DEFAULT_MODELS,
  DEFAULT_PROVIDER,
  MODEL_CATEGORIES,
  MODEL_OPTIONS,
  PROVIDER_CARD_DESCRIPTIONS,
  PROVIDER_CARD_TITLES,
  PROVIDER_KEY_LABELS,
  PROVIDER_KEY_PLACEHOLDERS,
  PROVIDER_ORDER,
} from "../../../shared/aiConfig"

const LANGUAGE_OPTIONS = [
  { value: "python", label: "Python" },
  { value: "javascript", label: "JavaScript" },
  { value: "java", label: "Java" },
  { value: "golang", label: "Go" },
  { value: "cpp", label: "C++" },
  { value: "swift", label: "Swift" },
  { value: "kotlin", label: "Kotlin" },
  { value: "ruby", label: "Ruby" },
  { value: "sql", label: "SQL" },
  { value: "r", label: "R" },
  { value: "csharp", label: "C#" },
] as const

const SHORTCUT_ROWS = [
  { label: "Toggle window", keys: `${COMMAND_KEY} + B` },
  { label: "Take screenshot", keys: `${COMMAND_KEY} + H` },
  { label: "Solve screenshots", keys: `${COMMAND_KEY} + Enter` },
  { label: "Delete last screenshot", keys: `${COMMAND_KEY} + L` },
  { label: "Start over", keys: `${COMMAND_KEY} + R` },
  { label: "Move window", keys: `${COMMAND_KEY} + Arrow keys` },
  { label: "Decrease opacity", keys: `${COMMAND_KEY} + [` },
  { label: "Increase opacity", keys: `${COMMAND_KEY} + ]` },
  { label: "Zoom out", keys: `${COMMAND_KEY} + -` },
  { label: "Reset zoom", keys: `${COMMAND_KEY} + 0` },
  { label: "Zoom in", keys: `${COMMAND_KEY} + =` },
  { label: "Quit app", keys: `${COMMAND_KEY} + Q` },
]

interface SettingsDialogProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function SettingsDialog({
  open = false,
  onOpenChange,
}: SettingsDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [apiProvider, setApiProvider] = useState<ApiProvider>(DEFAULT_PROVIDER)
  const [extractionModel, setExtractionModel] = useState(
    DEFAULT_MODELS[DEFAULT_PROVIDER].extractionModel
  )
  const [solutionModel, setSolutionModel] = useState(
    DEFAULT_MODELS[DEFAULT_PROVIDER].solutionModel
  )
  const [debuggingModel, setDebuggingModel] = useState(
    DEFAULT_MODELS[DEFAULT_PROVIDER].debuggingModel
  )
  const [language, setLanguage] = useState("python")
  const [apiKey, setApiKey] = useState("")
  const [configuredApiProviders, setConfiguredApiProviders] = useState<
    ApiProvider[]
  >([])
  const [isLoading, setIsLoading] = useState(false)
  const [isScreenRecordingVisible, setIsScreenRecordingVisible] = useState(false)
  const [isTogglingVisibility, setIsTogglingVisibility] = useState(false)
  const { showToast } = useToast()

  useEffect(() => {
    if (!open) return

    setIsLoading(true)
    window.electronAPI
      .getConfig()
      .then((config: Partial<AppConfig>) => {
        const provider = config.apiProvider || DEFAULT_PROVIDER
        setApiProvider(provider)
        setExtractionModel(
          config.extractionModel || DEFAULT_MODELS[provider].extractionModel
        )
        setSolutionModel(
          config.solutionModel || DEFAULT_MODELS[provider].solutionModel
        )
        setDebuggingModel(
          config.debuggingModel || DEFAULT_MODELS[provider].debuggingModel
        )
        setLanguage(config.language || "python")
        setApiKey("")
        setConfiguredApiProviders(config.configuredApiProviders || [])
        setIsScreenRecordingVisible(Boolean(config.screenRecordingVisible))
      })
      .catch((error: unknown) => {
        console.error("Failed to load config:", error)
        showToast("Error", "Failed to load settings", "error")
      })
      .finally(() => {
        setIsLoading(false)
      })
  }, [open, showToast])

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
  }, [
    open,
    isLoading,
    apiProvider,
    extractionModel,
    solutionModel,
    debuggingModel,
    language,
    apiKey,
  ])

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

      onOpenChange?.(false)
    }

    document.addEventListener("pointerdown", handlePointerDown)
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown)
    }
  }, [open, onOpenChange])

  const handleProviderChange = (provider: ApiProvider) => {
    setApiProvider(provider)
    const providerDefaults = DEFAULT_MODELS[provider]
    setExtractionModel(providerDefaults.extractionModel)
    setSolutionModel(providerDefaults.solutionModel)
    setDebuggingModel(providerDefaults.debuggingModel)
    setApiKey("")
  }

  const handleSave = async () => {
    setIsLoading(true)

    try {
      const result = await window.electronAPI.updateConfig({
        apiKey: apiKey.trim() || undefined,
        apiProvider,
        extractionModel,
        solutionModel,
        debuggingModel,
        language,
      })

      if (result) {
        setApiKey("")
        setConfiguredApiProviders(result.configuredApiProviders || [])
        showToast("Success", "Settings saved successfully", "success")
        onOpenChange?.(false)

        window.setTimeout(() => {
          window.location.reload()
        }, 1200)
      }
    } catch (error) {
      console.error("Failed to save settings:", error)
      showToast("Error", "Failed to save settings", "error")
    } finally {
      setIsLoading(false)
    }
  }

  const handleLogout = async () => {
    try {
      await window.electronAPI.logout()
      showToast("Success", "Logged out successfully", "success")
      onOpenChange?.(false)
      window.setTimeout(() => {
        window.location.reload()
      }, 200)
    } catch (error) {
      console.error("Failed to log out:", error)
      showToast("Error", "Failed to log out", "error")
    }
  }

  const handleQuitApp = async () => {
    try {
      const result = await window.electronAPI.quitApp()
      if (!result.success) {
        showToast("Error", result.error || "Failed to quit app", "error")
      }
    } catch (error) {
      console.error("Failed to quit app:", error)
      showToast("Error", "Failed to quit app", "error")
    }
  }

  const handleToggleScreenRecordingVisibility = async () => {
    if (isTogglingVisibility) return
    const next = !isScreenRecordingVisible
    setIsTogglingVisibility(true)
    try {
      const updated = await window.electronAPI.updateConfig({
        screenRecordingVisible: next,
      })
      const applied = Boolean(updated?.screenRecordingVisible ?? next)
      setIsScreenRecordingVisible(applied)
      showToast(
        applied ? "Demo Mode" : "Stealth Mode",
        applied
          ? "Sylica is now visible in screen recordings."
          : "Sylica is hidden from screen recordings.",
        applied ? "neutral" : "success"
      )
    } catch (error) {
      console.error("Failed to toggle screen recording visibility:", error)
      showToast("Visibility", "Couldn't update visibility. Please try again.", "error")
    } finally {
      setIsTogglingVisibility(false)
    }
  }

  if (!open) {
    return null
  }

  return (
    <div
      ref={panelRef}
      className="sylica-sheet-enter mt-3 flex-none overflow-hidden rounded-[28px] border border-white/10 bg-[#050505] text-white shadow-[0_30px_100px_rgba(0,0,0,0.56)] min-w-[60rem] max-w-[60rem]"
    >
      <div className="max-h-[38rem] space-y-4 overflow-y-auto bg-[radial-gradient(circle_at_top_left,_rgba(125,249,199,0.15),_transparent_30%),linear-gradient(180deg,_rgba(255,255,255,0.04),_rgba(255,255,255,0.01))] p-4 sm:p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <CheatbitMark className="h-11 w-11 rounded-[18px]" />
            <div className="space-y-1">
              <h2 className="text-[22px] font-semibold tracking-[-0.04em] text-white">
                Settings
              </h2>
              <p className="text-[13px] leading-5 text-white/62">
                Shortcuts and models in one place.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange?.(false)}
              className="border-white/10 text-white hover:bg-white/5"
            >
              Close
            </Button>
            <Button
              className="rounded-xl bg-white px-4 py-2 text-black hover:bg-white/90"
              onClick={handleSave}
              disabled={isLoading}
            >
              {isLoading ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <div className="space-y-4">
            <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
              <div className="space-y-1">
                <h3 className="text-[14px] font-semibold text-white">
                  Workspace
                </h3>
                <p className="text-[11px] leading-5 text-white/55">
                  Language and account controls.
                </p>
              </div>

              <div className="mt-4 space-y-2">
                <label className="block text-[12px] font-medium text-white">
                  Language
                </label>
                <select
                  value={language}
                  onChange={(event) => setLanguage(event.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-black/50 px-3 py-2 text-sm text-white outline-none focus:border-white/20"
                >
                  {LANGUAGE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mt-4 space-y-2">
                <label className="block text-[12px] font-medium text-white">
                  Screen Recording Visibility
                </label>
                <button
                  type="button"
                  onClick={() => void handleToggleScreenRecordingVisibility()}
                  disabled={isTogglingVisibility}
                  className={`flex w-full items-center justify-between rounded-xl border px-3 py-2.5 text-sm transition-colors ${
                    isScreenRecordingVisible
                      ? "border-amber-400/30 bg-amber-500/10 text-amber-100"
                      : "border-white/10 bg-black/50 text-white/70 hover:bg-white/5"
                  } ${isTogglingVisibility ? "opacity-60" : ""}`}
                >
                  <span className="flex items-center gap-2">
                    {isScreenRecordingVisible ? (
                      <Eye className="h-4 w-4" />
                    ) : (
                      <EyeOff className="h-4 w-4" />
                    )}
                    {isScreenRecordingVisible ? "Demo Mode (visible)" : "Stealth Mode (hidden)"}
                  </span>
                  <span className="text-[10px] text-white/40">
                    {isScreenRecordingVisible ? "ON" : "OFF"}
                  </span>
                </button>
                <p className="text-[10px] leading-4 text-white/40">
                  Toggle whether Sylica appears in screen recordings. Stealth mode hides the widget from screen capture.
                </p>
              </div>

              <Button
                variant="outline"
                onClick={handleLogout}
                className="mt-4 w-full border-red-400/20 text-red-200 hover:bg-red-500/10 hover:text-red-100"
              >
                Log Out
              </Button>

              <Button
                variant="outline"
                onClick={() => {
                  void handleQuitApp()
                }}
                className="mt-2 w-full border-white/10 text-white hover:bg-white/5"
              >
                <span className="inline-flex items-center gap-2">
                  <Power className="h-3.5 w-3.5" />
                  Quit App
                </span>
              </Button>
            </div>

            <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
              <div className="space-y-1">
                <h3 className="text-[14px] font-semibold text-white">
                  Keyboard Shortcuts
                </h3>
                <p className="text-[11px] leading-5 text-white/55">
                  Quick reference.
                </p>
              </div>

              <div className="mt-4 space-y-2">
                {SHORTCUT_ROWS.map((shortcut) => (
                  <div
                    key={shortcut.label}
                    className="flex items-center justify-between gap-3 rounded-xl border border-white/6 bg-white/[0.03] px-3 py-2"
                  >
                    <span className="text-[11px] text-white/65">
                      {shortcut.label}
                    </span>
                    <span className="rounded-md bg-black/55 px-2 py-1 font-mono text-[10px] text-white/90">
                      {shortcut.keys}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-[13px] font-medium text-white">
                API Provider
              </label>
              <div className="grid grid-cols-2 gap-2">
                {PROVIDER_ORDER.map((provider) => (
                  <div
                    key={provider}
                    className={`cursor-pointer rounded-xl p-3 transition-colors ${
                      apiProvider === provider
                        ? "border border-white/20 bg-white/10"
                        : "border border-white/5 bg-black/30 hover:bg-white/5"
                    }`}
                    onClick={() => handleProviderChange(provider)}
                  >
                    <div className="flex items-center gap-2">
                      <div
                        className={`h-3 w-3 rounded-full ${
                          apiProvider === provider ? "bg-white" : "bg-white/20"
                        }`}
                      />
                      <div className="flex flex-col">
                        <p className="text-[13px] font-medium text-white">
                          {PROVIDER_CARD_TITLES[provider]}
                        </p>
                        <p className="text-[11px] text-white/60">
                          {PROVIDER_CARD_DESCRIPTIONS[provider]}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-2 rounded-2xl border border-white/10 bg-black/25 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <label className="text-[13px] font-medium text-white">
                    {PROVIDER_KEY_LABELS[apiProvider]}
                  </label>
                  <p className="mt-1 text-[11px] leading-4 text-white/55">
                    Stored locally. Environment variables still override saved
                    keys.
                  </p>
                </div>
                {configuredApiProviders.includes(apiProvider) ? (
                  <span className="rounded-full border border-emerald-300/20 bg-emerald-300/10 px-2 py-1 text-[10px] text-emerald-100">
                    Configured
                  </span>
                ) : (
                  <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[10px] text-white/55">
                    Missing
                  </span>
                )}
              </div>

              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={
                  configuredApiProviders.includes(apiProvider)
                    ? "Paste a new key to replace the saved key"
                    : PROVIDER_KEY_PLACEHOLDERS[apiProvider]
                }
                className="w-full rounded-xl border border-white/10 bg-black/50 px-3 py-2 text-sm text-white outline-none transition-colors placeholder:text-white/28 focus:border-white/25"
              />

              <p className="text-[10.5px] leading-4 text-white/45">
                Realtime voice, live transcription, and computer use require an
                OpenAI key. If Settings opened from Voice, choose the OpenAI
                card above, save the key once, then switch back to another main
                provider if you want.
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-[13px] font-medium text-white">
                  AI Model Selection
                </label>
                <p className="mt-1 text-[11px] text-white/60">
                  Pick models for extraction, answers, and chat.
                </p>
              </div>

              {MODEL_CATEGORIES.map((category) => {
                const models = MODEL_OPTIONS[apiProvider][category.key]
                const currentValue =
                  category.key === "extractionModel"
                    ? extractionModel
                    : category.key === "solutionModel"
                    ? solutionModel
                    : debuggingModel

                const setValue =
                  category.key === "extractionModel"
                    ? setExtractionModel
                    : category.key === "solutionModel"
                    ? setSolutionModel
                    : setDebuggingModel

                return (
                  <div key={category.key} className="space-y-2">
                    <div>
                      <label className="block text-[13px] font-medium text-white">
                        {category.title}
                      </label>
                      <p className="mt-1 text-[11px] text-white/60">
                        {category.description}
                      </p>
                    </div>

                    <div className="space-y-2">
                      {models.map((model) => (
                        <div
                          key={model.id}
                          className={`cursor-pointer rounded-xl p-3 transition-colors ${
                            currentValue === model.id
                              ? "border border-white/20 bg-white/10"
                              : "border border-white/5 bg-black/30 hover:bg-white/5"
                          }`}
                          onClick={() => setValue(model.id)}
                        >
                          <div className="flex items-center gap-2">
                            <div
                              className={`h-3 w-3 rounded-full ${
                                currentValue === model.id
                                  ? "bg-white"
                                  : "bg-white/20"
                              }`}
                            />
                            <div>
                              <p className="text-[12px] font-medium text-white">
                                {model.name}
                              </p>
                              <p className="text-[11px] text-white/60">
                                {model.description}
                              </p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
