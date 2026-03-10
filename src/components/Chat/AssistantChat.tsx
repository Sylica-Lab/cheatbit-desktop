import { useQueryClient } from "@tanstack/react-query"
import { SendHorizontal } from "lucide-react"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  type AssistantChatMode,
  type ComputerUseState,
  type ChatThreadSummary,
  type FollowUpChatMessage,
  type FollowUpChatTurn,
  EMPTY_COMPUTER_USE_STATE,
  type LiveInterviewState,
  type PersistedChatMessage,
  EMPTY_LIVE_INTERVIEW_STATE,
} from "../../../shared/followUpChat"
import { useToast } from "../../contexts/toast"
import { Button } from "../ui/button"

export const GENERAL_CHAT_QUERY_KEY = ["general_chat"] as const
const LIVE_AUDIO_SAMPLE_RATE = 16000
const LIVE_AUDIO_FLUSH_INTERVAL_MS = 1600

interface AssistantChatProps {
  queryKey: readonly string[]
  mode: AssistantChatMode
  currentContext?: string
  computerTaskRequest?: {
    id: string
    task: string
  } | null
  placeholder: string
  maxHeightClassName?: string
  className?: string
}

type MarkdownBlock =
  | { type: "paragraph"; value: string }
  | { type: "heading"; value: string; level: number }
  | { type: "unordered-list"; items: string[] }
  | { type: "ordered-list"; items: string[] }
  | { type: "blockquote"; items: string[] }
  | { type: "code"; value: string; language: string }

function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  const blocks: MarkdownBlock[] = []
  let index = 0

  const isSpecialMarkdownLine = (line: string) =>
    /^#{1,6}\s+/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line) ||
    /^>\s?/.test(line) ||
    /^```/.test(line)

  while (index < lines.length) {
    const line = lines[index]
    const trimmedLine = line.trim()

    if (!trimmedLine) {
      index += 1
      continue
    }

    const codeMatch = line.match(/^```([\w-]*)\s*$/)
    if (codeMatch) {
      const language = codeMatch[1] || "text"
      const codeLines: string[] = []
      index += 1

      while (index < lines.length && !lines[index].match(/^```/)) {
        codeLines.push(lines[index])
        index += 1
      }

      if (index < lines.length && lines[index].match(/^```/)) {
        index += 1
      }

      blocks.push({
        type: "code",
        language,
        value: codeLines.join("\n").trimEnd(),
      })
      continue
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/)
    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: headingMatch[1].length,
        value: headingMatch[2].trim(),
      })
      index += 1
      continue
    }

    if (/^>\s?/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        items.push(lines[index].replace(/^>\s?/, "").trim())
        index += 1
      }
      blocks.push({ type: "blockquote", items })
      continue
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, "").trim())
        index += 1
      }
      blocks.push({ type: "unordered-list", items })
      continue
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, "").trim())
        index += 1
      }
      blocks.push({ type: "ordered-list", items })
      continue
    }

    const paragraphLines: string[] = [trimmedLine]
    index += 1

    while (
      index < lines.length &&
      lines[index].trim() &&
      !isSpecialMarkdownLine(lines[index])
    ) {
      paragraphLines.push(lines[index].trim())
      index += 1
    }

    blocks.push({
      type: "paragraph",
      value: paragraphLines.join("\n"),
    })
  }

  return blocks
}

function renderInlineMarkdown(text: string) {
  const nodes: React.ReactNode[] = []
  const pattern =
    /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_)/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index))
    }

    if (match[2] && match[3]) {
      const linkLabel = match[2]
      const url = match[3]
      nodes.push(
        <button
          key={`link-${match.index}`}
          type="button"
          onClick={() => window.electronAPI.openLink(url)}
          className="inline text-left font-medium text-[#7df9c7] underline underline-offset-2 hover:text-[#9bffd8]"
        >
          {linkLabel}
        </button>
      )
    } else if (match[4]) {
      nodes.push(
        <code
          key={`code-${match.index}`}
          className="rounded bg-black/35 px-1.5 py-0.5 font-mono text-[11px] text-white"
        >
          {match[4]}
        </code>
      )
    } else if (match[5] || match[6]) {
      nodes.push(
        <strong key={`strong-${match.index}`} className="font-semibold">
          {match[5] || match[6]}
        </strong>
      )
    } else if (match[7] || match[8]) {
      nodes.push(
        <em key={`em-${match.index}`} className="italic">
          {match[7] || match[8]}
        </em>
      )
    }

    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }

  return nodes.flatMap((node, index) => {
    if (typeof node !== "string") {
      return node
    }

    return node.split("\n").flatMap((segment, lineIndex, segments) => {
      const parts: React.ReactNode[] = [
        <React.Fragment key={`text-${index}-${lineIndex}`}>
          {segment}
        </React.Fragment>,
      ]

      if (lineIndex < segments.length - 1) {
        parts.push(<br key={`br-${index}-${lineIndex}`} />)
      }

      return parts
    })
  })
}

