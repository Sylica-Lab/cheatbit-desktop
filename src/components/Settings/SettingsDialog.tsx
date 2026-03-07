import { useEffect, useRef, useState } from "react"
import { Button } from "../ui/button"
import { useToast } from "../../contexts/toast"
import { updateWindowToElement } from "../../utils/contentSize"
import {
  type ApiProvider,
  type AppConfig,
  DEFAULT_MODELS,
  DEFAULT_PROVIDER,
  MODEL_CATEGORIES,
  MODEL_OPTIONS,
  PROVIDER_CARD_DESCRIPTIONS,
  PROVIDER_CARD_TITLES,
  PROVIDER_ORDER,
} from "../../../shared/aiConfig"

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
  const [isLoading, setIsLoading] = useState(false)
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
  ])

  const handleProviderChange = (provider: ApiProvider) => {
    setApiProvider(provider)
    const providerDefaults = DEFAULT_MODELS[provider]
    setExtractionModel(providerDefaults.extractionModel)
    setSolutionModel(providerDefaults.solutionModel)
    setDebuggingModel(providerDefaults.debuggingModel)
  }

  const handleSave = async () => {
    setIsLoading(true)

    try {
      const result = await window.electronAPI.updateConfig({
        apiProvider,
        extractionModel,
        solutionModel,
        debuggingModel,
      })

      if (result) {
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

  if (!open) {
    return null
  }

  return (
    <div
      ref={panelRef}
      className="mt-3 flex-none overflow-hidden rounded-[28px] border border-white/10 bg-[#050505] text-white shadow-[0_30px_100px_rgba(0,0,0,0.56)] min-w-[56rem] max-w-[56rem]"
    >
      <div className="max-h-[38rem] space-y-4 overflow-y-auto bg-[radial-gradient(circle_at_top_left,_rgba(125,249,199,0.15),_transparent_30%),linear-gradient(180deg,_rgba(255,255,255,0.04),_rgba(255,255,255,0.01))] p-4 sm:p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-[22px] font-semibold tracking-[-0.04em] text-white">
              Model Settings
            </h2>
            <p className="text-[13px] leading-5 text-white/62">
              Select the provider and models to use.
            </p>
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

          <div className="space-y-2">
            <label className="block text-[13px] font-medium text-white">
              Keyboard Shortcuts
            </label>
            <div className="rounded-xl border border-white/10 bg-black/30 p-3">
              <div className="grid grid-cols-2 gap-y-2 text-[11px]">
                <div className="text-white/70">Toggle Visibility</div>
                <div className="font-mono text-white/90">Ctrl+B / Cmd+B</div>
                <div className="text-white/70">Take Screenshot</div>
                <div className="font-mono text-white/90">Ctrl+H / Cmd+H</div>
                <div className="text-white/70">Process Screenshots</div>
                <div className="font-mono text-white/90">Ctrl+Enter / Cmd+Enter</div>
                <div className="text-white/70">Delete Last Screenshot</div>
                <div className="font-mono text-white/90">Ctrl+L / Cmd+L</div>
                <div className="text-white/70">Reset View</div>
                <div className="font-mono text-white/90">Ctrl+R / Cmd+R</div>
                <div className="text-white/70">Quit Application</div>
                <div className="font-mono text-white/90">Ctrl+Q / Cmd+Q</div>
                <div className="text-white/70">Move Window</div>
                <div className="font-mono text-white/90">Ctrl+Arrow Keys</div>
                <div className="text-white/70">Decrease Opacity</div>
                <div className="font-mono text-white/90">Ctrl+[ / Cmd+[</div>
                <div className="text-white/70">Increase Opacity</div>
                <div className="font-mono text-white/90">Ctrl+] / Cmd+]</div>
                <div className="text-white/70">Zoom Out</div>
                <div className="font-mono text-white/90">Ctrl+- / Cmd+-</div>
                <div className="text-white/70">Reset Zoom</div>
                <div className="font-mono text-white/90">Ctrl+0 / Cmd+0</div>
                <div className="text-white/70">Zoom In</div>
                <div className="font-mono text-white/90">Ctrl+= / Cmd+=</div>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <label className="text-[13px] font-medium text-white">
                AI Model Selection
              </label>
              <p className="mt-1 text-[11px] text-white/60">
                Select which models to use for each stage of the process.
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
  )
}
