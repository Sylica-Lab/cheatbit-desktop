import React, { useState, useEffect, useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import { X } from "lucide-react"
import ScreenshotQueue from "../components/Queue/ScreenshotQueue"
import QueueCommands from "../components/Queue/QueueCommands"
import { useToast } from "../contexts/toast"
import { GeneralChatPanel } from "../components/Chat/GeneralChatPanel"
import { VoiceAssistantPanel } from "../components/Chat/VoiceAssistantPanel"
import AgentPanel from "../components/Agent/AgentPanel"
import { Screenshot } from "../types/screenshots"
import { updateWindowToElement } from "../utils/contentSize"
import { getProcessingToastCopy } from "../utils/processingErrors"
import {
  type ComputerUseState,
  type LiveInterviewState,
  EMPTY_COMPUTER_USE_STATE,
  EMPTY_LIVE_INTERVIEW_STATE,
} from "../../shared/followUpChat"
import type { DesktopUpdateState } from "../../shared/desktopUpdates"
import { EMPTY_AGENT_STATE, type AgentState } from "../../shared/agent"

const WAKE_WORD_SAMPLE_RATE = 24000
const WAKE_WORD_SILENCE_THRESHOLD = 0.024
const WAKE_WORD_MIN_SPEECH_MS = 480
const WAKE_WORD_END_SILENCE_MS = 650
const WAKE_WORD_MAX_SEGMENT_MS = 4200

function hasSylicaWakeWord(transcript: string): boolean {
  const normalized = transcript.replace(/\s+/g, " ").trim()
  if (!normalized) {
    return false
  }

  const wakePattern = /(?:^|[.!?]\s*)(hey|hi|okay|ok)[\s,.-]+(sylica|silica|celica|sylika)\b/i
  if (!wakePattern.test(normalized)) {
    return false
  }

  return normalized.split(/\s+/).length <= 14
}

function float32ToInt16(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length)
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]))
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }
  return pcm
}

function resampleWakeAudio(samples: Float32Array, sourceRate: number): Float32Array {
  if (sourceRate === WAKE_WORD_SAMPLE_RATE) {
    return samples
  }

  const ratio = sourceRate / WAKE_WORD_SAMPLE_RATE
  const nextLength = Math.max(1, Math.round(samples.length / ratio))
  const result = new Float32Array(nextLength)
  let sourceIndex = 0

  for (let index = 0; index < nextLength; index += 1) {
    const nextSourceIndex = Math.min(
      samples.length,
      Math.round((index + 1) * ratio)
    )
    let accumulator = 0
    let count = 0

    while (sourceIndex < nextSourceIndex) {
      accumulator += samples[sourceIndex]
      sourceIndex += 1
      count += 1
    }

    result[index] = count > 0 ? accumulator / count : 0
  }

  return result
}

function mergeWakePcmChunks(chunks: Int16Array[]): ArrayBuffer {
  const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const merged = new Int16Array(totalSamples)
  let offset = 0

  chunks.forEach((chunk) => {
    merged.set(chunk, offset)
    offset += chunk.length
  })

  return merged.buffer
}

async function arrayBufferToBase64(arrayBuffer: ArrayBuffer): Promise<string> {
  let binary = ""
  const bytes = new Uint8Array(arrayBuffer)
  const chunkSize = 0x8000

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize)
    binary += String.fromCharCode(...chunk)
  }

  return window.btoa(binary)
}

async function fetchScreenshots(): Promise<Screenshot[]> {
  try {
    const existing = await window.electronAPI.getScreenshots()
    return existing
  } catch (error) {
    console.error("Error loading screenshots:", error)
    throw error
  }
}

interface QueueProps {
  setView: (view: "queue" | "solutions" | "debug") => void
  credits: number
  currentLanguage: string
  setLanguage: (language: string) => void
  desktopUpdateState: DesktopUpdateState
  onDownloadUpdate: () => Promise<{ success: true } | { success: false; error: string }>
  onInstallUpdate: () => Promise<{ success: true } | { success: false; error: string }>
}