function renderMessageContent(content: string, compact: boolean = false) {
  return parseMarkdownBlocks(content).map((block, index) => {
    if (block.type === "code") {
      return (
        <pre
          key={`${block.type}-${index}`}
          className={`overflow-x-auto rounded-xl border border-white/10 bg-[rgba(15,23,42,0.78)] text-white ${
            compact
              ? "p-2.5 text-[10.5px] leading-[1.45]"
              : "p-3 text-[12px] leading-[1.55]"
          }`}
        >
          <code>{block.value}</code>
        </pre>
      )
    }

    if (block.type === "heading") {
      const headingClassName =
        block.level <= 2
          ? compact
            ? "text-[11px] font-semibold tracking-[0.01em] text-white"
            : "text-[13px] font-semibold tracking-[0.01em] text-white"
          : compact
            ? "text-[10.5px] font-semibold text-white"
            : "text-[12px] font-semibold text-white"

      return (
        <div key={`${block.type}-${index}`} className={headingClassName}>
          {renderInlineMarkdown(block.value)}
        </div>
      )
    }

    if (block.type === "unordered-list") {
      return (
        <div
          key={`${block.type}-${index}`}
          className={`space-y-1 text-white/[0.92] ${
            compact ? "text-[10.5px] leading-[1.45]" : ""
          }`}
        >
          {block.items.map((item, itemIndex) => (
            <div key={`${block.type}-${itemIndex}`} className="flex items-start gap-2">
              <div
                className={`shrink-0 rounded-full bg-current/60 ${
                  compact ? "mt-[6px] h-1 w-1" : "mt-[7px] h-1.5 w-1.5"
                }`}
              />
              <div className="min-w-0 flex-1">{renderInlineMarkdown(item)}</div>
            </div>
          ))}
        </div>
      )
    }

    if (block.type === "ordered-list") {
      return (
        <div
          key={`${block.type}-${index}`}
          className={`space-y-1 text-white/[0.92] ${
            compact ? "text-[10.5px] leading-[1.45]" : ""
          }`}
        >
          {block.items.map((item, itemIndex) => (
            <div key={`${block.type}-${itemIndex}`} className="flex items-start gap-2">
              <div className="min-w-[1.1rem] shrink-0 text-white/[0.55]">
                {itemIndex + 1}.
              </div>
              <div className="min-w-0 flex-1">{renderInlineMarkdown(item)}</div>
            </div>
          ))}
        </div>
      )
    }

    if (block.type === "blockquote") {
      return (
        <div
          key={`${block.type}-${index}`}
          className={`border-l-2 border-white/15 pl-3 text-white/[0.72] ${
            compact ? "text-[10.5px] leading-[1.45]" : ""
          }`}
        >
          {block.items.map((item, itemIndex) => (
            <div key={`${block.type}-${itemIndex}`}>
              {renderInlineMarkdown(item)}
            </div>
          ))}
        </div>
      )
    }

    return (
      <div
        key={`${block.type}-${index}`}
        className={`whitespace-pre-wrap text-white/[0.92] ${
          compact
            ? "text-[10.5px] leading-[1.45]"
            : "text-[12px] leading-[1.55]"
        }`}
      >
        {renderInlineMarkdown(block.value)}
      </div>
    )
  })
}

function toMessageTimestamp(value: string | null | undefined) {
  if (!value) {
    return Date.now()
  }

  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : Date.now()
}

function mapPersistedMessage(message: PersistedChatMessage): FollowUpChatMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: toMessageTimestamp(message.createdAt),
  }
}

function buildThreadTitle(message: string) {
  const normalized = message.replace(/\s+/g, " ").trim()
  if (!normalized) {
    return "New chat"
  }

  if (normalized.length <= 56) {
    return normalized
  }

  return `${normalized.slice(0, 53).trimEnd()}...`
}

function getThreadLabel(thread: ChatThreadSummary) {
  const rawLabel = thread.title.trim() || thread.preview.trim() || "New chat"
  if (rawLabel.length <= 22) {
    return rawLabel
  }

  return `${rawLabel.slice(0, 19).trimEnd()}...`
}

function buildLiveSuggestionPlaceholder(
  liveState: LiveInterviewState,
  isLiveListening: boolean
) {
  if (liveState.latestAnswer.trim()) {
    return liveState.latestAnswer
  }

  if (liveState.isProcessing) {
    return "- Thinking through the latest question.\n- Updating the best answer now."
  }

  if (liveState.latestTranscript.trim()) {
    return "- Heard the question.\n- Building a sharper answer now."
  }

  if (!isLiveListening) {
    return "- Waiting for computer audio.\n- Start the interview audio to get live suggestions."
  }

  return "- Listening for the next question.\n- Suggestions will appear here."
}

function buildComputerUsePlaceholder(state: ComputerUseState) {
  if (state.latestError.trim()) {
    return state.latestError
  }

  if (state.status === "starting") {
    return "- Starting Chrome control.\n- Preparing the browser task."
  }

  if (state.status === "waiting_for_secret" || state.needsSecretInput) {
    return "- Waiting for manual password, OTP, or payment input.\n- Complete it in Chrome, then click Continue."
  }

  if (state.currentAction.trim()) {
    return `- ${state.currentAction}\n- ${state.currentUrl || "Working in Chrome."}`
  }

  return "- Running the browser task.\n- Progress will appear here."
}

function getLiveAudioErrorMessage(error: unknown) {
  const defaultMessage =
    "System audio capture failed. Check desktop audio capture and try again."

  if (!(error instanceof Error)) {
    return defaultMessage
  }

  const errorName = String((error as { name?: string }).name || "")
  if (errorName === "NotAllowedError" || errorName === "PermissionDeniedError") {
    return "Desktop audio capture was denied. Allow screen/audio capture and try again."
  }

  if (errorName === "NotFoundError" || errorName === "DevicesNotFoundError") {
    return "No desktop audio source was available. Start the interview audio and try again."
  }

  if (errorName === "NotReadableError" || errorName === "TrackStartError") {
    return "Desktop audio is busy or unavailable. Close other screen/audio capture apps and try again."
  }

  if (error.message.trim()) {
    return error.message
  }

  return defaultMessage
}