const Queue: React.FC<QueueProps> = ({
  setView,
  credits,
  desktopUpdateState,
  onDownloadUpdate,
  onInstallUpdate,
}) => {
  const { showToast } = useToast()

  const [isTooltipVisible, setIsTooltipVisible] = useState(false)
  const [tooltipHeight, setTooltipHeight] = useState(0)
  const [activeMode, setActiveMode] = useState<"analyze" | "voice" | "live" | "agent">("analyze")
  const [isMinimized, setIsMinimized] = useState(false)
  const [computerUseState, setComputerUseState] = useState<ComputerUseState>(
    EMPTY_COMPUTER_USE_STATE
  )
  const [computerTaskRequest, setComputerTaskRequest] = useState<{
    id: string
    task: string
  } | null>(null)
  const [voiceAutoStartSignal, setVoiceAutoStartSignal] = useState<string | null>(
    null
  )
  // Tracks the realtime voice session globally so we can re-enable wake-word
  // detection when voice actually stops, even if activeMode is still "voice".
  const [isVoiceSessionLive, setIsVoiceSessionLive] = useState(false)
  const [liveInterviewState, setLiveInterviewState] = useState<LiveInterviewState>(
    EMPTY_LIVE_INTERVIEW_STATE
  )
  const [agentState, setAgentState] = useState<AgentState>(EMPTY_AGENT_STATE)
  const contentRef = useRef<HTMLDivElement>(null)
  const wakeWordCooldownRef = useRef(0)

  const isComputerTaskActive =
    computerUseState.status === "starting" ||
    computerUseState.status === "running" ||
    computerUseState.status === "waiting_for_secret" ||
    computerUseState.status === "stopping"

  const {
    data: screenshots = [],
    refetch
  } = useQuery<Screenshot[]>({
    queryKey: ["screenshots"],
    queryFn: fetchScreenshots,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false
  })

  const handleDeleteScreenshot = async (index: number) => {
    const screenshotToDelete = screenshots[index]

    try {
      const response = await window.electronAPI.deleteScreenshot(
        screenshotToDelete.path
      )

      if (response.success) {
        refetch() // Refetch screenshots instead of managing state directly
      } else {
        console.error("Failed to delete screenshot:", response.error)
        showToast("Error", "Failed to delete the screenshot file", "error")
      }
    } catch (error) {
      console.error("Error deleting screenshot:", error)
    }
  }

  useEffect(() => {
    let cancelled = false

    const loadLiveInterviewState = async () => {
      const response = await window.electronAPI.getLiveInterviewState()
      if (!cancelled && response.success) {
        setLiveInterviewState(response.data.state)
      }
    }

    const loadComputerUseState = async () => {
      const response = await window.electronAPI.getComputerUseState()
      if (!cancelled && response.success) {
        setComputerUseState(response.data.state)
      }
    }

    const loadAgentState = async () => {
      const response = await window.electronAPI.getAgentState()
      if (!cancelled && response.success) {
        setAgentState(response.data.state)
      }
    }

    void loadLiveInterviewState()
    void loadComputerUseState()
    void loadAgentState()

    const unsubscribe = window.electronAPI.onLiveInterviewState((state: LiveInterviewState) => {
      setLiveInterviewState(state)
    })
    const unsubscribeComputerUse = window.electronAPI.onComputerUseState((state: ComputerUseState) => {
      setComputerUseState(state)
    })
    const unsubscribeAgent = window.electronAPI.onAgentState((state: AgentState) => {
      setAgentState(state)
    })

    return () => {
      cancelled = true
      unsubscribe()
      unsubscribeComputerUse()
      unsubscribeAgent()
    }
  }, [])

  useEffect(() => {
    if (liveInterviewState.status !== "idle" && activeMode !== "live") {
      setActiveMode("live")
    }
  }, [activeMode, liveInterviewState.status])

  useEffect(() => {
    const isAgentActive =
      agentState.status === "planning" ||
      agentState.status === "awaiting_workspace" ||
      agentState.status === "awaiting_approval" ||
      agentState.status === "running"

    if (
      isAgentActive &&
      activeMode !== "agent" &&
      liveInterviewState.status === "idle"
    ) {
      setActiveMode("agent")
    }
  }, [activeMode, agentState.status, liveInterviewState.status])

  useEffect(() => {
    // Height update logic
    const updateDimensions = () => {
      if (contentRef.current) {
        updateWindowToElement(
          contentRef.current,
          { height: isTooltipVisible ? tooltipHeight : 0 }
        )
      }
    }

    // Initialize resize observer
    const resizeObserver = new ResizeObserver(updateDimensions)
    if (contentRef.current) {
      resizeObserver.observe(contentRef.current)
    }
    updateDimensions()

    // Set up event listeners
    const cleanupFunctions = [
      window.electronAPI.onScreenshotTaken(() => refetch()),
      window.electronAPI.onResetView(() => refetch()),
      window.electronAPI.onDeleteLastScreenshot(async () => {
        if (screenshots.length > 0) {
          await handleDeleteScreenshot(screenshots.length - 1);
          // Toast removed as requested
        } else {
          showToast("No Screenshots", "There are no screenshots to delete", "neutral");
        }
      }),
      window.electronAPI.onSolutionError((error: string) => {
        const toastCopy = getProcessingToastCopy(error)
        showToast(
          toastCopy.title,
          toastCopy.message,
          "error"
        )
        setView("queue") // Revert to queue if processing fails
        console.error("Processing error:", error)
      }),
      window.electronAPI.onProcessingNoScreenshots(() => {
        showToast(
          "No Screenshots",
          "There are no screenshots to process.",
          "neutral"
        )
      }),
      // Removed out of credits handler - unlimited credits in this version
    ]

    return () => {
      resizeObserver.disconnect()
      cleanupFunctions.forEach((cleanup) => cleanup())
    }
  }, [isTooltipVisible, tooltipHeight, screenshots])

  useEffect(() => {
    const updateDimensions = () => {
      if (!contentRef.current) {
        return
      }

      updateWindowToElement(contentRef.current, {
        height: isTooltipVisible ? tooltipHeight : 0,
      })
    }

    updateDimensions()
    const animationFrameId = window.requestAnimationFrame(updateDimensions)
    const delayedUpdateId = window.setTimeout(updateDimensions, 120)

    return () => {
      window.cancelAnimationFrame(animationFrameId)
      window.clearTimeout(delayedUpdateId)
    }
  }, [
    activeMode,
    isMinimized,
    isTooltipVisible,
    tooltipHeight,
    liveInterviewState.status,
    agentState.status,
    agentState.events.length,
    agentState.artifacts.length,
  ])

  const handleTooltipVisibilityChange = (visible: boolean, height: number) => {
    setIsTooltipVisible(visible)
    setTooltipHeight(height)
  }

  const handleStartVoiceMode = () => {
    if (liveInterviewState.status !== "idle") {
      showToast(
        "Voice",
        "Stop Live Interview before starting realtime voice.",
        "neutral"
      )
      return
    }

    setActiveMode("voice")
    setVoiceAutoStartSignal(`${Date.now()}`)
  }

  // Auto-start voice once on initial app launch so Sylica is ready to talk
  // without the user needing to click anything. Guarded by a ref so it only
  // fires once per page load — re-entering this page (HMR, Strict Mode) won't
  // re-trigger voice or steal focus from whatever the user is doing.
  const hasAutoStartedVoiceRef = useRef(false)
  useEffect(() => {
    if (hasAutoStartedVoiceRef.current) {
      return
    }
    if (liveInterviewState.status !== "idle") {
      return
    }
    if (isComputerTaskActive) {
      return
    }
    hasAutoStartedVoiceRef.current = true
    // Slight delay lets the dock + panels finish their entrance animation
    // before the mic lights up, so it doesn't feel jarring.
    const handle = window.setTimeout(() => {
      handleStartVoiceMode()
    }, 600)
    return () => {
      window.clearTimeout(handle)
    }
    // We intentionally run this once on mount; subsequent state changes shouldn't
    // re-fire the launcher.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const handleVoiceActive = (event: Event) => {
      const detail = (event as CustomEvent<boolean>).detail
      setIsVoiceSessionLive(Boolean(detail))
    }
    const handleVoiceManualStop = () => {
      wakeWordCooldownRef.current = Date.now()
    }
    window.addEventListener("sylica-voice-active", handleVoiceActive)
    window.addEventListener("sylica-voice-manual-stop", handleVoiceManualStop)
    return () => {
      window.removeEventListener("sylica-voice-active", handleVoiceActive)
      window.removeEventListener("sylica-voice-manual-stop", handleVoiceManualStop)
    }
  }, [])

  useEffect(() => {
    // Wake-word listener: only run when nothing else owns the mic. The voice
    // realtime session is the real signal — relying on activeMode alone meant
    // wake word stayed disabled forever after the user stopped voice without
    // closing the panel.
    if (
      isVoiceSessionLive ||
      activeMode === "live" ||
      liveInterviewState.status !== "idle"
    ) {
      return
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      return
    }

    let audioContext: AudioContext | null = null
    let sourceNode: MediaStreamAudioSourceNode | null = null
    let processorNode: ScriptProcessorNode | null = null
    let sinkNode: GainNode | null = null
    let stream: MediaStream | null = null
    let disposed = false
    let segmentChunks: Int16Array[] = []
    let segmentSampleCount = 0
    let speechSampleCount = 0
    let silenceSampleCount = 0
    let isSpeechActive = false
    let flushQueue = Promise.resolve()

    const resetSegment = () => {
      segmentChunks = []
      segmentSampleCount = 0
      speechSampleCount = 0
      silenceSampleCount = 0
      isSpeechActive = false
    }

    const activateVoice = () => {
      if (disposed) {
        return
      }

      disposed = true
      wakeWordCooldownRef.current = Date.now()
      setIsMinimized(false)
      showToast("Voice", "Hey Sylica heard. Starting voice.", "neutral")
      handleStartVoiceMode()
    }

    const flushSegment = () => {
      const chunks = segmentChunks
      const totalSamples = segmentSampleCount
      const totalSpeechSamples = speechSampleCount
      resetSegment()

      if (
        disposed ||
        chunks.length === 0 ||
        totalSamples === 0 ||
        totalSpeechSamples < (WAKE_WORD_SAMPLE_RATE * WAKE_WORD_MIN_SPEECH_MS) / 1000
      ) {
        return
      }

      flushQueue = flushQueue
        .catch(() => {
          // Keep wake-word detection alive even if one transcription fails.
        })
        .then(async () => {
          if (disposed || Date.now() - wakeWordCooldownRef.current < 5000) {
            return
          }

          const audioBase64 = await arrayBufferToBase64(mergeWakePcmChunks(chunks))
          const response = await window.electronAPI.transcribeVoiceAudio({
            audioBase64,
            mimeType: "audio/pcm;rate=24000;encoding=s16le",
          })

          if (!response.success || disposed) {
            return
          }

          const transcript = response.data.transcript.trim()
          if (hasSylicaWakeWord(transcript)) {
            activateVoice()
          }
        })
        .catch((error) => {
          if (!disposed) {
            console.warn("Wake word transcription failed:", error)
          }
        })
    }

    const startListening = async () => {
      try {
        const permission = await window.electronAPI.requestMicrophoneAccess()
        if (disposed || !permission.granted) {
          return
        }

        const AudioContextConstructor =
          window.AudioContext || (window as any).webkitAudioContext
        if (!AudioContextConstructor) {
          return
        }

        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        })
        audioContext = new AudioContextConstructor({
          sampleRate: WAKE_WORD_SAMPLE_RATE,
        })
        sourceNode = audioContext.createMediaStreamSource(stream)
        processorNode = audioContext.createScriptProcessor(4096, 1, 1)
        sinkNode = audioContext.createGain()
        sinkNode.gain.value = 0

        processorNode.onaudioprocess = (event) => {
          if (disposed || !audioContext) {
            return
          }

          const inputBuffer = event.inputBuffer
          const channelCount = inputBuffer.numberOfChannels
          if (channelCount === 0) {
            return
          }

          const frameCount = inputBuffer.length
          const monoSamples = new Float32Array(frameCount)

          for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
            const channelData = inputBuffer.getChannelData(channelIndex)
            for (let sampleIndex = 0; sampleIndex < frameCount; sampleIndex += 1) {
              monoSamples[sampleIndex] += channelData[sampleIndex] / channelCount
            }
          }

          let energy = 0
          for (let index = 0; index < monoSamples.length; index += 1) {
            energy += monoSamples[index] * monoSamples[index]
          }

          const rms = Math.sqrt(energy / Math.max(1, monoSamples.length))
          const resampled = resampleWakeAudio(monoSamples, audioContext.sampleRate)
          const pcmChunk = float32ToInt16(resampled)
          const speech = rms >= WAKE_WORD_SILENCE_THRESHOLD

          if (speech || isSpeechActive) {
            segmentChunks.push(pcmChunk)
            segmentSampleCount += pcmChunk.length
          }

          if (speech) {
            isSpeechActive = true
            speechSampleCount += pcmChunk.length
            silenceSampleCount = 0
          } else if (isSpeechActive) {
            silenceSampleCount += pcmChunk.length
          }

          if (
            isSpeechActive &&
            (silenceSampleCount >= (WAKE_WORD_SAMPLE_RATE * WAKE_WORD_END_SILENCE_MS) / 1000 ||
              segmentSampleCount >= (WAKE_WORD_SAMPLE_RATE * WAKE_WORD_MAX_SEGMENT_MS) / 1000)
          ) {
            flushSegment()
          }
        }

        sourceNode.connect(processorNode)
        processorNode.connect(sinkNode)
        sinkNode.connect(audioContext.destination)
        await audioContext.resume()
      } catch (error) {
        console.warn("Wake word listener could not start:", error)
      }
    }

    void startListening()

    return () => {
      disposed = true
      if (processorNode) {
        processorNode.onaudioprocess = null
      }
      try {
        sourceNode?.disconnect()
        processorNode?.disconnect()
        sinkNode?.disconnect()
      } catch (_error) {
        // Ignore audio graph shutdown races.
      }
      stream?.getTracks().forEach((track) => track.stop())
      void audioContext?.close().catch(() => {
        // Ignore audio context close races.
      })
    }
  }, [activeMode, isVoiceSessionLive, liveInterviewState.status])

  const handleOpenLiveMode = () => {
    setActiveMode("live")
  }

  const handleOpenAnalyzeMode = () => {
    setActiveMode("analyze")
  }

  const handleOpenAgentMode = () => {
    // Make sure the widget is expanded so the agent panel below the dock is
    // actually visible — otherwise clicking the agent indicator from a
    // minimized widget appears to do nothing.
    if (isMinimized) {
      setIsMinimized(false)
    }
    setActiveMode("agent")
  }

  const handleOpenVoiceMode = () => {
    if (isMinimized) {
      setIsMinimized(false)
    }

    if (liveInterviewState.status !== "idle") {
      showToast(
        "Voice",
        "Stop Live Interview before starting realtime voice.",
        "neutral"
      )
      return
    }

    setActiveMode("voice")
    if (!isVoiceSessionLive) {
      setVoiceAutoStartSignal(`${Date.now()}`)
    }
  }

  const handleStartComputerTask = async (task: string) => {
    if (liveInterviewState.status !== "idle") {
      showToast(
        "Computer Use",
        "Stop Live Interview before starting browser control.",
        "neutral"
      )
      return
    }

    if (isComputerTaskActive) {
      showToast(
        "Computer Use",
        "A computer task is already running.",
        "neutral"
      )
      return
    }

    setActiveMode("voice")
    setComputerTaskRequest({
      id: `${Date.now()}`,
      task,
    })
  }

  const handleStopComputerTask = async () => {
    const response = await window.electronAPI.stopComputerUseTask()
    if (!response.success) {
      showToast(
        "Computer Use",
        response.error || "Failed to stop computer task.",
        "error"
      )
    }
  }

  const handleResumeComputerTask = async () => {
    const response = await window.electronAPI.resumeComputerUseAfterSecret()
    if (!response.success) {
      showToast(
        "Computer Use",
        response.error || "Failed to resume computer task.",
        "error"
      )
    }
  }

  const hasExpandedPanel =
    !isMinimized && (activeMode === "voice" || activeMode === "live" || activeMode === "agent" || screenshots.length > 0)
  const shouldOpenPanelBelow = activeMode === "voice" || activeMode === "live" || activeMode === "agent"
  const shouldUseCompactDockLayout = !isMinimized && !hasExpandedPanel
  const [shouldRenderExpandedPanel, setShouldRenderExpandedPanel] =
    useState(hasExpandedPanel)

  useEffect(() => {
    if (hasExpandedPanel) {
      setShouldRenderExpandedPanel(true)
      return
    }

    const timeoutId = window.setTimeout(() => {
      setShouldRenderExpandedPanel(false)
    }, 460)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [hasExpandedPanel])

  // Listen for close panel shortcut
  useEffect(() => {
    const handleClosePanel = () => {
      // Reset to analyze mode to close expanded panels
      if (activeMode === "voice" || activeMode === "live" || activeMode === "agent") {
        setActiveMode("analyze")
      }
    }

    const cleanup = window.electronAPI.onCloseExpandedPanel?.(handleClosePanel)
    return () => {
      cleanup?.()
    }
  }, [activeMode])

  const handleClosePanel = () => {
    if (activeMode === "voice" || activeMode === "live" || activeMode === "agent") {
      setActiveMode("analyze")
    }
  }

  return (
    <div
      ref={contentRef}
      className={`sylica-widget-layout inline-flex flex-col items-start bg-transparent ${
        isMinimized
          ? ""
          : shouldUseCompactDockLayout
            ? "w-fit"
            : "w-[var(--sylica-widget-shell-width)] max-w-[var(--sylica-widget-shell-width)]"
      }`}
      data-minimized={isMinimized ? "true" : "false"}
      data-expanded={hasExpandedPanel ? "true" : "false"}
      style={{ minHeight: "fit-content" }}
    >
      <div
        className={
          isMinimized
            ? "p-0"
            : shouldUseCompactDockLayout
            ? "w-fit"
            : "w-full"
        }
      >
        <div
          className={
            isMinimized
              ? ""
              : shouldOpenPanelBelow
                ? "flex flex-col gap-2"
                : "space-y-2"
          }
        >
          <div
            className={`sylica-expand-slot ${
              shouldOpenPanelBelow ? "order-2" : "order-1"
            } ${
              hasExpandedPanel
                ? "sylica-expand-slot-open"
                : "sylica-expand-slot-closed"
            }`}
            aria-hidden={!hasExpandedPanel}
            style={{ transitionDelay: hasExpandedPanel ? "50ms" : "0ms" }}
          >
            <div className="sylica-expand-slot-inner">
              {shouldRenderExpandedPanel && (
                <div
                  key={activeMode}
                  data-sylica-size-box="true"
                  className="sylica-panel-switch sylica-liquid-shell w-full max-w-[var(--sylica-widget-shell-width)] px-3 py-3"
                  style={{ animationDelay: "100ms" }}
                >
                  {/* Minimize button — collapses the panel back to the dock.
                      Sessions (voice, agent, computer use) keep running in the
                      background and their status pills stay visible. */}
                  {(activeMode === "voice" || activeMode === "live" || activeMode === "agent") && (
                    <button
                      type="button"
                      onClick={handleClosePanel}
                      className="absolute top-2 right-2 z-20 flex h-5 w-5 items-center justify-center rounded-full bg-white/10 text-white/70 hover:bg-white/20 hover:text-white transition-colors"
                      aria-label="Minimize panel"
                      title="Minimize panel (Ctrl+Shift+V)"
                      style={{ WebkitAppRegion: "no-drag" }}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                  {activeMode === "agent" ? (
                    <AgentPanel
                      state={agentState}
                      onStateChange={setAgentState}
                      onOpenInterviewMode={handleOpenLiveMode}
                      computerUseState={computerUseState}
                      onStartComputerTask={async (task) => {
                        try {
                          const response = await window.electronAPI.startComputerUseTask({
                            task,
                          })
                          if (!response.success) {
                            showToast(
                              "Computer Use",
                              response.error || "Failed to start computer task.",
                              "error"
                            )
                            throw new Error(response.error || "Failed to start")
                          }
                          setComputerUseState(response.data.state)
                        } catch (error) {
                          throw error
                        }
                      }}
                      onStopComputerTask={handleStopComputerTask}
                      onResumeComputerTask={handleResumeComputerTask}
                    />
                  ) : activeMode === "analyze" ? (
                    <ScreenshotQueue
                      isLoading={false}
                      screenshots={screenshots}
                      onDeleteScreenshot={handleDeleteScreenshot}
                    />
                  ) : activeMode === "voice" ? (
                    <VoiceAssistantPanel
                      computerTaskRequest={computerTaskRequest}
                      voiceAutoStartSignal={voiceAutoStartSignal}
                      onComputerTaskRequestConsumed={() => {
                        setComputerTaskRequest(null)
                      }}
                    />
                  ) : (
                    <GeneralChatPanel
                      computerTaskRequest={computerTaskRequest}
                      panelMode="live"
                      voiceAutoStartSignal={voiceAutoStartSignal}
                      onComputerTaskRequestConsumed={() => {
                        setComputerTaskRequest(null)
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          </div>

          <div className={shouldOpenPanelBelow ? "order-1" : "order-2"}>
            <QueueCommands
              activeMode={activeMode}
              onOpenAnalyzeMode={handleOpenAnalyzeMode}
              onOpenAgentMode={handleOpenAgentMode}
              onOpenVoiceMode={handleOpenVoiceMode}
              onTooltipVisibilityChange={handleTooltipVisibilityChange}
              screenshotCount={screenshots.length}
              credits={credits}
              desktopUpdateState={desktopUpdateState}
              isMinimized={isMinimized}
              computerUseState={computerUseState}
              agentState={agentState}
              onDownloadUpdate={onDownloadUpdate}
              onInstallUpdate={onInstallUpdate}
              onStartComputerTask={handleStartComputerTask}
              onStopComputerTask={handleStopComputerTask}
              onResumeComputerTask={handleResumeComputerTask}
              isDockOnly={shouldUseCompactDockLayout}
              onToggleMinimized={() => {
                handleTooltipVisibilityChange(false, 0)
                setIsMinimized((current) => !current)
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

export default Queue