export function AssistantChat({
  queryKey,
  mode,
  currentContext = "",
  computerTaskRequest = null,
  placeholder,
  maxHeightClassName = "max-h-[18rem]",
  className = "",
}: AssistantChatProps) {
  const queryClient = useQueryClient()
  const { showToast } = useToast()
  const isPersistedMode = mode === "general"
  const [messages, setMessages] = useState<FollowUpChatMessage[]>([])
  const [threads, setThreads] = useState<ChatThreadSummary[]>([])
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [isHistoryLoading, setIsHistoryLoading] = useState(isPersistedMode)
  const [isMessagesLoading, setIsMessagesLoading] = useState(false)
  const [input, setInput] = useState("")
  const [isSending, setIsSending] = useState(false)
  const [computerUseState, setComputerUseState] = useState<ComputerUseState>(
    EMPTY_COMPUTER_USE_STATE
  )
  const [liveState, setLiveState] = useState<LiveInterviewState>(
    EMPTY_LIVE_INTERVIEW_STATE
  )
  const [isLiveActionPending, setIsLiveActionPending] = useState(false)
  const [isComputerUseActionPending, setIsComputerUseActionPending] = useState(false)
  const [isLiveListening, setIsLiveListening] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const liveAudioStreamRef = useRef<MediaStream | null>(null)
  const liveCaptureSourceStreamRef = useRef<MediaStream | null>(null)
  const liveAudioContextRef = useRef<AudioContext | null>(null)
  const liveAudioSourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const liveAudioProcessorNodeRef = useRef<ScriptProcessorNode | null>(null)
  const liveAudioSinkNodeRef = useRef<GainNode | null>(null)
  const liveAudioFlushIntervalRef = useRef<number | null>(null)
  const livePcmChunksRef = useRef<Int16Array[]>([])
  const livePcmSampleCountRef = useRef(0)
  const liveAudioStoppingRef = useRef(false)
  const lastComputerTaskRequestIdRef = useRef<string | null>(null)
  const isLiveSessionActive = isPersistedMode && liveState.status !== "idle"
  const isComputerUseSessionActive =
    isPersistedMode &&
    (computerUseState.status === "starting" ||
      computerUseState.status === "running" ||
      computerUseState.status === "waiting_for_secret" ||
      computerUseState.status === "stopping")

  const stopLiveAudioCapture = useCallback(() => {
    liveAudioStoppingRef.current = true

    if (liveAudioFlushIntervalRef.current !== null) {
      window.clearInterval(liveAudioFlushIntervalRef.current)
      liveAudioFlushIntervalRef.current = null
    }

    if (liveAudioProcessorNodeRef.current) {
      liveAudioProcessorNodeRef.current.onaudioprocess = null
      try {
        liveAudioProcessorNodeRef.current.disconnect()
      } catch (_error) {
        // Ignore disconnect errors.
      }
      liveAudioProcessorNodeRef.current = null
    }

    if (liveAudioSourceNodeRef.current) {
      try {
        liveAudioSourceNodeRef.current.disconnect()
      } catch (_error) {
        // Ignore disconnect errors.
      }
      liveAudioSourceNodeRef.current = null
    }

    if (liveAudioSinkNodeRef.current) {
      try {
        liveAudioSinkNodeRef.current.disconnect()
      } catch (_error) {
        // Ignore disconnect errors.
      }
      liveAudioSinkNodeRef.current = null
    }

    if (liveAudioContextRef.current) {
      void liveAudioContextRef.current.close().catch(() => {
        // Ignore audio context shutdown errors.
      })
      liveAudioContextRef.current = null
    }

    if (liveAudioStreamRef.current) {
      liveAudioStreamRef.current.getTracks().forEach((track) => track.stop())
      liveAudioStreamRef.current = null
    }

    if (liveCaptureSourceStreamRef.current) {
      liveCaptureSourceStreamRef.current.getTracks().forEach((track) => track.stop())
      liveCaptureSourceStreamRef.current = null
    }

    livePcmChunksRef.current = []
    livePcmSampleCountRef.current = 0
    setIsLiveListening(false)
  }, [])

  const requestLiveAudioStream = useCallback(async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error("System audio capture is not supported in this desktop runtime.")
    }

    const captureStream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: true,
    })
    liveCaptureSourceStreamRef.current = captureStream

    const audioTracks = captureStream.getAudioTracks().map((track) => track.clone())
    if (audioTracks.length === 0) {
      captureStream.getTracks().forEach((track) => track.stop())
      liveCaptureSourceStreamRef.current = null
      throw new Error(
        "System audio was not available. Make sure the interviewer audio is playing through this computer."
      )
    }

    return new MediaStream(audioTracks)
  }, [])

  const float32ToInt16 = useCallback((samples: Float32Array) => {
    const pcm = new Int16Array(samples.length)
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index]))
      pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
    }
    return pcm
  }, [])

  const resampleAudio = useCallback((samples: Float32Array, sourceRate: number) => {
    if (sourceRate === LIVE_AUDIO_SAMPLE_RATE) {
      return samples
    }

    const ratio = sourceRate / LIVE_AUDIO_SAMPLE_RATE
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
  }, [])

  const arrayBufferToBase64 = useCallback(async (arrayBuffer: ArrayBuffer) => {
    let binary = ""
    const bytes = new Uint8Array(arrayBuffer)
    const chunkSize = 0x8000

    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, offset + chunkSize)
      binary += String.fromCharCode(...chunk)
    }

    return window.btoa(binary)
  }, [])

  const mergePcmChunks = useCallback((pcmChunks: Int16Array[]) => {
    const totalSamples = pcmChunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const merged = new Int16Array(totalSamples)
    let offset = 0

    pcmChunks.forEach((chunk) => {
      merged.set(chunk, offset)
      offset += chunk.length
    })

    return merged.buffer
  }, [])

  const flushLiveAudioChunk = useCallback(async () => {
    if (
      liveAudioStoppingRef.current ||
      livePcmSampleCountRef.current === 0
    ) {
      return
    }

    const pcmChunks = livePcmChunksRef.current
    livePcmChunksRef.current = []
    livePcmSampleCountRef.current = 0

    const pcmBuffer = mergePcmChunks(pcmChunks)
    const audioBase64 = await arrayBufferToBase64(pcmBuffer)
    const response = await window.electronAPI.addLiveInterviewAudioChunk({
      audioBase64,
      mimeType: "audio/pcm;rate=16000;encoding=s16le",
    })

    if (!response.success && !liveAudioStoppingRef.current) {
      throw new Error(response.error)
    }
  }, [arrayBufferToBase64, mergePcmChunks])

  const startLiveAudioCapture = useCallback(async (initialStream?: MediaStream) => {
    stopLiveAudioCapture()

    const stream = initialStream ?? (await requestLiveAudioStream())
    liveAudioStreamRef.current = stream
    liveAudioStoppingRef.current = false

    try {
      const AudioContextConstructor =
        window.AudioContext || (window as any).webkitAudioContext

      if (!AudioContextConstructor) {
        throw new Error("Live audio capture is not supported in this desktop runtime.")
      }

      const audioContext = new AudioContextConstructor({
        sampleRate: LIVE_AUDIO_SAMPLE_RATE,
      })
      const sourceNode = audioContext.createMediaStreamSource(stream)
      const processorNode = audioContext.createScriptProcessor(4096, 1, 1)
      const sinkNode = audioContext.createGain()
      sinkNode.gain.value = 0

      processorNode.onaudioprocess = (event) => {
        if (liveAudioStoppingRef.current) {
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

        const resampledSamples = resampleAudio(
          monoSamples,
          audioContext.sampleRate
        )
        const pcmChunk = float32ToInt16(resampledSamples)

        livePcmChunksRef.current.push(pcmChunk)
        livePcmSampleCountRef.current += pcmChunk.length
      }

      sourceNode.connect(processorNode)
      processorNode.connect(sinkNode)
      sinkNode.connect(audioContext.destination)
      await audioContext.resume()

      liveAudioContextRef.current = audioContext
      liveAudioSourceNodeRef.current = sourceNode
      liveAudioProcessorNodeRef.current = processorNode
      liveAudioSinkNodeRef.current = sinkNode
      setIsLiveListening(true)
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop())
      liveAudioStreamRef.current = null
      throw new Error(
        error instanceof Error
          ? error.message
          : "There was an error starting system audio capture."
      )
    }

    liveAudioFlushIntervalRef.current = window.setInterval(() => {
      void flushLiveAudioChunk().catch((error) => {
        if (!liveAudioStoppingRef.current) {
          console.error("Failed to flush live audio chunk:", error)
          showToast(
            "Live Interview",
            error instanceof Error
              ? error.message
              : "System audio transcription failed.",
            "error"
          )
        }
      })
    }, LIVE_AUDIO_FLUSH_INTERVAL_MS)
  }, [
    float32ToInt16,
    flushLiveAudioChunk,
    requestLiveAudioStream,
    resampleAudio,
    showToast,
    stopLiveAudioCapture,
  ])

  useEffect(() => {
    if (isPersistedMode) {
      let cancelled = false

      const loadThreads = async () => {
        setIsHistoryLoading(true)

        const response = await window.electronAPI.listChatThreads({ mode })
        if (cancelled) {
          return
        }

        if (!response.success) {
          setThreads([])
          setActiveThreadId(null)
          setMessages([])
          setIsHistoryLoading(false)
          showToast("Chat History", response.error, "error")
          return
        }

        setThreads(response.data.threads)
        const nextThreadId = response.data.threads[0]?.id || null
        setActiveThreadId(nextThreadId)
        setIsHistoryLoading(false)
      }

      void loadThreads()

      return () => {
        cancelled = true
      }
    }

    const syncMessages = () => {
      const cachedMessages =
        (queryClient.getQueryData(queryKey) as FollowUpChatMessage[] | undefined) ||
        []
      setMessages(cachedMessages)
    }

    syncMessages()

    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event?.query?.queryKey?.[0] === queryKey[0]) {
        syncMessages()
      }
    })

    return () => {
      unsubscribe()
    }
  }, [isPersistedMode, mode, queryClient, queryKey, showToast])

  useEffect(() => {
    if (!isPersistedMode) {
      return
    }

    let cancelled = false

    const loadLiveState = async () => {
      const response = await window.electronAPI.getLiveInterviewState()
      if (!cancelled && response.success) {
        setLiveState(response.data.state)
      }
    }

    const loadComputerUseState = async () => {
      const response = await window.electronAPI.getComputerUseState()
      if (!cancelled && response.success) {
        setComputerUseState(response.data.state)
      }
    }

    void loadLiveState()
    void loadComputerUseState()

    const unsubscribe = window.electronAPI.onLiveInterviewState((state) => {
      setLiveState(state)
    })
    const unsubscribeComputerUse = window.electronAPI.onComputerUseState((state) => {
      setComputerUseState(state)
    })

    return () => {
      cancelled = true
      unsubscribe()
      unsubscribeComputerUse()
    }
  }, [isPersistedMode])

  useEffect(() => {
    if (!isLiveSessionActive || !liveState.threadId) {
      return
    }

    if (activeThreadId !== liveState.threadId) {
      setActiveThreadId(liveState.threadId)
    }
  }, [activeThreadId, isLiveSessionActive, liveState.threadId])

  useEffect(() => {
    if (!isComputerUseSessionActive || !computerUseState.threadId) {
      return
    }

    if (activeThreadId !== computerUseState.threadId) {
      setActiveThreadId(computerUseState.threadId)
    }
  }, [activeThreadId, computerUseState.threadId, isComputerUseSessionActive])

  useEffect(() => {
    if (!isLiveSessionActive) {
      stopLiveAudioCapture()
    }
  }, [isLiveSessionActive, stopLiveAudioCapture])

  useEffect(() => {
    return () => {
      stopLiveAudioCapture()
    }
  }, [stopLiveAudioCapture])

  useEffect(() => {
    if (!isPersistedMode) {
      return
    }

    if (!activeThreadId) {
      setMessages([])
      return
    }

    let cancelled = false

    const loadMessages = async () => {
      setMessages([])
      setIsMessagesLoading(true)
      const response = await window.electronAPI.getChatMessages({
        threadId: activeThreadId,
      })

      if (cancelled) {
        return
      }

      if (!response.success) {
        setMessages([])
        setIsMessagesLoading(false)
        showToast("Chat History", response.error, "error")
        return
      }

      setMessages(response.data.messages.map(mapPersistedMessage))
      setIsMessagesLoading(false)
    }

    void loadMessages()

    return () => {
      cancelled = true
    }
  }, [activeThreadId, isPersistedMode, showToast])

  useEffect(() => {
    if (!inputRef.current) {
      return
    }

    inputRef.current.style.height = "0px"
    inputRef.current.style.height = `${Math.min(
      inputRef.current.scrollHeight,
      136
    )}px`
  }, [input])

  useEffect(() => {
    if (!computerTaskRequest || !isPersistedMode) {
      return
    }

    if (computerTaskRequest.id === lastComputerTaskRequestIdRef.current) {
      return
    }

    lastComputerTaskRequestIdRef.current = computerTaskRequest.id
    void startComputerUseTask(computerTaskRequest.task)
  }, [computerTaskRequest, isPersistedMode])

  useEffect(() => {
    if (
      !isPersistedMode ||
      !computerUseState.threadId ||
      activeThreadId !== computerUseState.threadId ||
      computerUseState.status === "idle"
    ) {
      return
    }

    let cancelled = false

    const syncComputerThreadMessages = async () => {
      const response = await window.electronAPI.getChatMessages({
        threadId: computerUseState.threadId || "",
      })

      if (cancelled || !response.success) {
        return
      }

      setMessages(response.data.messages.map(mapPersistedMessage))
    }

    void syncComputerThreadMessages()

    return () => {
      cancelled = true
    }
  }, [
    activeThreadId,
    computerUseState.currentAction,
    computerUseState.needsSecretInput,
    computerUseState.status,
    computerUseState.stepCount,
    computerUseState.threadId,
    isPersistedMode,
  ])

  useEffect(() => {
    if (!messagesRef.current) {
      return
    }

    messagesRef.current.scrollTop = messagesRef.current.scrollHeight
  }, [
    messages,
    liveState.latestAnswer,
    liveState.isProcessing,
    liveState.threadId,
    computerUseState.currentAction,
    computerUseState.latestError,
    computerUseState.status,
    computerUseState.threadId,
  ])

  const persistMessages = (nextMessages: FollowUpChatMessage[]) => {
    if (!isPersistedMode) {
      queryClient.setQueryData(queryKey, nextMessages)
    }
    setMessages(nextMessages)
  }

  const refreshThreads = async (preferredThreadId?: string | null) => {
    if (!isPersistedMode) {
      return
    }

    const response = await window.electronAPI.listChatThreads({ mode })
    if (!response.success) {
      throw new Error(response.error)
    }

    setThreads(response.data.threads)
    if (preferredThreadId) {
      const matchedThread = response.data.threads.find(
        (thread) => thread.id === preferredThreadId
      )
      if (matchedThread) {
        setActiveThreadId(matchedThread.id)
        return
      }
    }

    setActiveThreadId(response.data.threads[0]?.id || null)
  }

  const loadMessagesForThread = async (threadId: string) => {
    const response = await window.electronAPI.getChatMessages({ threadId })
    if (!response.success) {
      throw new Error(response.error)
    }

    setMessages(response.data.messages.map(mapPersistedMessage))
  }

  const upsertThread = (thread: ChatThreadSummary) => {
    setThreads((previousThreads) => [
      thread,
      ...previousThreads.filter((entry) => entry.id !== thread.id),
    ])
  }

  const startNewChat = () => {
    if (isSending || isLiveSessionActive) {
      return
    }

    setActiveThreadId(null)
    setMessages([])
  }

  const startLiveInterview = async () => {
    if (!isPersistedMode || isLiveSessionActive || isLiveActionPending) {
      return
    }

    setIsLiveActionPending(true)
    let startedLiveSession = false
    let initialStream: MediaStream | null = null
    try {
      initialStream = await requestLiveAudioStream()

      const response = await window.electronAPI.startLiveInterview()
      if (!response.success) {
        throw new Error(response.error)
      }

      startedLiveSession = true
      upsertThread(response.data.thread)
      setActiveThreadId(response.data.thread.id)
      setMessages([])
      setLiveState(response.data.state)
      await startLiveAudioCapture(initialStream)
      initialStream = null
    } catch (error) {
      if (startedLiveSession) {
        await window.electronAPI.stopLiveInterview()
      }
      if (initialStream) {
        initialStream.getTracks().forEach((track) => track.stop())
      }
      stopLiveAudioCapture()
      showToast(
        "Live Interview",
        getLiveAudioErrorMessage(error),
        "error"
      )
    } finally {
      setIsLiveActionPending(false)
    }
  }

  const stopLiveInterview = async () => {
    if (!isPersistedMode || !isLiveSessionActive || isLiveActionPending) {
      return
    }

    const liveThreadId = liveState.threadId
    setIsLiveActionPending(true)
    try {
      stopLiveAudioCapture()
      const response = await window.electronAPI.stopLiveInterview()
      if (!response.success) {
        throw new Error(response.error)
      }

      setLiveState(response.data.state)

      if (liveThreadId) {
        await refreshThreads(liveThreadId)
        await loadMessagesForThread(liveThreadId)
        setActiveThreadId(liveThreadId)
      }
    } catch (error) {
      showToast(
        "Live Interview",
        error instanceof Error ? error.message : "Failed to stop Live Interview.",
        "error"
      )
    } finally {
      setIsLiveActionPending(false)
    }
  }

  const startComputerUseTask = async (task: string) => {
    if (
      !isPersistedMode ||
      isLiveSessionActive ||
      isComputerUseSessionActive ||
      isComputerUseActionPending
    ) {
      return
    }

    const normalizedTask = task.trim()
    if (!normalizedTask) {
      return
    }

    setIsComputerUseActionPending(true)
    try {
      const response = await window.electronAPI.startComputerUseTask({
        task: normalizedTask,
      })

      if (!response.success) {
        throw new Error(response.error)
      }

      upsertThread(response.data.thread)
      setActiveThreadId(response.data.thread.id)
      setComputerUseState(response.data.state)
      await refreshThreads(response.data.thread.id)
      await loadMessagesForThread(response.data.thread.id)
    } catch (error) {
      showToast(
        "Computer Use",
        error instanceof Error
          ? error.message
          : "Failed to start browser task.",
        "error"
      )
    } finally {
      setIsComputerUseActionPending(false)
    }
  }

  const stopComputerUseTask = async () => {
    if (!isPersistedMode || !isComputerUseSessionActive || isComputerUseActionPending) {
      return
    }

    const threadId = computerUseState.threadId
    setIsComputerUseActionPending(true)
    try {
      const response = await window.electronAPI.stopComputerUseTask()
      if (!response.success) {
        throw new Error(response.error)
      }

      setComputerUseState(response.data.state)
      if (threadId) {
        await refreshThreads(threadId)
        await loadMessagesForThread(threadId)
        setActiveThreadId(threadId)
      }
    } catch (error) {
      showToast(
        "Computer Use",
        error instanceof Error ? error.message : "Failed to stop browser task.",
        "error"
      )
    } finally {
      setIsComputerUseActionPending(false)
    }
  }

  const resumeComputerUseTask = async () => {
    if (
      !isPersistedMode ||
      !isComputerUseSessionActive ||
      !computerUseState.needsSecretInput ||
      isComputerUseActionPending
    ) {
      return
    }

    setIsComputerUseActionPending(true)
    try {
      const response = await window.electronAPI.resumeComputerUseAfterSecret()
      if (!response.success) {
        throw new Error(response.error)
      }

      setComputerUseState(response.data.state)
    } catch (error) {
      showToast(
        "Computer Use",
        error instanceof Error ? error.message : "Failed to resume browser task.",
        "error"
      )
    } finally {
      setIsComputerUseActionPending(false)
    }
  }

  const submitMessage = async (rawMessage?: string) => {
    const trimmedInput = (rawMessage ?? input).trim()
    if (!trimmedInput || isSending) {
      return
    }

    const activePersistedThread = threads.find((thread) => thread.id === activeThreadId)
    if (activePersistedThread?.mode === "computer_use") {
      showToast(
        "Computer Use",
        isComputerUseSessionActive
          ? "Use the browser task controls while the task is running."
          : "Start a new browser task from the computer icon in the widget strip.",
        "neutral"
      )
      return
    }

    if (mode === "follow_up" && !currentContext.trim()) {
      showToast(
        "No Answer Yet",
        "Generate an answer first, then ask a follow-up question.",
        "neutral"
      )
      return
    }

    const userMessage: FollowUpChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: trimmedInput,
      createdAt: Date.now(),
    }
    const pendingAssistantMessage: FollowUpChatMessage = {
      id: `assistant-${Date.now()}`,
      role: "assistant",
      content: "Thinking...",
      createdAt: Date.now(),
      pending: true,
    }

    if (isPersistedMode && isLiveSessionActive) {
      const optimisticMessages = [...messages, userMessage]
      persistMessages(optimisticMessages)
      setInput("")
      setIsSending(true)

      try {
        const response = await window.electronAPI.addLiveInterviewInstruction({
          content: trimmedInput,
        })

        if (!response.success) {
          throw new Error(response.error)
        }

        upsertThread(response.data.thread)
        setActiveThreadId(response.data.thread.id)
        setLiveState(response.data.state)
        persistMessages(
          optimisticMessages.map((message) =>
            message.id === userMessage.id
              ? mapPersistedMessage(response.data.message)
              : message
          )
        )
      } catch (error) {
        persistMessages(messages)
        showToast(
          "Live Interview",
          error instanceof Error
            ? error.message
            : "Failed to send the live instruction.",
          "error"
        )
      } finally {
        setIsSending(false)
      }

      return
    }

    const nextMessages = [...messages, userMessage, pendingAssistantMessage]
    persistMessages(nextMessages)
    setInput("")
    setIsSending(true)

    try {
      let threadId = activeThreadId
      if (isPersistedMode && !threadId) {
        const threadResponse = await window.electronAPI.createChatThread({
          mode,
          title: buildThreadTitle(trimmedInput),
        })

        if (!threadResponse.success) {
          throw new Error(threadResponse.error)
        }

        const nextThread = threadResponse.data.thread
        threadId = nextThread.id
        upsertThread(nextThread)
        setActiveThreadId(nextThread.id)
      }

      const chatHistory: FollowUpChatTurn[] = messages
        .filter((message) => !message.pending)
        .map((message) => ({
          role: message.role,
          content: message.content,
        }))
        .slice(-12)

      if (isPersistedMode && threadId) {
        const saveUserMessage = await window.electronAPI.appendChatMessage({
          threadId,
          role: "user",
          content: trimmedInput,
        })

        if (!saveUserMessage.success) {
          throw new Error(saveUserMessage.error)
        }
      }

      const response = await window.electronAPI.submitTextFollowUp({
        message: trimmedInput,
        currentContext,
        chatHistory,
        mode,
      })

      if (!response.success) {
        throw new Error(response.error)
      }

      if (isPersistedMode && threadId) {
        const saveAssistantMessage = await window.electronAPI.appendChatMessage({
          threadId,
          role: "assistant",
          content: response.data.reply,
        })

        if (!saveAssistantMessage.success) {
          throw new Error(saveAssistantMessage.error)
        }

        await refreshThreads(threadId)
        await loadMessagesForThread(threadId)
        return
      }

      const resolvedMessages = nextMessages.map((message) =>
        message.id === pendingAssistantMessage.id
          ? {
              ...message,
              content: response.data.reply,
              pending: false,
            }
          : message
      )

      persistMessages(resolvedMessages)
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to generate a response."
      const failedMessages = nextMessages.map((entry) =>
        entry.id === pendingAssistantMessage.id
          ? {
              ...entry,
              content: message,
              pending: false,
              error: true,
            }
          : entry
      )

      persistMessages(failedMessages)
      showToast(mode === "general" ? "Chat Failed" : "Follow-up Failed", message, "error")
    } finally {
      setIsSending(false)
    }
  }

  const surfaceClassName = className.trim().length
    ? `w-full min-w-0 space-y-3 rounded-[20px] border border-white/10 bg-[linear-gradient(180deg,rgba(14,16,18,0.92),rgba(8,10,12,0.82))] p-3 text-white shadow-[0_20px_44px_rgba(0,0,0,0.35)] ${className}`
    : "w-full min-w-0 space-y-3 rounded-[20px] border border-white/10 bg-[linear-gradient(180deg,rgba(14,16,18,0.92),rgba(8,10,12,0.82))] p-3 text-white shadow-[0_20px_44px_rgba(0,0,0,0.35)]"

  const activePersistedThread = threads.find((thread) => thread.id === activeThreadId) || null
  const isSelectedComputerThread = activePersistedThread?.mode === "computer_use"

  const displayedMessages = useMemo(() => {
    if (!isPersistedMode) {
      return messages
    }

    const nextMessages = [...messages]

    if (isLiveSessionActive && activeThreadId === liveState.threadId) {
      nextMessages.push({
        id: `live-answer-${liveState.threadId}`,
        role: "assistant" as const,
        content: buildLiveSuggestionPlaceholder(liveState, isLiveListening),
        createdAt: toMessageTimestamp(
          liveState.lastUpdatedAt || liveState.startedAt || undefined
        ),
        pending: liveState.isProcessing,
      })
    }

    if (isComputerUseSessionActive && activeThreadId === computerUseState.threadId) {
      nextMessages.push({
        id: `computer-use-${computerUseState.threadId}`,
        role: "assistant" as const,
        content: buildComputerUsePlaceholder(computerUseState),
        createdAt: Date.now(),
        pending: computerUseState.status === "starting" || computerUseState.status === "running",
      })
    }

    return nextMessages
  }, [
    activeThreadId,
    computerUseState.currentAction,
    computerUseState.currentUrl,
    computerUseState.latestError,
    computerUseState.needsSecretInput,
    computerUseState.status,
    computerUseState.threadId,
    isLiveSessionActive,
    isComputerUseSessionActive,
    isPersistedMode,
    liveState.isProcessing,
    liveState.lastUpdatedAt,
    liveState.latestAnswer,
    liveState.latestTranscript,
    liveState.startedAt,
    liveState.threadId,
    messages,
    isLiveListening,
  ])

  const liveStatusLabel = (() => {
    if (!isLiveSessionActive) {
      return "System audio helper"
    }

    if (liveState.status === "starting") {
      return "Starting live interview..."
    }

    if (liveState.status === "stopping") {
      return "Stopping live interview..."
    }

    if (!isLiveListening) {
      return "Waiting for interviewer audio..."
    }

    if (liveState.isProcessing) {
      return "Listening and updating..."
    }

    return "Listening to interviewer audio..."
  })()

  const livePreviewLabel =
    liveState.latestTranscript.trim() ||
    (isLiveSessionActive
      ? "Listening for the interviewer question."
      : "Captures computer audio and updates answers live.")

  const computerStatusLabel = (() => {
    if (!isComputerUseSessionActive) {
      return "Browser task helper"
    }

    if (computerUseState.status === "starting") {
      return "Starting browser task..."
    }

    if (computerUseState.status === "stopping") {
      return "Stopping browser task..."
    }

    if (computerUseState.status === "waiting_for_secret") {
      return "Waiting for manual login..."
    }

    return computerUseState.currentAction || "Running browser task..."
  })()

  const computerPreviewLabel =
    computerUseState.currentUrl.trim() ||
    (computerUseState.needsSecretInput
      ? "Complete the secret step in Chrome, then continue."
      : "Launch browser automation from the computer icon in the widget strip.")

  const threadButtonsDisabled =
    isSending || isLiveSessionActive || isComputerUseSessionActive
  const inputPlaceholder =
    isLiveSessionActive && isPersistedMode
      ? "Add a live instruction..."
      : isSelectedComputerThread
        ? "Start a new browser task from the computer icon."
        : placeholder

  return (
    <div className={surfaceClassName}>
      {isPersistedMode && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 overflow-x-auto pb-1 text-[11px] [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <button
              type="button"
              onClick={startNewChat}
              disabled={threadButtonsDisabled}
              className={`shrink-0 rounded-full border px-2.5 py-1 transition ${
                activeThreadId === null
                  ? "border-[#7df9c7]/35 bg-[#17362d] text-white"
                  : "border-white/10 bg-black/40 text-white/70 hover:text-white"
              } ${threadButtonsDisabled ? "cursor-not-allowed opacity-60" : ""}`}
            >
              New
            </button>

            {threads.map((thread) => (
              <button
                key={thread.id}
                type="button"
                onClick={() => {
                  if (!threadButtonsDisabled) {
                    setActiveThreadId(thread.id)
                  }
                }}
                disabled={threadButtonsDisabled}
                className={`shrink-0 rounded-full border px-2.5 py-1 transition ${
                  thread.id === activeThreadId
                    ? "border-[#7df9c7]/35 bg-[#17362d] text-white"
                    : "border-white/10 bg-black/40 text-white/70 hover:text-white"
                } ${threadButtonsDisabled ? "cursor-not-allowed opacity-60" : ""}`}
                title={thread.title}
              >
                <span className="inline-flex items-center gap-1.5">
                  {thread.mode === "live_interview" && (
                    <span className="rounded-full border border-[#7df9c7]/20 bg-[#17362d] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] text-[#baf7df]">
                      Live
                    </span>
                  )}
                  {thread.mode === "computer_use" && (
                    <span className="rounded-full border border-sky-300/20 bg-sky-300/10 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] text-sky-100">
                      Comp
                    </span>
                  )}
                  <span>{getThreadLabel(thread)}</span>
                </span>
              </button>
            ))}

            {isHistoryLoading && (
              <div className="shrink-0 text-white/40">Loading...</div>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 rounded-[14px] border border-white/10 bg-black/35 px-3 py-2 text-[10px] text-white/62">
            <div className="min-w-0 flex-1">
              <div className="truncate">{liveStatusLabel}</div>
              <div className="truncate text-[9px] text-white/42">
                {livePreviewLabel}
              </div>
            </div>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                void (isLiveSessionActive ? stopLiveInterview() : startLiveInterview())
              }}
              disabled={isLiveActionPending || isSending || isHistoryLoading}
              className={`h-6 rounded-full px-2.5 text-[10px] ${
                isLiveSessionActive
                  ? "bg-white/10 text-white hover:bg-white/15"
                  : "bg-[#7df9c7] text-black hover:bg-[#97ffd3]"
              }`}
            >
              {isLiveActionPending
                ? "..."
                : isLiveSessionActive
                  ? "Stop Live"
                  : "Start Live"}
            </Button>
          </div>

          {(isComputerUseSessionActive || isSelectedComputerThread) && (
            <div className="flex items-center justify-between gap-2 rounded-[14px] border border-sky-300/15 bg-sky-300/10 px-3 py-2 text-[10px] text-white/72">
              <div className="min-w-0 flex-1">
                <div className="truncate">{computerStatusLabel}</div>
                <div className="truncate text-[9px] text-white/42">
                  {computerPreviewLabel}
                </div>
              </div>
              {isComputerUseSessionActive ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    void (
                      computerUseState.needsSecretInput
                        ? resumeComputerUseTask()
                        : stopComputerUseTask()
                    )
                  }}
                  disabled={isComputerUseActionPending || isSending || isHistoryLoading}
                  className="h-6 rounded-full bg-white/10 px-2.5 text-[10px] text-white hover:bg-white/15"
                >
                  {isComputerUseActionPending
                    ? "..."
                    : computerUseState.needsSecretInput
                      ? "Continue"
                      : "Stop"}
                </Button>
              ) : (
                <div className="rounded-full border border-white/10 px-2 py-1 text-[9px] text-white/45">
                  History
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {displayedMessages.length > 0 && (
        <div
          ref={messagesRef}
          className={`${maxHeightClassName} space-y-2 overflow-y-auto pr-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden`}
        >
          {displayedMessages.map((message) => {
            const isLiveSuggestionMessage =
              message.id === `live-answer-${liveState.threadId || ""}`
            const isComputerUseMessage =
              message.id === `computer-use-${computerUseState.threadId || ""}`

            return (
              <div
                key={message.id}
                style={
                  {
                    "--sylica-message-index": Math.min(index, 5),
                  } as React.CSSProperties
                }
                className={`flex ${
                  message.role === "user" ? "justify-end" : "justify-start"
                } sylica-message-enter`}
              >
                <div
                  className={`min-w-0 break-words ${
                    isLiveSuggestionMessage || isComputerUseMessage
                      ? "max-w-[96%]"
                      : "max-w-[92%]"
                  } space-y-1.5 rounded-[16px] ${
                    isLiveSuggestionMessage
                      ? "border border-[#7df9c7]/20 bg-[linear-gradient(180deg,rgba(19,44,37,0.92),rgba(8,12,11,0.92))] px-2.5 py-2 text-white"
                      : isComputerUseMessage
                        ? "border border-sky-300/20 bg-[linear-gradient(180deg,rgba(17,36,56,0.92),rgba(8,12,20,0.92))] px-2.5 py-2 text-white"
                      : message.role === "user"
                        ? "border border-[#7df9c7]/25 bg-[#17362d] px-3 py-2.5 text-white"
                        : message.error
                          ? "border border-red-500/20 bg-red-500/10 px-3 py-2.5 text-red-100"
                          : "border border-white/10 bg-black/60 px-3 py-2.5 text-white/[0.92]"
                  } ${message.pending ? "opacity-75" : ""}`}
                >
                  {isLiveSuggestionMessage && (
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 text-[9px] uppercase tracking-[0.14em] text-[#baf7df]">
                        <span className="rounded-full border border-[#7df9c7]/20 bg-[#17362d] px-1.5 py-0.5">
                          Live Suggestion
                        </span>
                        <span className="text-white/38">
                          {liveState.isProcessing ? "Updating" : "Ready"}
                        </span>
                      </div>
                      {liveState.latestTranscript.trim() && (
                        <div className="max-h-[2.4rem] overflow-hidden text-[9.5px] leading-4 text-white/42">
                          {liveState.latestTranscript.trim()}
                        </div>
                      )}
                    </div>
                  )}
                  {isComputerUseMessage && (
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 text-[9px] uppercase tracking-[0.14em] text-sky-100">
                        <span className="rounded-full border border-sky-300/20 bg-sky-300/10 px-1.5 py-0.5">
                          Computer Use
                        </span>
                        <span className="text-white/38">
                          {computerUseState.needsSecretInput ? "Paused" : "Running"}
                        </span>
                      </div>
                      {computerUseState.currentUrl.trim() && (
                        <div className="max-h-[2.4rem] overflow-hidden text-[9.5px] leading-4 text-white/42">
                          {computerUseState.currentUrl.trim()}
                        </div>
                      )}
                    </div>
                  )}
                  {renderMessageContent(
                    message.content,
                    isLiveSuggestionMessage || isComputerUseMessage
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {isPersistedMode && isMessagesLoading && displayedMessages.length === 0 && (
        <div className="text-[11px] text-white/40">Loading chat...</div>
      )}

      <div className="flex items-end gap-2 rounded-[16px] border border-white/10 bg-black/[0.65] px-3 py-2">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              if (!isSelectedComputerThread) {
                void submitMessage()
              }
            }
          }}
          rows={1}
          placeholder={inputPlaceholder}
          disabled={isSelectedComputerThread}
          className="max-h-[136px] min-h-[24px] flex-1 resize-none bg-transparent py-1 text-[12px] leading-[1.45] text-white outline-none placeholder:text-white/28"
        />
        <Button
          type="button"
          size="icon"
          onClick={() => {
            void submitMessage()
          }}
          disabled={isSending || input.trim().length === 0 || isSelectedComputerThread}
          title={
            isLiveSessionActive
              ? "Send live instruction"
              : mode === "general"
                ? "Send message"
                : "Send follow-up"
          }
          aria-label={
            isLiveSessionActive
              ? "Send live instruction"
              : mode === "general"
                ? "Send message"
                : "Send follow-up"
          }
          className="sylica-send-button h-9 w-9 rounded-full bg-[#7df9c7] text-black hover:bg-[#97ffd3]"
        >
          {isSending ? "..." : <SendHorizontal className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  )
}
