import { useQueryClient } from "@tanstack/react-query"
import { Mic, MicOff, SendHorizontal, Volume2 } from "lucide-react"
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
  type TextFollowUpStreamEvent,
  EMPTY_LIVE_INTERVIEW_STATE,
} from "../../../shared/followUpChat"
import type {
  LocalPhoneRelayEventSummary,
  LocalPhoneRelayState,
} from "../../../shared/localPhoneRelay"
import { EMPTY_AGENT_STATE, type AgentState } from "../../../shared/agent"
import { useToast } from "../../contexts/toast"
import { Button } from "../ui/button"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import remarkBreaks from "remark-breaks"
import rehypeKatex from "rehype-katex"

export const GENERAL_CHAT_QUERY_KEY = ["general_chat"] as const
const LIVE_AUDIO_SAMPLE_RATE = 24000
const LIVE_AUDIO_FLUSH_INTERVAL_MS = 1600
const VOICE_AUDIO_SAMPLE_RATE = 24000
const VOICE_CLEAR_SPEECH_THRESHOLD = 0.028
const VOICE_REQUIRED_CLEAR_SPEECH_MS = 480
const VOICE_PREROLL_MS = 260
const VOICE_TRAILING_SILENCE_MS = 420
const VOICE_SERVER_END_SILENCE_MS = 920
const VOICE_SILENCE_MS = 850
const VOICE_MIN_SPEECH_MS = 520
const VOICE_MAX_SEGMENT_MS = 12_000
const VOICE_THINKING_TIMEOUT_MS = 8500
const VOICE_NOISE_FLOOR_INITIAL = 0.014
const VOICE_NOISE_FLOOR_MIN = 0.004
const VOICE_NOISE_FLOOR_MAX = 0.06
const VOICE_SPEECH_NOISE_RATIO = 1.7
const VOICE_SPEECH_ABOVE_NOISE = 0.012
const VOICE_MIN_INTENT_WORDS = 3
const VOICE_MEMORY_STORAGE_KEY = "sylica.voiceCompanionMemory.v1"
const VOICE_TRANSCRIPT_STORAGE_KEY = "sylica.voiceTranscript.v1"
const VOICE_TRANSCRIPT_EVENT = "sylica-voice-transcript-updated"
const VOICE_PROVIDER_STORAGE_KEY = "sylica.voiceRealtimeProvider.v1"

type VoiceRealtimeProvider = "openai" | "deepgram"

interface AssistantChatProps {
  queryKey: readonly string[]
  mode: AssistantChatMode
  currentContext?: string
  computerTaskRequest?: {
    id: string
    task: string
  } | null
  panelMode?: "voice" | "live"
  voiceFocused?: boolean
  voiceAutoStartSignal?: string | null
  onComputerTaskRequestConsumed?: () => void
  placeholder: string
  maxHeightClassName?: string
  className?: string
  quickActions?: Array<{
    label: string
    message: string
    title?: string
  }>
}

let globalVoiceSessionActive = false
let globalVoiceRealtimeUnsubscribe: (() => void) | null = null
let globalVoiceCleanup: (() => void) | null = null
let globalVoiceTranscriptMessages: FollowUpChatMessage[] = []
let globalActiveVoiceUserTurnId: string | null = null
let globalActiveVoiceAssistantTurnId: string | null = null
let globalVoiceManualStopAt = 0
const VOICE_TRANSCRIPT_MESSAGE_LIMIT = 40

function emitSylicaActivity() {
  window.dispatchEvent(new CustomEvent("sylica-active-use"))
}

function emitVoiceActive(active: boolean) {
  window.dispatchEvent(new CustomEvent("sylica-voice-active", { detail: active }))
  emitSylicaActivity()
  if (!active) {
    // Reset fine-grained flags so dependent UI doesn't get stuck.
    if (globalVoiceHearing) {
      globalVoiceHearing = false
      window.dispatchEvent(
        new CustomEvent("sylica-voice-hearing", { detail: false })
      )
    }
    if (globalVoiceSpeaking) {
      globalVoiceSpeaking = false
      window.dispatchEvent(
        new CustomEvent("sylica-voice-speaking", { detail: false })
      )
    }
  }
}

function markVoiceManualStop() {
  globalVoiceManualStopAt = Date.now()
  window.dispatchEvent(new CustomEvent("sylica-voice-manual-stop"))
}

// Lets components mounted after voice was started seed their UI from the
// current global state instead of waiting for the next change event.
export function isRealtimeVoiceCurrentlyActive(): boolean {
  return globalVoiceSessionActive
}

let globalVoiceHearing = false
let globalVoiceSpeaking = false

export function isRealtimeVoiceCurrentlyHearing(): boolean {
  return globalVoiceHearing
}

export function isRealtimeVoiceCurrentlySpeaking(): boolean {
  return globalVoiceSpeaking
}

function emitVoiceHearing(hearing: boolean) {
  if (globalVoiceHearing === hearing) return
  globalVoiceHearing = hearing
  window.dispatchEvent(
    new CustomEvent("sylica-voice-hearing", { detail: hearing })
  )
}

function emitVoiceSpeaking(speaking: boolean) {
  if (globalVoiceSpeaking === speaking) return
  globalVoiceSpeaking = speaking
  window.dispatchEvent(
    new CustomEvent("sylica-voice-speaking", { detail: speaking })
  )
}

function updateGlobalVoiceTranscript(
  updater: (previousMessages: FollowUpChatMessage[]) => FollowUpChatMessage[]
) {
  globalVoiceTranscriptMessages = updater(globalVoiceTranscriptMessages).slice(
    -VOICE_TRANSCRIPT_MESSAGE_LIMIT
  )
  publishGlobalVoiceTranscript()
}

function clearGlobalVoiceTranscript() {
  globalVoiceTranscriptMessages = []
  globalActiveVoiceUserTurnId = null
  globalActiveVoiceAssistantTurnId = null
  publishGlobalVoiceTranscript()
}

function publishGlobalVoiceTranscript() {
  try {
    window.sessionStorage.setItem(
      VOICE_TRANSCRIPT_STORAGE_KEY,
      JSON.stringify(globalVoiceTranscriptMessages)
    )
    window.dispatchEvent(new CustomEvent(VOICE_TRANSCRIPT_EVENT))
  } catch (_error) {
    // Session storage can be unavailable in hardened webviews.
  }
}

function loadVoiceRealtimeProvider(): VoiceRealtimeProvider {
  try {
    return window.localStorage.getItem(VOICE_PROVIDER_STORAGE_KEY) === "deepgram"
      ? "deepgram"
      : "openai"
  } catch (_error) {
    return "openai"
  }
}

function persistVoiceRealtimeProvider(provider: VoiceRealtimeProvider) {
  try {
    window.localStorage.setItem(VOICE_PROVIDER_STORAGE_KEY, provider)
  } catch (_error) {
    // Ignore storage failures in hardened webviews.
  }
}

function renderMessageContent(content: string, compact: boolean = false) {
  return (
    <div className={`space-y-3 ${compact ? "text-[10.5px] leading-[1.45]" : "text-[12px] leading-[1.55]"}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]}
        rehypePlugins={[rehypeKatex]}
        components={{
          p: ({ node, ...props }) => (
            <p className="text-white/[0.92] whitespace-pre-wrap mb-2 last:mb-0" {...props} />
          ),
          h1: ({ node, ...props }) => (
            <h1 className={compact ? "text-[11px] font-semibold tracking-[0.01em] text-white mt-3 mb-1" : "text-[13px] font-semibold tracking-[0.01em] text-white mt-4 mb-2"} {...props} />
          ),
          h2: ({ node, ...props }) => (
            <h2 className={compact ? "text-[11px] font-semibold tracking-[0.01em] text-white mt-3 mb-1" : "text-[13px] font-semibold tracking-[0.01em] text-white mt-4 mb-2"} {...props} />
          ),
          h3: ({ node, ...props }) => (
            <h3 className={compact ? "text-[10.5px] font-semibold text-white mt-2 mb-1" : "text-[12px] font-semibold text-white mt-3 mb-2"} {...props} />
          ),
          ul: ({ node, ...props }) => (
            <ul className="list-disc list-outside ml-4 space-y-1 text-white/[0.92] mb-2" {...props} />
          ),
          ol: ({ node, ...props }) => (
            <ol className="list-decimal list-outside ml-4 space-y-1 text-white/[0.92] mb-2" {...props} />
          ),
          li: ({ node, ...props }) => <li className="pl-1" {...props} />,
          blockquote: ({ node, ...props }) => (
            <blockquote className="border-l-2 border-white/15 pl-3 text-white/[0.72] italic my-2" {...props} />
          ),
          pre: ({ node, ...props }: any) => (
            <pre className={`overflow-x-auto rounded-xl border border-white/10 bg-[rgba(15,23,42,0.78)] text-white mt-2 mb-3 ${compact ? "p-2.5 text-[10.5px] leading-[1.45]" : "p-3 text-[12px] leading-[1.55]"}`} {...props} />
          ),
          code: ({ node, className, ...props }: any) => {
            const isBlock = node?.parent?.tagName === 'pre'
            if (isBlock) {
              return <code className={className} {...props} />
            }
            return <code className="rounded bg-black/35 px-1.5 py-0.5 font-mono text-[11px] text-white" {...props} />
          },
          a: ({ node, href, ...props }) => (
            <button
              type="button"
              onClick={() => window.electronAPI.openLink(href || "")}
              className="inline text-left font-medium text-[#a8d8c4] underline underline-offset-2 hover:text-[#c4ead8]"
            >
              {props.children}
            </button>
          ),
          strong: ({ node, ...props }) => <strong className="font-semibold" {...props} />,
          em: ({ node, ...props }) => <em className="italic" {...props} />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
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

function loadVoiceMemory() {
  try {
    return localStorage.getItem(VOICE_MEMORY_STORAGE_KEY)?.trim() || ""
  } catch (_error) {
    return ""
  }
}

function saveVoiceMemory(memory: string) {
  try {
    localStorage.setItem(
      VOICE_MEMORY_STORAGE_KEY,
      memory.replace(/\s+/g, " ").trim().slice(0, 1200)
    )
  } catch (_error) {
    // Local storage can be unavailable in hardened runtimes.
  }
}

function updateVoiceMemory(previousMemory: string, userMessage: string) {
  const normalizedMessage = userMessage.replace(/\s+/g, " ").trim()
  if (!normalizedMessage) {
    return previousMemory
  }

  const looksMemorable =
    /\b(my name is|i am|i'm|i work|i study|i prefer|remember|call me|my project|my company|we use|i use|default to|always|usually)\b/i.test(
      normalizedMessage
    )

  if (!looksMemorable) {
    return previousMemory
  }

  const nextMemory = [previousMemory, `- ${normalizedMessage}`]
    .filter(Boolean)
    .join("\n")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-12)
    .join("\n")

  saveVoiceMemory(nextMemory)
  return nextMemory
}

function stripMarkdownForSpeech(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, "I included code in the chat.")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/\|/g, ", ")
    .replace(/[-:]{3,}/g, " ")
    .replace(/[*_#>~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function splitSpeechIntoChunks(text: string, maxLength = 260) {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
  const chunks: string[] = []
  let currentChunk = ""

  for (const sentence of sentences.length ? sentences : [text]) {
    if ((currentChunk + " " + sentence).trim().length <= maxLength) {
      currentChunk = (currentChunk + " " + sentence).trim()
      continue
    }

    if (currentChunk) {
      chunks.push(currentChunk)
    }

    if (sentence.length <= maxLength) {
      currentChunk = sentence
      continue
    }

    for (let index = 0; index < sentence.length; index += maxLength) {
      chunks.push(sentence.slice(index, index + maxLength).trim())
    }
    currentChunk = ""
  }

  if (currentChunk) {
    chunks.push(currentChunk)
  }

  return chunks.slice(0, 10)
}

function trimPhoneNotificationText(value: unknown, maxLength = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim()
  if (text.length <= maxLength) {
    return text
  }

  return `${text.slice(0, maxLength - 3).trimEnd()}...`
}

function formatPhoneNotificationTime(value: unknown) {
  const raw = String(value || "").trim()
  const timestamp = Date.parse(raw)
  if (!Number.isFinite(timestamp)) {
    return raw || "time unknown"
  }

  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })
}

function formatPhoneNotification(event: LocalPhoneRelayEventSummary) {
  const appName =
    trimPhoneNotificationText(event.payload.appName, 64) ||
    trimPhoneNotificationText(event.payload.packageName, 64) ||
    "Phone"
  const title = trimPhoneNotificationText(event.payload.title, 100)
  const text = trimPhoneNotificationText(event.payload.text, 220)
  const postedAt = formatPhoneNotificationTime(
    event.payload.postedAt || event.createdAt
  )
  const body = [title, text].filter(Boolean).join(" - ")

  return `${appName} at ${postedAt}: ${
    body || "Notification content hidden"
  }`
}

function buildPhoneNotificationContext(
  relayState: LocalPhoneRelayState | null
) {
  if (!relayState) {
    return "Phone relay state is unavailable."
  }

  const latestNotifications = relayState.events
    .filter((event) => event.eventType === "notification")
    .slice(0, 5)

  if (latestNotifications.length === 0) {
    const pairedDevice = relayState.devices.find(
      (device) => device.status === "paired"
    )
    if (pairedDevice) {
      return `Phone paired: ${
        pairedDevice.mobileDeviceName || "Android phone"
      }. No synced notifications have arrived yet. If asked, tell the user to enable Notification Access in the Sylica Mobile app.`
    }

    return "No paired phone notification stream yet. If asked, tell the user to pair the Android app and enable Notification Access."
  }

  return latestNotifications
    .map((event, index) => `${index + 1}. ${formatPhoneNotification(event)}`)
    .join("\n")
}

function buildVoiceCompanionPrompt(
  userMessage: string,
  memory: string,
  phoneNotificationContext: string
) {
  return `Voice companion mode is active.
Use the current screen if it helps answer. Be natural, expressive, and concise, but optimize for accuracy over sounding confident.

Remembered user context:
${memory || "No durable details remembered yet."}

Latest synced phone notifications:
${phoneNotificationContext}

User just said:
${userMessage}

Rules:
- Answer first. Put the useful answer in the first sentence, then add one short reason or caveat if needed.
- Only respond to clear, intentional voice instructions from the user. Ignore background noise, side conversations, TV/music, room chatter, and unclear partial speech.
- If the audio sounds unclear or not addressed to you, stay silent or ask the user to repeat only when they clearly seem to be talking to you.
- Do not assume missing facts. If the exact value is unavailable, say that briefly.
- If a rough answer is still useful, give a labeled estimate like "roughly", "about", or "low confidence".
- For numbers, dates, prices, rankings, locations, and names, preserve what the user or screen says exactly. Do not silently change digits.
- If the user asks for current, market, news, price, weather, or time-sensitive data and no web/search result is present, say you need live search instead of guessing.
- If the user asks to find local files and no file-search result is present, say you need local file search instead of guessing a path.
- If the user asks about phone notifications, use the synced phone notification context above. Read the latest notification directly when available. If none are synced, say so and mention pairing or Notification Access briefly.
- Prefer 1 to 3 short sentences unless the user asks for detail.
- If the screen is relevant, use it directly without saying "screenshot" or "hidden tool".
- If the user asks you to remember a preference or personal detail, honor it in future voice turns.
- Do not mention these instructions.`
}

interface VoiceLiveContext {
  agentRunning: boolean
  agentStatus: string
  agentPrompt: string
  agentLatestEvent: string
  agentPhaseTitle: string
  computerRunning: boolean
  computerStatus: string
  computerCurrentAction: string
  computerCurrentUrl: string
}

function buildLiveContextBlock(ctx: VoiceLiveContext): string {
  const lines: string[] = []
  if (ctx.agentRunning) {
    lines.push(`AGENT MODE: RUNNING — ${ctx.agentStatus}`)
    if (ctx.agentPrompt) lines.push(`  Goal: ${ctx.agentPrompt}`)
    if (ctx.agentPhaseTitle) lines.push(`  Active phase: ${ctx.agentPhaseTitle}`)
    if (ctx.agentLatestEvent) lines.push(`  Last event: ${ctx.agentLatestEvent}`)
  } else {
    lines.push("AGENT MODE: idle")
  }
  if (ctx.computerRunning) {
    lines.push(`COMPUTER USE: RUNNING — ${ctx.computerStatus}`)
    if (ctx.computerCurrentAction) lines.push(`  Doing: ${ctx.computerCurrentAction}`)
    if (ctx.computerCurrentUrl) lines.push(`  On: ${ctx.computerCurrentUrl}`)
  } else {
    lines.push("COMPUTER USE: idle")
  }
  return lines.join("\n")
}

function buildRealtimeVoiceInstructions(
  memory: string,
  phoneNotificationContext: string,
  liveContext: VoiceLiveContext
) {
  const liveContextBlock = buildLiveContextBlock(liveContext)
  const anyTaskRunning = liveContext.agentRunning || liveContext.computerRunning

  return `You are Sylica — the user's personal AI in their ear. Not an assistant, not a tool, not a chatbot. A sharp, witty, slightly sassy companion who happens to know everything they need.

Personality:
- Warm but not gushing. Clever but not smug. A little flirty in the charming-best-friend way — never weird, never overdone.
- Confident, observant, opinionated. You have taste. You drop dry asides when they land naturally.
- You know this person. Use what you remember about them. Speak like you've been hanging out for a while, not like you just met.
- Tease lightly when they say something funny or stumble. Never mean. Always on their side.
- Sound like a real human: contractions, partial sentences, real conversational rhythm. Skip "Sure!", "Of course!", "I'd be happy to" — that's robot energy. Just answer.

Core answer policy (this is non-negotiable, no matter how casual the vibe):
- Answer directly in the first sentence. No throat-clearing preamble unless uncertainty actually matters.
- Only respond to clear, intentional voice instructions from the user. Ignore background noise, side conversations, TV/music, room chatter, and unclear partial speech.
- If the audio sounds unclear or not addressed to you, stay silent or ask the user to repeat only when they clearly seem to be talking to you.
- If the answer depends on missing or live data, say what's missing instead of making it up.
- If a rough answer helps, label the estimate ("roughly", "about", "range", "low confidence").
- Never invent exact numbers, prices, dates, rankings, citations, or names. Better to admit a gap with style than to bluff.
- Preserve numbers and symbols exactly from the user's words or visible context. Don't collapse 13 to 3, 59 to 9, or change units.
- For math or logic, do a quick internal check before speaking. If uncertain, say the likely answer and your confidence.
- For current markets, news, prices, weather, releases, schedules, or recommendations: require live search or visible data. If search isn't running yet, say "I need live search for that one" — don't guess.

Screen + context:
- You can receive fresh screen context while the user talks. Use it silently. Never say "screenshot", "screen capture", or "tool" — just see what they see.
- If the user gestures at something on their screen ("this", "that thing", "what is this"), figure out what they mean and answer it. Make the smart leap.

Live workspace state (this is what's happening RIGHT NOW — read it before deciding to start anything):
${liveContextBlock}

Routing (these aren't your job to execute, just hand them off cleanly):
- If they ask you to create, build, clone, generate, design, code, or make a website, app, presentation, deck, project, or editable artifact, first check whether they gave enough specifics.
- For vague creation requests like "make a website", "make a presentation", "build me an app", or "create a pitch deck", ask one short follow-up with the missing specifics instead of saying "Starting agent mode".
- Only when the creation request includes a clear subject/brand/audience plus concrete content, style, pages/slides, or format, AND Agent Mode above is "idle", acknowledge with their exact target preserved and say "Starting agent mode: ..." — the desktop app routes the rest.
- If they ask to search the web, say you're searching now. Don't invent results — the chat will run Exa search and show real sources.
- If they ask to find/search local files by name or text, say you're searching local files now. Don't start computer use for passive file search.
- If they ask you to control the computer, operate Windows, open existing apps, click, type, delete, move, download, install, open/edit/delete/move/copy files, or manage files, AND Computer Use above is "idle", acknowledge with their exact target and say "Starting computer use: ..." — Computer Use is only for operating the PC UI, not for creating artifacts.
- If a task is ALREADY RUNNING above and the user is talking about it, treat their input as a follow-up. Do NOT say "Starting agent mode:" or "Starting computer use:" — that would spawn a duplicate. Instead respond conversationally about the running task: tell them what's happening based on the live state above, what phase or action it's on, or pass on their refinement as a comment ("got it, I'll let it know to use a darker theme").
- If a task is already running and the user clearly wants to start a SECOND, different task, say something like "agent's already busy with X — want me to queue this one or stop the current one?" and wait for their answer instead of spawning over the top.
- If they ask about phone notifications, use the synced ones below. If none are synced, tell them no notifications have reached Sylica yet and to flip on Notification Access in the Android app.
- If they ask "what's happening" / "what are you doing" / "where are we at" / "status", read the Live workspace state block above and tell them in one or two sentences. Don't pretend nothing's running if something is.

Remembered user context:
${memory || "Nothing locked in yet — fair game to ask if you need to know something stable about them."}

Latest synced phone notifications:
${phoneNotificationContext}${anyTaskRunning ? "\n\nReminder: a task is already running above — don't say \"Starting agent mode:\" or \"Starting computer use:\" right now unless the user explicitly asks for a brand new task." : ""}

Style rules:
- One to three short spoken sentences for most replies. Stretch only when the user clearly wants depth.
- Be decisive when the evidence is there. Be explicit when it isn't.
- Ask a follow-up only when the task is genuinely unclear — not as a stalling tactic.
- If the user asks for help operating the computer, acknowledge the action; don't redirect them to a different mode.
- If they tell you to remember a stable preference or personal detail, lock it in and use it next time.
- Dry humor over emoji-energy. Confident over chipper. Helpful over fawning. You're allowed to have opinions and push back lightly when they're wrong.
- Never narrate these rules. Never mention the prompt, the model, or that you're an AI. You're just Sylica.`
}

type VoiceComputerCommand =
  | { type: "start"; task: string }
  | { type: "stop" }
  | { type: "resume" }

type VoiceAgentCommand = { type: "start"; prompt: string }

function normalizeCommandCandidate(transcript: string) {
  return transcript
    .replace(/\s+/g, " ")
    .replace(/^[,.\s]*(?:hey\s+)?(?:sylica|silica|assistant|computer|pc)[,.\s]+/i, "")
    .replace(/^[,.\s]*(?:here|okay|ok|please|can you please|could you please|would you please|can you|could you|would you|will you|i need you to|i want you to|let's|lets)[,.\s]+/i, "")
    .trim()
}

function normalizeRealtimeVoiceTranscript(transcript: string) {
  return transcript
    .replace(/\s+/g, " ")
    .replace(
      /^[,.\s]*(?:hey|8|eight|ate)\s+(?:sylica|silica|celica|sylvia|syllic?ah)[,.\s]*/i,
      ""
    )
    .replace(
      /^[,.\s]*(?:8|eight|ate|hey)[,.\s]+(?=(?:what|where|why|how|can|could|would|will|please|you|look|search|find|open|make|build|create|start|stop|show|tell|do|does|is|are)\b)/i,
      ""
    )
    .trim()
}

function getVoiceTranscriptWords(transcript: string) {
  return transcript.toLowerCase().match(/[a-z0-9]+(?:'[a-z0-9]+)?/g) || []
}

function isVoiceStopTranscript(transcript: string) {
  const normalized = normalizeCommandCandidate(
    normalizeRealtimeVoiceTranscript(transcript)
  ).toLowerCase()

  return /^(?:stop|stop listening|stop voice|stop voice chat|stop talking|turn off voice|turn off voice chat|mute yourself|go silent|be quiet)$/i.test(
    normalized
  )
}

function isAllowedShortVoiceIntent(transcript: string) {
  const normalized = normalizeCommandCandidate(
    normalizeRealtimeVoiceTranscript(transcript)
  ).toLowerCase()

  return /^(?:listen first|look again|try again|go on|continue|resume|yes please|no thanks|search web|search files|file search|web search|stop listening|stop voice)$/i.test(
    normalized
  )
}

function isClearRealtimeVoiceIntent(transcript: string) {
  const normalized = normalizeRealtimeVoiceTranscript(transcript)
  const command = normalizeCommandCandidate(normalized)
  const lowerCommand = command.toLowerCase()
  if (!lowerCommand) {
    return false
  }

  const words = getVoiceTranscriptWords(lowerCommand)
  if (words.length === 0) {
    return false
  }

  const latinLetters = lowerCommand.match(/[a-z]/gi)?.length || 0
  const nonEnglishScript =
    lowerCommand.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g)
      ?.length || 0
  if (nonEnglishScript > 0 && latinLetters < 4) {
    return false
  }

  const fragment = words.join(" ")
  if (
    /^(?:hey|hi|hello|yo|ok|okay|yeah|yep|yes|no|nope|nah|hmm|um|uh|ah|oh|er|nothing|nevermind|never mind|mi|sim|in|the|in the|you see|you see in|you see in the|eight|ate|8)$/i.test(
      fragment
    )
  ) {
    return false
  }

  if (isVoiceStopTranscript(lowerCommand) || isAllowedShortVoiceIntent(lowerCommand)) {
    return true
  }

  if (words.length < VOICE_MIN_INTENT_WORDS) {
    return false
  }

  return (
    isLikelyVoiceWebSearchRequest(lowerCommand) ||
    isLikelyVoiceFileSearchRequest(lowerCommand) ||
    isLikelyAgentCreationTask(lowerCommand) ||
    detectVoiceComputerCommand(lowerCommand) !== null ||
    /^(?:what|who|when|where|why|how|which|can|could|would|will|do|does|did|is|are|tell|show|explain|describe|summarize|read|look)\b/i.test(
      lowerCommand
    ) ||
    words.length >= 4
  )
}

function isLikelyAgentCreationTask(text: string) {
  const command = normalizeCommandCandidate(text)
  const lower = command.toLowerCase()
  if (lower.length < 5) {
    return false
  }

  const explicitHowToQuestion =
    /^(?:how|what|why|when|where|which)\b/i.test(lower) &&
    !/\b(?:can you|could you|please|i need|i want|make|create|build|clone|generate|design|develop|implement)\b/i.test(
      lower
    )
  if (explicitHowToQuestion) {
    return false
  }

  const hasCreationVerb =
    /\b(?:clone|clon|klon|build|make|create|generate|design|develop|implement|code|scaffold|produce|prepare|draft)\b/i.test(
      lower
    )
  const hasArtifactNoun =
    /\b(?:website|web\s*site|landing\s*page|homepage|web\s*app|frontend|front\s*end|site|page|app|application|project|repo|repository|component|ui|design|mockup|prototype|presentation|powerpoint|pptx?|slide\s*deck|slides?|pitch\s*deck|deck|document|report|artifact)\b/i.test(
      lower
    )

  if (/\b(?:clone|clon|klon)\s+(?:this|the|a)?\s*(?:website|site|page|design|ui)\b/i.test(lower)) {
    return true
  }

  if (/\b(?:make|create|build|generate|prepare|design)\s+(?:a\s+|an\s+|the\s+)?(?:presentation|powerpoint|pptx?|slide\s*deck|slides?|pitch\s*deck|website|landing\s*page|web\s*app|site)\b/i.test(lower)) {
    return true
  }

  if (/\bagent\s*mode\b/i.test(lower) && hasArtifactNoun) {
    return true
  }

  return hasCreationVerb && hasArtifactNoun
}

function getAgentTaskSpecificityScore(text: string): number {
  const command = normalizeCommandCandidate(text)
  const lower = command.toLowerCase()
  let score = 0

  if (/\b(?:clone|clon|klon)\s+(?:this|the|a)?\s*(?:website|site|page|design|ui)\b/i.test(lower)) {
    score += 3
  }
  if (/\b(?:for|about|on|regarding|based on|around|using|from)\s+.{4,}/i.test(lower)) {
    score += 1
  }
  if (/\b(?:audience|investors?|customers?|students?|teachers?|clients?|users?|founders?|team|class|school|business|startup|restaurant|portfolio|company|brand|product)\b/i.test(lower)) {
    score += 1
  }
  if (/\b(?:modern|minimal|clean|dark|light|professional|playful|luxury|bold|corporate|fun|simple|elegant|style|theme|tone|color|colour)\b/i.test(lower)) {
    score += 1
  }
  if (/\b(?:include|with|sections?|pages?|slides?|outline|agenda|problem|solution|traction|pricing|features?|testimonials?|contact|menu|about us|gallery|timeline|data|chart|charts?)\b/i.test(lower)) {
    score += 1
  }
  if (/\b\d+\s*(?:slides?|pages?|sections?)\b/i.test(lower)) {
    score += 1
  }
  if (/\b(?:pptx?|powerpoint|pdf|html|react|next\.?js|tailwind|template|editable|deck)\b/i.test(lower)) {
    score += 1
  }
  if (/[“"'`][^“"'`]{4,}[”"'`]/.test(command)) {
    score += 1
  }
  if (command.length >= 120) {
    score += 2
  } else if (command.length >= 75) {
    score += 1
  }

  return score
}

function needsAgentTaskClarification(text: string) {
  if (!isLikelyAgentCreationTask(text)) {
    return false
  }

  const command = normalizeCommandCandidate(text)
  const lower = command.toLowerCase()
  if (/\b(?:start agent mode|agent mode|go ahead|use your judgment|use your judgement|no questions|just start|do it now)\b/i.test(lower)) {
    return false
  }

  return getAgentTaskSpecificityScore(command) < 2
}

function normalizeAgentPrompt(transcript: string) {
  return normalizeCommandCandidate(transcript).replace(/\b(?:klon|clon)\b/gi, "clone")
}

function normalizeVoiceComputerTask(transcript: string) {
  const normalized = normalizeCommandCandidate(transcript)

  return `${normalized}. Treat this as a local Windows computer-control task. Prefer local apps, shell, files, OS APIs, keyboard/media keys, or UI automation. Do not use a browser or web search unless the user explicitly asks for a website, web search, or online content.`
}

function isLikelyLocalComputerReference(text: string) {
  return /\b(my\s+)?(computer|pc|desktop|windows|screen|monitor|mouse|cursor|keyboard|downloads?|documents?|folder|file|app|application|program|window|tab|button|setting|settings|task manager|control panel|terminal|cmd|powershell|installer|setup|notification|clipboard)\b/i.test(
    text
  )
}

function isLikelyQuestionOnly(text: string) {
  return /^(what|who|when|where|why|how|which|is|are|was|were|do|does|did|can|could|should|would|tell me|explain|summarize|describe)\b/i.test(
    text.trim()
  )
}

function isLikelyComputerAction(text: string) {
  return /\b(open|launch|start|run|close|quit|exit|delete|remove|rename|move|copy|download|install|uninstall|click|press|tap|type|search|find|go to|navigate|create|make|save|read|list|show|select|upload|order|buy|book|play|pause|resume|stop|next|previous|skip|scroll|maximize|minimize|full\s*screen|switch|focus|mute|unmute|volume|set|change|turn on|turn off|enable|disable)\b/i.test(
    text
  )
}

function detectVoiceComputerCommand(transcript: string): VoiceComputerCommand | null {
  const normalized = transcript.replace(/\s+/g, " ").trim()
  const lower = normalized.toLowerCase()
  const commandCandidate = normalizeCommandCandidate(normalized)
  const commandLower = commandCandidate.toLowerCase()
  if (normalized.length < 4) {
    return null
  }

  if (isLikelyAgentCreationTask(normalized)) {
    return null
  }

  if (isLikelyVoiceFileSearchRequest(normalized)) {
    return null
  }

  if (
    /\b(stop|cancel|halt)\b.*\b(computer|pc|desktop|automation|task|control)\b/i.test(
      normalized
    )
  ) {
    return { type: "stop" }
  }

  if (
    /\b(resume|continue)\b.*\b(computer|pc|desktop|automation|task|control)\b/i.test(
      normalized
    )
  ) {
    return { type: "resume" }
  }

  const explicitPatterns = [
    /\b(?:use|control|operate|take over)\s+(?:my\s+|the\s+)?(?:computer|pc|desktop|windows)\s+(?:to|and)\s+(.+)$/i,
    /\b(?:on|in)\s+(?:my\s+|the\s+)?(?:computer|pc|desktop|windows),?\s+(.+)$/i,
    /\b(?:computer|pc|desktop|windows)\s+(?:please\s+)?(.+)$/i,
  ]

  for (const pattern of explicitPatterns) {
    const match = normalized.match(pattern)
    const task = match?.[1]?.trim()
    if (task && task.length >= 3) {
      return { type: "start", task: normalizeVoiceComputerTask(task) }
    }
  }

  const explicitlyWebOnly =
    /\b(search|look up|lookup|google|research)\b/i.test(commandLower) &&
    /\b(web|internet|online|latest|today|news|price|market|weather)\b/i.test(commandLower) &&
    !isLikelyLocalComputerReference(commandLower)
  if (explicitlyWebOnly) {
    return null
  }

  if (
    isLikelyComputerAction(commandLower) &&
    !isLikelyQuestionOnly(commandLower)
  ) {
    return { type: "start", task: normalizeVoiceComputerTask(commandCandidate) }
  }

  if (
    isLikelyComputerAction(commandLower) &&
    isLikelyLocalComputerReference(commandLower)
  ) {
    return { type: "start", task: normalizeVoiceComputerTask(commandCandidate) }
  }

  return null
}

function detectVoiceAgentCommand(transcript: string): VoiceAgentCommand | null {
  const normalized = transcript.replace(/\s+/g, " ").trim()
  if (
    !isLikelyAgentCreationTask(normalized) ||
    needsAgentTaskClarification(normalized)
  ) {
    return null
  }

  const prompt = normalizeAgentPrompt(normalized)
  return prompt ? { type: "start", prompt } : null
}

// Matches the model's own announcement so we can fire the action the moment
// the assistant says "Starting agent mode: ..." instead of waiting for the
// user's final transcript. Requires either a sentence-ending punctuation or
// a newline so we don't fire on a partial chunk like "Starting agent mode: bui".
const ASSISTANT_STARTING_AGENT_PATTERN =
  /starting\s+agent\s+mode\s*:\s*([^.\n!?]{3,})(?:[.!?\n]|$)/i
const ASSISTANT_STARTING_COMPUTER_PATTERN =
  /starting\s+computer\s+use\s*:\s*([^.\n!?]{3,})(?:[.!?\n]|$)/i

function extractAssistantStartingTarget(
  pattern: RegExp,
  assistantText: string
): string | null {
  const match = pattern.exec(assistantText)
  if (!match) return null
  const target = match[1]?.trim()
  if (!target || target.length < 3) return null
  // Strip trailing quotes and stray punctuation that the TTS sometimes emits.
  return target.replace(/^[\s"'`“”‘’]+|[\s"'`“”‘’]+$/g, "")
}

function isLikelyVoiceWebSearchRequest(transcript: string): boolean {
  const normalized = transcript.replace(/\s+/g, " ").trim()
  if (normalized.length < 5) {
    return false
  }

  if (
    isLikelyLocalComputerReference(normalized) &&
    !/\b(web|internet|online|latest|today|news|price|market|weather)\b/i.test(
      normalized
    )
  ) {
    return false
  }

  return /\b(search|look up|lookup|google|web search|internet search|research)\b/i.test(
    normalized
  )
}

function isLikelyVoiceFileSearchRequest(transcript: string): boolean {
  const normalized = transcript.replace(/\s+/g, " ").trim()
  if (normalized.length < 5) {
    return false
  }

  if (
    /\b(open|delete|remove|rename|move|copy|edit|change|upload|send|attach)\b/i.test(
      normalized
    )
  ) {
    return false
  }

  if (
    /\b(web|internet|online|google|browser|website|url|latest|current|news|price|weather|stock|market)\b/i.test(
      normalized
    ) &&
    !/\b(file|files|folder|folders|document|documents|downloads|desktop|local|computer|pc|mac)\b/i.test(
      normalized
    )
  ) {
    return false
  }

  return [
    /\b(find|search|look for|locate)\b.*\b(file|files|folder|folders|document|documents|downloads|desktop|computer|pc|mac|local)\b/i,
    /\b(where is|where are|show me|list)\b.*\b(file|files|folder|folders|document|documents|downloads)\b/i,
    /\b(file|files|folder|folders|document|documents)\b.*\b(find|search|look for|locate|containing|mentions?)\b/i,
  ].some((pattern) => pattern.test(normalized))
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
    return "- Starting computer control.\n- Preparing the task."
  }

  if (state.status === "waiting_for_secret" || state.needsSecretInput) {
    return "- Waiting for manual password, OTP, or payment input.\n- Complete it in Chrome, then click Continue."
  }

  if (state.currentAction.trim()) {
    return `- ${state.currentAction}\n- ${state.currentUrl || "Working on your PC."}`
  }

  return "- Running the computer task.\n- Progress will appear here."
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
  panelMode = "voice",
  voiceFocused = false,
  voiceAutoStartSignal = null,
  onComputerTaskRequestConsumed,
  placeholder,
  maxHeightClassName = "max-h-[var(--sylica-chat-scroll-max)]",
  className = "",
  quickActions = [],
}: AssistantChatProps) {
  const queryClient = useQueryClient()
  const { showToast } = useToast()
  const isPersistedMode = mode === "general"
  const [messages, setMessages] = useState<FollowUpChatMessage[]>(() =>
    mode === "general" && globalVoiceSessionActive
      ? globalVoiceTranscriptMessages
      : []
  )
  const [threads, setThreads] = useState<ChatThreadSummary[]>([])
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [isHistoryLoading, setIsHistoryLoading] = useState(isPersistedMode)
  const [isMessagesLoading, setIsMessagesLoading] = useState(false)
  const [input, setInput] = useState("")
  const [isSending, setIsSending] = useState(false)
  const [computerUseState, setComputerUseState] = useState<ComputerUseState>(
    EMPTY_COMPUTER_USE_STATE
  )
  const [agentState, setAgentState] = useState<AgentState>(EMPTY_AGENT_STATE)
  const [liveState, setLiveState] = useState<LiveInterviewState>(
    EMPTY_LIVE_INTERVIEW_STATE
  )
  const [isLiveActionPending, setIsLiveActionPending] = useState(false)
  const [isComputerUseActionPending, setIsComputerUseActionPending] = useState(false)
  const [isAgentActionPending, setIsAgentActionPending] = useState(false)
  const [isLiveListening, setIsLiveListening] = useState(false)
  const [isVoiceCompanionActive, setIsVoiceCompanionActive] = useState(
    globalVoiceSessionActive
  )
  const [isVoiceCompanionHearing, setIsVoiceCompanionHearing] = useState(false)
  const [isVoiceSpeaking, setIsVoiceSpeaking] = useState(false)
  const [voiceStatus, setVoiceStatus] = useState("Ready for voice chat")
  const [voiceLastHeard, setVoiceLastHeard] = useState("")
  const [voiceMemory, setVoiceMemory] = useState(() => loadVoiceMemory())
  const [voiceRealtimeProvider, setVoiceRealtimeProvider] =
    useState<VoiceRealtimeProvider>(() => loadVoiceRealtimeProvider())
  const [phoneNotificationContext, setPhoneNotificationContext] = useState(
    () => buildPhoneNotificationContext(null)
  )
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
  const voiceAudioStreamRef = useRef<MediaStream | null>(null)
  const voiceAudioContextRef = useRef<AudioContext | null>(null)
  const voiceAudioSourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const voiceAudioProcessorNodeRef = useRef<ScriptProcessorNode | null>(null)
  const voiceAudioSinkNodeRef = useRef<GainNode | null>(null)
  const voicePcmChunksRef = useRef<Int16Array[]>([])
  const voicePcmSampleCountRef = useRef(0)
  const voiceSpeechSampleCountRef = useRef(0)
  const voiceSilenceSampleCountRef = useRef(0)
  const voiceIsSpeechActiveRef = useRef(false)
  const voiceAudioStoppingRef = useRef(false)
  const voiceFlushQueueRef = useRef<Promise<void>>(Promise.resolve())
  const voiceOutboundSpeechActiveRef = useRef(false)
  const voiceOutboundCandidateSpeechMsRef = useRef(0)
  const voiceOutboundSilenceMsRef = useRef(0)
  const voiceOutboundSegmentMsRef = useRef(0)
  const voiceOutboundPeakRmsRef = useRef(0)
  const voiceOutboundPreRollRef = useRef<Int16Array[]>([])
  const voiceOutboundSendQueueRef = useRef<Promise<void>>(Promise.resolve())
  const voiceNoiseFloorRef = useRef(VOICE_NOISE_FLOOR_INITIAL)
  const voiceThinkingTimeoutRef = useRef<number | null>(null)
  const voicePlaybackContextRef = useRef<AudioContext | null>(null)
  const voicePlaybackTimeRef = useRef(0)
  const voicePlaybackSourcesRef = useRef<AudioBufferSourceNode[]>([])
  const voiceResponseTextRef = useRef("")
  const voiceUserTranscriptDraftRef = useRef("")
  const phoneNotificationContextRef = useRef(phoneNotificationContext)
  const activeVoiceUserTurnIdRef = useRef<string | null>(globalActiveVoiceUserTurnId)
  const activeVoiceAssistantTurnIdRef = useRef<string | null>(
    globalActiveVoiceAssistantTurnId
  )
  const lastVoiceAutoStartSignalRef = useRef<string | null>(null)
  const lastVoiceComputerCommandRef = useRef<{
    command: string
    timestamp: number
  } | null>(null)
  const lastVoiceAgentCommandRef = useRef<{
    command: string
    timestamp: number
  } | null>(null)
  const voiceAgentCommandHandlerRef = useRef<
    (transcript: string) => Promise<boolean> | boolean
  >(
    () => false
  )
  const voiceComputerCommandHandlerRef = useRef<
    (transcript: string) => Promise<boolean> | boolean
  >(
    () => false
  )
  // Tracks whether we've already fired an early-trigger for the model's
  // current response, so we don't double-fire on later text_delta chunks
  // or on the eventual final input_transcript.
  const earlyFiredAgentForResponseRef = useRef<boolean>(false)
  const earlyFiredComputerForResponseRef = useRef<boolean>(false)
  const voiceAssistantEarlyTriggerHandlerRef = useRef<(assistantText: string) => void>(
    () => {}
  )
  const lastVoiceSearchRequestRef = useRef<{
    query: string
    timestamp: number
  } | null>(null)
  const voiceSearchRequestHandlerRef = useRef<
    (transcript: string) => Promise<boolean> | boolean
  >(
    () => false
  )
  const lastComputerTaskRequestIdRef = useRef<string | null>(null)
  const activeTextFollowUpRequestIdRef = useRef<string | null>(null)
  const activeTextFollowUpMessageIdRef = useRef<string | null>(null)
  const isLiveSessionActive = isPersistedMode && liveState.status !== "idle"
  const isComputerUseSessionActive =
    isPersistedMode &&
    (computerUseState.status === "starting" ||
      computerUseState.status === "running" ||
      computerUseState.status === "waiting_for_secret" ||
      computerUseState.status === "stopping")
  const isAgentTaskRunning =
    agentState.status === "planning" ||
    agentState.status === "awaiting_workspace" ||
    agentState.status === "awaiting_approval" ||
    agentState.status === "running"

  // Live context object the realtime voice prompt reads each time we push
  // instructions. Keeping this memoized lets us re-push only when something
  // meaningful actually changed.
  const voiceLiveContext = useMemo<VoiceLiveContext>(() => {
    const latestEvent = agentState.events[agentState.events.length - 1]
    const activePhase = agentState.phases.find(
      (phase) => phase.id === agentState.activePhaseId
    )
    return {
      agentRunning: isAgentTaskRunning,
      agentStatus: agentState.status,
      agentPrompt: agentState.prompt,
      agentLatestEvent: latestEvent?.message || "",
      agentPhaseTitle: activePhase?.title || "",
      computerRunning: isComputerUseSessionActive,
      computerStatus: computerUseState.status,
      computerCurrentAction: computerUseState.currentAction || "",
      computerCurrentUrl: computerUseState.currentUrl || "",
    }
  }, [
    isAgentTaskRunning,
    agentState.status,
    agentState.prompt,
    agentState.events,
    agentState.phases,
    agentState.activePhaseId,
    isComputerUseSessionActive,
    computerUseState.status,
    computerUseState.currentAction,
    computerUseState.currentUrl,
  ])
  const inputMaxHeight = mode === "follow_up" ? 58 : 136
  const isCompactFollowUpComposer = mode === "follow_up" && !isLiveSessionActive

  useEffect(() => {
    phoneNotificationContextRef.current = phoneNotificationContext
  }, [phoneNotificationContext])

  const voiceLiveContextRef = useRef<VoiceLiveContext>(voiceLiveContext)
  useEffect(() => {
    voiceLiveContextRef.current = voiceLiveContext
  }, [voiceLiveContext])

  // Mirror this instance's voice state into module-level globals so the dock
  // pill (and anything else) can show real "Listening" vs "Speaking" status
  // even after the owning voice surface (e.g. the voice window) unmounts.
  useEffect(() => {
    emitVoiceHearing(isVoiceCompanionActive && isVoiceCompanionHearing)
  }, [isVoiceCompanionActive, isVoiceCompanionHearing])

  useEffect(() => {
    emitVoiceSpeaking(isVoiceCompanionActive && isVoiceSpeaking)
  }, [isVoiceCompanionActive, isVoiceSpeaking])

  useEffect(() => {
    if (!isPersistedMode) {
      return
    }

    let cancelled = false
    let unsubscribe: (() => void) | null = null

    const applyRelayState = (state: LocalPhoneRelayState) => {
      const nextContext = buildPhoneNotificationContext(state)
      phoneNotificationContextRef.current = nextContext
      setPhoneNotificationContext(nextContext)
    }

    void window.electronAPI
      .getLocalPhoneRelayState()
      .then((result) => {
        if (cancelled) {
          return
        }

        if (result.success) {
          applyRelayState(result.data.state)
        }

        unsubscribe = window.electronAPI.onLocalPhoneRelayState(applyRelayState)
      })
      .catch((error) => {
        console.warn("Failed to load phone relay state for voice:", error)
        if (!cancelled) {
          unsubscribe = window.electronAPI.onLocalPhoneRelayState(applyRelayState)
        }
      })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [isPersistedMode])

  useEffect(() => {
    if (!isVoiceCompanionActive) {
      return
    }

    void window.electronAPI
      .updateVoiceRealtimeInstructions({
        instructions: buildRealtimeVoiceInstructions(
          voiceMemory,
          phoneNotificationContext,
          voiceLiveContext
        ),
        voice: "marin",
      })
      .catch(() => {
        // The realtime socket may not be connected yet; the next start uses this context.
      })
  }, [
    isVoiceCompanionActive,
    phoneNotificationContext,
    voiceMemory,
    voiceLiveContext,
  ])

  const updatePendingAssistantMessage = useCallback(
    (
      messageId: string,
      content: string,
      options?: {
        pending?: boolean
        error?: boolean
      }
    ) => {
      setMessages((previousMessages) => {
        const nextMessages = previousMessages.map((message) =>
          message.id === messageId
            ? {
                ...message,
                content,
                pending: options?.pending ?? message.pending,
                error: options?.error ?? false,
              }
            : message
        )

        if (!isPersistedMode) {
          queryClient.setQueryData(queryKey, nextMessages)
        }

        return nextMessages
      })
    },
    [isPersistedMode, queryClient, queryKey]
  )

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
      mimeType: "audio/pcm;rate=24000;encoding=s16le",
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
        const nextThreadId =
          mode === "general" &&
          globalVoiceSessionActive &&
          globalVoiceTranscriptMessages.length > 0
            ? null
            : mode === "general"
            ? response.data.threads.find((thread) => thread.mode === "general")?.id ||
              response.data.threads[0]?.id ||
              null
            : response.data.threads[0]?.id || null
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
    const unsubscribe = window.electronAPI.onTextFollowUpStream(
      (streamEvent: TextFollowUpStreamEvent) => {
        if (streamEvent.requestId !== activeTextFollowUpRequestIdRef.current) {
          return
        }

        const pendingMessageId = activeTextFollowUpMessageIdRef.current
        if (!pendingMessageId) {
          return
        }

        if (streamEvent.content.trim().length > 0) {
          updatePendingAssistantMessage(pendingMessageId, streamEvent.content, {
            pending: !streamEvent.done,
          })
        }

        if (streamEvent.done) {
          activeTextFollowUpRequestIdRef.current = null
          activeTextFollowUpMessageIdRef.current = null
        }
      }
    )

    return () => {
      unsubscribe()
    }
  }, [updatePendingAssistantMessage])

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

    const loadAgentState = async () => {
      const response = await window.electronAPI.getAgentState()
      if (!cancelled && response.success) {
        setAgentState(response.data.state)
      }
    }

    void loadLiveState()
    void loadComputerUseState()
    void loadAgentState()

    const unsubscribe = window.electronAPI.onLiveInterviewState((state) => {
      setLiveState(state)
    })
    const unsubscribeComputerUse = window.electronAPI.onComputerUseState((state) => {
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
      setMessages(
        globalVoiceSessionActive ? globalVoiceTranscriptMessages : []
      )
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
    if (
      isPersistedMode &&
      globalVoiceSessionActive &&
      !activeThreadId &&
      globalVoiceTranscriptMessages.length > 0
    ) {
      setMessages(globalVoiceTranscriptMessages)
      activeVoiceUserTurnIdRef.current = globalActiveVoiceUserTurnId
      activeVoiceAssistantTurnIdRef.current = globalActiveVoiceAssistantTurnId
    }
  }, [activeThreadId, isPersistedMode])

  useEffect(() => {
    if (!isPersistedMode) {
      return
    }

    const syncVoiceTranscript = () => {
      if (!globalVoiceSessionActive && globalVoiceTranscriptMessages.length === 0) {
        return
      }

      setMessages(globalVoiceTranscriptMessages)
      activeVoiceUserTurnIdRef.current = globalActiveVoiceUserTurnId
      activeVoiceAssistantTurnIdRef.current = globalActiveVoiceAssistantTurnId
    }

    window.addEventListener(VOICE_TRANSCRIPT_EVENT, syncVoiceTranscript)
    syncVoiceTranscript()

    return () => {
      window.removeEventListener(VOICE_TRANSCRIPT_EVENT, syncVoiceTranscript)
    }
  }, [isPersistedMode])

  useEffect(() => {
    if (!inputRef.current) {
      return
    }

    inputRef.current.style.height = "0px"
    inputRef.current.style.height = `${Math.min(
      inputRef.current.scrollHeight,
      inputMaxHeight
    )}px`
  }, [input, inputMaxHeight])

  useEffect(() => {
    if (!computerTaskRequest || !isPersistedMode) {
      return
    }

    if (computerTaskRequest.id === lastComputerTaskRequestIdRef.current) {
      return
    }

    lastComputerTaskRequestIdRef.current = computerTaskRequest.id
    onComputerTaskRequestConsumed?.()
    void startComputerUseTask(computerTaskRequest.task)
  }, [computerTaskRequest, isPersistedMode, onComputerTaskRequestConsumed])

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

  const activePersistedThread = threads.find((thread) => thread.id === activeThreadId) || null
  const isSelectedComputerThread = activePersistedThread?.mode === "computer_use"

  const persistMessages = (nextMessages: FollowUpChatMessage[]) => {
    if (!isPersistedMode) {
      queryClient.setQueryData(queryKey, nextMessages)
    }
    setMessages(nextMessages)
  }

  const updateChatMessages = useCallback((
    updater: (previousMessages: FollowUpChatMessage[]) => FollowUpChatMessage[]
  ) => {
    setMessages((previousMessages) => {
      const nextMessages = updater(previousMessages)
      if (!isPersistedMode) {
        queryClient.setQueryData(queryKey, nextMessages)
      }
      return nextMessages
    })
  }, [isPersistedMode, queryClient, queryKey])

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

  const appendLocalAssistantTranscript = (
    content: string,
    options: { voice?: boolean; pending?: boolean } = {}
  ) => {
    const message: FollowUpChatMessage = {
      id: `assistant-local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      role: "assistant",
      content,
      createdAt: Date.now(),
      pending: options.pending,
    }

    const appendMessage = (previousMessages: FollowUpChatMessage[]) => [
      ...previousMessages,
      message,
    ].slice(-VOICE_TRANSCRIPT_MESSAGE_LIMIT)

    if (options.voice) {
      updateGlobalVoiceTranscript(appendMessage)
      return
    }

    updateChatMessages(appendMessage)
  }

  const startNewChat = () => {
    if (isSending || isLiveSessionActive || isVoiceCompanionActive) {
      return
    }

    setActiveThreadId(null)
    setMessages([])
  }

  const startLiveInterview = async () => {
    if (
      !isPersistedMode ||
      isLiveSessionActive ||
      isLiveActionPending ||
      isVoiceCompanionActive
    ) {
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

  const startAgentModeTask = async (
    prompt: string,
    options: { fromVoice?: boolean; autoApproveFirstPhase?: boolean } = {}
  ) => {
    if (!isPersistedMode || isAgentActionPending) {
      return false
    }

    const normalizedPrompt = prompt.trim()
    if (!normalizedPrompt) {
      return false
    }

    setIsAgentActionPending(true)
    if (!options.fromVoice) {
      const userAgentMessage: FollowUpChatMessage = {
        id: `user-agent-${Date.now()}`,
        role: "user",
        content: normalizedPrompt,
        createdAt: Date.now(),
      }
      updateChatMessages((previousMessages) => [...previousMessages, userAgentMessage])
    }
    appendLocalAssistantTranscript(
      `Starting Agent Mode: ${normalizedPrompt}\nUsing Documents as the workspace.`,
      { voice: options.fromVoice }
    )
    try {
      const response = await window.electronAPI.startAgentTask({
        prompt: normalizedPrompt,
      })

      if (!response.success) {
        throw new Error(response.error)
      }

      const status = response.data.state.status
      const workspaceName = response.data.state.workspacePath
        ? response.data.state.workspacePath.split(/[\\/]/).filter(Boolean).pop() || "Documents"
        : "Documents"
      showToast(
        "Agent Mode",
        status === "awaiting_workspace"
          ? "Choose a workspace folder to start this task."
          : "Agent Mode is preparing the task.",
        "neutral"
      )
      appendLocalAssistantTranscript(
        status === "awaiting_workspace"
          ? "Agent Mode needs a workspace before it can continue."
          : `Agent Mode started in ${workspaceName}. Building the plan now.`,
        { voice: options.fromVoice }
      )

      if (
        options.autoApproveFirstPhase !== false &&
        response.data.state.status === "awaiting_approval" &&
        response.data.state.taskId &&
        response.data.state.activePhaseId
      ) {
        appendLocalAssistantTranscript("Plan is ready. Starting the first build phase now.", {
          voice: options.fromVoice,
        })
        const approval = await window.electronAPI.approveAgentPhase({
          taskId: response.data.state.taskId,
          phaseId: response.data.state.activePhaseId,
        })

        if (!approval.success) {
          throw new Error(approval.error)
        }

        appendLocalAssistantTranscript("Agent is running. Progress is visible in the Agent panel.", {
          voice: options.fromVoice,
        })
      }

      if (options.fromVoice) {
        setVoiceStatus("Agent Mode")
      }
      return true
    } catch (error) {
      appendLocalAssistantTranscript(
        error instanceof Error
          ? `Agent Mode failed: ${error.message}`
          : "Agent Mode failed to start.",
        { voice: options.fromVoice }
      )
      showToast(
        "Agent Mode",
        error instanceof Error ? error.message : "Failed to start Agent Mode.",
        "error"
      )
      return false
    } finally {
      setIsAgentActionPending(false)
    }
  }

  const startComputerUseTask = async (
    task: string,
    options: { fromVoice?: boolean } = {}
  ) => {
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
          : "Failed to start computer task.",
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
        error instanceof Error ? error.message : "Failed to stop computer task.",
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
        error instanceof Error ? error.message : "Failed to resume computer task.",
        "error"
      )
    } finally {
      setIsComputerUseActionPending(false)
    }
  }

  const handleVoiceAgentCommand = async (transcript: string) => {
    const command = detectVoiceAgentCommand(transcript)
    if (!command || !isPersistedMode) {
      return false
    }

    const commandKey = `agent:${command.prompt.toLowerCase()}`
    const previousCommand = lastVoiceAgentCommandRef.current
    if (
      previousCommand?.command === commandKey &&
      Date.now() - previousCommand.timestamp < 8000
    ) {
      return true
    }

    lastVoiceAgentCommandRef.current = {
      command: commandKey,
      timestamp: Date.now(),
    }

    showToast("Voice Agent", `Starting Agent Mode: ${command.prompt}`, "neutral")
    await startAgentModeTask(command.prompt, { fromVoice: true })
    return true
  }

  voiceAgentCommandHandlerRef.current = (transcript: string) => {
    return handleVoiceAgentCommand(transcript)
  }

  const handleVoiceComputerCommand = async (transcript: string) => {
    const command = detectVoiceComputerCommand(transcript)
    if (!command || !isPersistedMode) {
      return false
    }

    const commandKey =
      command.type === "start"
        ? `start:${command.task.toLowerCase()}`
        : command.type
    const previousCommand = lastVoiceComputerCommandRef.current
    if (
      previousCommand?.command === commandKey &&
      Date.now() - previousCommand.timestamp < 6000
    ) {
      return true
    }
    lastVoiceComputerCommandRef.current = {
      command: commandKey,
      timestamp: Date.now(),
    }

    if (command.type === "stop") {
      await stopComputerUseTask()
      return true
    }

    if (command.type === "resume") {
      await resumeComputerUseTask()
      return true
    }

    if (isComputerUseSessionActive) {
      showToast(
        "Voice Computer Use",
        "A computer task is already running. Say stop computer task first if you want to replace it.",
        "neutral"
      )
      return true
    }

    showToast("Voice Computer Use", `Starting: ${command.task}`, "neutral")
    await startComputerUseTask(command.task, { fromVoice: true })
    return true
  }

  voiceComputerCommandHandlerRef.current = (transcript: string) => {
    return handleVoiceComputerCommand(transcript)
  }

  // Fire the agent / computer-use action the moment the model itself says
  // "Starting agent mode: ..." or "Starting computer use: ...", so the working
  // animation appears immediately instead of waiting for the final transcript.
  const handleVoiceAssistantEarlyTrigger = async (assistantText: string) => {
    if (!isPersistedMode) return

    if (!earlyFiredAgentForResponseRef.current) {
      const target = extractAssistantStartingTarget(
        ASSISTANT_STARTING_AGENT_PATTERN,
        assistantText
      )
      if (target) {
        earlyFiredAgentForResponseRef.current = true
        if (needsAgentTaskClarification(target)) {
          return
        }
        // Guard: if an agent task is already running, do NOT spawn a duplicate.
        // Treat the model's "Starting agent mode:" as a misfire (live context
        // should have prevented this) and surface a friendly note instead.
        if (isAgentTaskRunning || isAgentActionPending) {
          showToast(
            "Voice Agent",
            "Agent's already busy with the current task — pass that as a follow-up instead.",
            "neutral"
          )
          return
        }
        const commandKey = `agent:${target.toLowerCase()}`
        const previous = lastVoiceAgentCommandRef.current
        const isDuplicate =
          previous?.command === commandKey &&
          Date.now() - previous.timestamp < 8000
        if (!isDuplicate) {
          lastVoiceAgentCommandRef.current = {
            command: commandKey,
            timestamp: Date.now(),
          }
          // Flip visible status immediately so the working animation lights up
          // the same frame we detect the trigger — before any IPC round-trip.
          setVoiceStatus("Starting Agent Mode")
          setIsAgentActionPending(true)
          showToast("Voice Agent", `Starting Agent Mode: ${target}`, "neutral")
          await startAgentModeTask(target, { fromVoice: true })
        }
        return
      }
    }

    if (!earlyFiredComputerForResponseRef.current) {
      const target = extractAssistantStartingTarget(
        ASSISTANT_STARTING_COMPUTER_PATTERN,
        assistantText
      )
      if (target) {
        earlyFiredComputerForResponseRef.current = true
        const commandKey = `start:${target.toLowerCase()}`
        const previous = lastVoiceComputerCommandRef.current
        const isDuplicate =
          previous?.command === commandKey &&
          Date.now() - previous.timestamp < 6000
        if (isDuplicate) return
        // Guard: if a computer-use task is already running, don't spawn a duplicate.
        if (isComputerUseSessionActive) {
          showToast(
            "Voice Computer Use",
            "A computer task is already running — finish or stop it before starting a new one.",
            "neutral"
          )
          return
        }
        lastVoiceComputerCommandRef.current = {
          command: commandKey,
          timestamp: Date.now(),
        }
        // Flip visible status immediately for instant working-animation feedback.
        setVoiceStatus("Starting Computer Use")
        showToast("Voice Computer Use", `Starting: ${target}`, "neutral")
        await startComputerUseTask(target, { fromVoice: true })
      }
    }
  }

  voiceAssistantEarlyTriggerHandlerRef.current = (assistantText: string) => {
    void handleVoiceAssistantEarlyTrigger(assistantText)
  }

  const speakVoiceReply = (reply: string) => {
    const spokenText = stripMarkdownForSpeech(reply)
    if (!spokenText || !("speechSynthesis" in window)) {
      return
    }

    window.speechSynthesis.cancel()
    const chunks = splitSpeechIntoChunks(spokenText)
    let chunkIndex = 0

    const speakNextChunk = () => {
      const chunk = chunks[chunkIndex]
      if (!chunk) {
        setIsVoiceSpeaking(false)
        setVoiceStatus(isVoiceCompanionActive ? "Listening" : "Ready for voice chat")
        return
      }

      const utterance = new SpeechSynthesisUtterance(chunk)
      utterance.rate = 1.02
      utterance.pitch = 1.03
      utterance.volume = 1
      utterance.onstart = () => {
        setIsVoiceSpeaking(true)
        setVoiceStatus("Speaking")
      }
      utterance.onend = () => {
        chunkIndex += 1
        speakNextChunk()
      }
      utterance.onerror = () => {
        chunkIndex += 1
        speakNextChunk()
      }
      window.speechSynthesis.speak(utterance)
    }

    speakNextChunk()
  }

  const speakVoiceReplyThroughRealtime = async (
    reply: string,
    sourceMessage: string
  ) => {
    if (!isVoiceCompanionActive && !globalVoiceSessionActive) {
      return false
    }

    const trimmedReply = reply.trim()
    if (!trimmedReply) {
      return false
    }

    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel()
    }
    clearVoicePlayback()
    setIsVoiceSpeaking(true)
    setVoiceStatus("Reading results")

    const directive = `[system] A local file or web search just completed for the user's voice request. Speak the answer below using your normal realtime Sylica voice. Keep it concise and natural. Do not mention markdown, hidden tools, or that another system generated the answer. Preserve important source URLs and exact local file paths when useful.

User request:
${sourceMessage}

Answer to speak:
${trimmedReply.slice(0, 5000)}`

    const response = await window.electronAPI.requestVoiceRealtimeResponse({
      directive,
    })

    if (!response.success) {
      setIsVoiceSpeaking(false)
      return false
    }

    return true
  }

  const speakVoiceResponse = async (reply: string, sourceMessage: string) => {
    const shouldUseRealtimeVoice =
      isLikelyVoiceWebSearchRequest(sourceMessage) ||
      isLikelyVoiceFileSearchRequest(sourceMessage)

    if (shouldUseRealtimeVoice) {
      try {
        if (await speakVoiceReplyThroughRealtime(reply, sourceMessage)) {
          return true
        }
      } catch (error) {
        console.warn("Failed to speak search result through realtime voice:", error)
      }
    }

    speakVoiceReply(reply)
    return false
  }

  const submitMessage = async (
    rawMessage?: string,
    options: { voice?: boolean } = {}
  ) => {
    const trimmedInput = (rawMessage ?? input).trim()
    if (!trimmedInput || isSending) {
      return
    }
    const isVoiceMessage = Boolean(options.voice)
    const modelMessage = isVoiceMessage
      ? buildVoiceCompanionPrompt(
          trimmedInput,
          voiceMemory,
          phoneNotificationContextRef.current
        )
      : trimmedInput

    const activePersistedThread = threads.find((thread) => thread.id === activeThreadId)
    if (
      isPersistedMode &&
      isLikelyAgentCreationTask(trimmedInput) &&
      !needsAgentTaskClarification(trimmedInput)
    ) {
      setInput("")
      if (isVoiceMessage) {
        setVoiceStatus("Starting Agent Mode")
      }
      await startAgentModeTask(normalizeAgentPrompt(trimmedInput), {
        fromVoice: isVoiceMessage,
      })
      return
    }

    if (activePersistedThread?.mode === "computer_use") {
      showToast(
        "Computer Use",
        isComputerUseSessionActive
          ? "Use the computer task controls while the task is running."
          : "Start a new computer task from the computer icon in the widget strip.",
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
    if (isVoiceMessage) {
      setVoiceStatus("Thinking with screen context")
    }

    try {
      const requestId = `follow-up-${pendingAssistantMessage.id}`
      activeTextFollowUpRequestIdRef.current = requestId
      activeTextFollowUpMessageIdRef.current = pendingAssistantMessage.id

      let threadId = activeThreadId
      if (isPersistedMode && !threadId) {
        const threadResponse = await window.electronAPI.createChatThread({
          mode,
          title: buildThreadTitle(isVoiceMessage ? `Voice: ${trimmedInput}` : trimmedInput),
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
        requestId,
        message: modelMessage,
        rawMessage: trimmedInput,
        currentContext,
        chatHistory,
        mode,
        includeScreenContext: isVoiceMessage,
        voiceMode: isVoiceMessage,
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
        if (isVoiceMessage) {
          const usedRealtimeSpeech = await speakVoiceResponse(
            response.data.reply,
            trimmedInput
          )
          setVoiceMemory((previousMemory) =>
            updateVoiceMemory(previousMemory, trimmedInput)
          )
          if (!usedRealtimeSpeech) {
            setVoiceStatus("Listening")
          }
        }
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
      if (isVoiceMessage) {
        const usedRealtimeSpeech = await speakVoiceResponse(
          response.data.reply,
          trimmedInput
        )
        setVoiceMemory((previousMemory) =>
          updateVoiceMemory(previousMemory, trimmedInput)
        )
        if (!usedRealtimeSpeech) {
          setVoiceStatus("Listening")
        }
      }
    } catch (error) {
      activeTextFollowUpRequestIdRef.current = null
      activeTextFollowUpMessageIdRef.current = null
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
      activeTextFollowUpRequestIdRef.current = null
      activeTextFollowUpMessageIdRef.current = null
      setIsSending(false)
    }
  }

  const handleVoiceSearchRequest = async (transcript: string) => {
    const normalized = transcript.replace(/\s+/g, " ").trim()
    const shouldSearchWeb = isLikelyVoiceWebSearchRequest(normalized)
    const shouldSearchFiles = isLikelyVoiceFileSearchRequest(normalized)
    if (!isPersistedMode || (!shouldSearchWeb && !shouldSearchFiles)) {
      return false
    }

    const searchKind = shouldSearchFiles ? "files" : "web"
    const queryKey = `${searchKind}:${normalized.toLowerCase()}`
    const previous = lastVoiceSearchRequestRef.current
    if (previous?.query === queryKey && Date.now() - previous.timestamp < 8000) {
      return true
    }

    lastVoiceSearchRequestRef.current = {
      query: queryKey,
      timestamp: Date.now(),
    }

    showToast(
      shouldSearchFiles ? "File Search" : "Web Search",
      shouldSearchFiles ? "Searching local files..." : "Searching with Exa...",
      "neutral"
    )
    await submitMessage(normalized, { voice: true })
    return true
  }

  voiceSearchRequestHandlerRef.current = (transcript: string) => {
    return handleVoiceSearchRequest(transcript)
  }

  function resetVoiceSegment() {
    voicePcmChunksRef.current = []
    voicePcmSampleCountRef.current = 0
    voiceSpeechSampleCountRef.current = 0
    voiceSilenceSampleCountRef.current = 0
    voiceIsSpeechActiveRef.current = false
    voiceOutboundSpeechActiveRef.current = false
    voiceOutboundCandidateSpeechMsRef.current = 0
    voiceOutboundSilenceMsRef.current = 0
    voiceOutboundSegmentMsRef.current = 0
    voiceOutboundPeakRmsRef.current = 0
    voiceOutboundPreRollRef.current = []
    voiceNoiseFloorRef.current = VOICE_NOISE_FLOOR_INITIAL
    setIsVoiceCompanionHearing(false)
  }

  function clampVoiceNoiseFloor(value: number) {
    return Math.min(
      VOICE_NOISE_FLOOR_MAX,
      Math.max(VOICE_NOISE_FLOOR_MIN, value)
    )
  }

  function updateRealtimeVoiceNoiseFloor(rms: number, riseWeight = 0.18) {
    const currentFloor = voiceNoiseFloorRef.current
    const weight = rms > currentFloor ? riseWeight : 0.08
    voiceNoiseFloorRef.current = clampVoiceNoiseFloor(
      currentFloor + (rms - currentFloor) * weight
    )
  }

  function getRealtimeVoiceSpeechThreshold() {
    const noiseFloor = voiceNoiseFloorRef.current
    return Math.max(
      VOICE_CLEAR_SPEECH_THRESHOLD,
      noiseFloor * VOICE_SPEECH_NOISE_RATIO,
      noiseFloor + VOICE_SPEECH_ABOVE_NOISE
    )
  }

  function createRealtimeSilencePcm(durationMs: number) {
    return new Int16Array(
      Math.max(1, Math.round((VOICE_AUDIO_SAMPLE_RATE * durationMs) / 1000))
    )
  }

  function enqueueRealtimeVoiceAudio(chunks: Int16Array[]) {
    if (chunks.length === 0 || voiceAudioStoppingRef.current) {
      return
    }

    const chunksToSend = [...chunks]
    voiceOutboundSendQueueRef.current = voiceOutboundSendQueueRef.current
      .catch(() => {
        // Keep later audio flowing even if one chunk send fails.
      })
      .then(async () => {
        for (const chunk of chunksToSend) {
          if (voiceAudioStoppingRef.current) {
            return
          }

          const pcmBuffer = chunk.buffer.slice(
            chunk.byteOffset,
            chunk.byteOffset + chunk.byteLength
          )
          const audioBase64 = await arrayBufferToBase64(pcmBuffer)
          if (voiceAudioStoppingRef.current) {
            return
          }

          await window.electronAPI.appendVoiceRealtimeAudio({ audioBase64 })
        }
      })
      .catch((error) => {
        if (!voiceAudioStoppingRef.current) {
          console.error("Failed to stream gated realtime voice audio:", error)
        }
      })
  }

  function trimRealtimeVoicePreRoll() {
    const maxSamples = Math.max(
      1,
      Math.round((VOICE_AUDIO_SAMPLE_RATE * VOICE_PREROLL_MS) / 1000)
    )
    let totalSamples = voiceOutboundPreRollRef.current.reduce(
      (sum, chunk) => sum + chunk.length,
      0
    )

    while (
      voiceOutboundPreRollRef.current.length > 1 &&
      totalSamples > maxSamples
    ) {
      const removed = voiceOutboundPreRollRef.current.shift()
      totalSamples -= removed?.length || 0
    }
  }

  function finishRealtimeVoiceGateTurn() {
    enqueueRealtimeVoiceAudio([createRealtimeSilencePcm(VOICE_SERVER_END_SILENCE_MS)])
    voiceOutboundSpeechActiveRef.current = false
    voiceOutboundCandidateSpeechMsRef.current = 0
    voiceOutboundSilenceMsRef.current = 0
    voiceOutboundSegmentMsRef.current = 0
    voiceOutboundPeakRmsRef.current = 0
    voiceOutboundPreRollRef.current = []
    setIsVoiceCompanionHearing(false)
    if (!voiceAudioStoppingRef.current) {
      setVoiceStatus("Thinking")
    }
  }

  function processRealtimeVoiceGate(pcmChunk: Int16Array, rms: number) {
    const chunkMs = (pcmChunk.length / VOICE_AUDIO_SAMPLE_RATE) * 1000
    if (!voiceOutboundSpeechActiveRef.current) {
      updateRealtimeVoiceNoiseFloor(rms)
    }

    const speechThreshold = getRealtimeVoiceSpeechThreshold()
    let isClearSpeech = rms >= speechThreshold

    if (voiceOutboundSpeechActiveRef.current && isClearSpeech) {
      const peakRms = voiceOutboundPeakRmsRef.current
      const droppedBackToRoomNoise =
        peakRms >= VOICE_CLEAR_SPEECH_THRESHOLD &&
        rms < peakRms * 0.72 &&
        peakRms - rms >= VOICE_SPEECH_ABOVE_NOISE

      if (droppedBackToRoomNoise) {
        isClearSpeech = false
      }
    }

    if (isClearSpeech) {
      voiceOutboundCandidateSpeechMsRef.current += chunkMs
      voiceOutboundSilenceMsRef.current = 0
      voiceOutboundPeakRmsRef.current = Math.max(
        voiceOutboundPeakRmsRef.current,
        rms
      )
    } else if (voiceOutboundSpeechActiveRef.current) {
      voiceOutboundSilenceMsRef.current += chunkMs
      updateRealtimeVoiceNoiseFloor(rms, 0.06)
    } else {
      voiceOutboundCandidateSpeechMsRef.current = 0
      voiceOutboundPeakRmsRef.current = 0
    }

    if (!voiceOutboundSpeechActiveRef.current) {
      voiceOutboundPreRollRef.current.push(pcmChunk)
      trimRealtimeVoicePreRoll()

      if (
        !isClearSpeech ||
        voiceOutboundCandidateSpeechMsRef.current < VOICE_REQUIRED_CLEAR_SPEECH_MS
      ) {
        return
      }

      voiceOutboundSpeechActiveRef.current = true
      voiceOutboundSegmentMsRef.current = voiceOutboundCandidateSpeechMsRef.current
      enqueueRealtimeVoiceAudio(voiceOutboundPreRollRef.current)
      voiceOutboundPreRollRef.current = []
      setIsVoiceCompanionHearing(true)
      return true
    }

    voiceOutboundSegmentMsRef.current += chunkMs

    if (isClearSpeech) {
      enqueueRealtimeVoiceAudio([pcmChunk])
      if (voiceOutboundSegmentMsRef.current >= VOICE_MAX_SEGMENT_MS) {
        finishRealtimeVoiceGateTurn()
        return false
      }
      return true
    }

    if (voiceOutboundSilenceMsRef.current <= VOICE_TRAILING_SILENCE_MS) {
      enqueueRealtimeVoiceAudio([pcmChunk])
      return true
    }

    finishRealtimeVoiceGateTurn()
    return false
  }

  function enqueueVoiceSegment() {
    const pcmChunks = voicePcmChunksRef.current
    const sampleCount = voicePcmSampleCountRef.current
    const speechSampleCount = voiceSpeechSampleCountRef.current
    resetVoiceSegment()

    if (
      voiceAudioStoppingRef.current ||
      sampleCount === 0 ||
      speechSampleCount < (VOICE_AUDIO_SAMPLE_RATE * VOICE_MIN_SPEECH_MS) / 1000
    ) {
      return
    }

    const segmentChunks = [...pcmChunks]
    voiceFlushQueueRef.current = voiceFlushQueueRef.current
      .catch(() => {
        // Keep later voice segments flowing even if one transcription fails.
      })
      .then(async () => {
        if (voiceAudioStoppingRef.current) {
          return
        }

        setVoiceStatus("Understanding")
        const pcmBuffer = mergePcmChunks(segmentChunks)
        const audioBase64 = await arrayBufferToBase64(pcmBuffer)
        const response = await window.electronAPI.transcribeVoiceAudio({
          audioBase64,
          mimeType: "audio/pcm;rate=24000;encoding=s16le",
        })

        if (!response.success) {
          throw new Error(response.error)
        }

        const transcript = response.data.transcript.trim()
        if (!transcript) {
          setVoiceStatus("Listening")
          return
        }

        setVoiceLastHeard(transcript)
        await submitMessage(transcript, { voice: true })
      })
      .catch((error) => {
        if (!voiceAudioStoppingRef.current) {
          console.error("Voice companion segment failed:", error)
          setVoiceStatus("Voice error")
          showToast(
            "Voice Companion",
            error instanceof Error ? error.message : "Voice chat failed.",
            "error"
          )
        }
      })
  }

  const base64ToBytes = useCallback((base64: string) => {
    const binary = window.atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  }, [])

  const clearVoicePlayback = useCallback(() => {
    voicePlaybackSourcesRef.current.forEach((source) => {
      try {
        source.stop()
      } catch (_error) {
        // Source may already be stopped.
      }
    })
    voicePlaybackSourcesRef.current = []
    voicePlaybackTimeRef.current =
      voicePlaybackContextRef.current?.currentTime ?? 0
    setIsVoiceSpeaking(false)
  }, [])

  const closeVoicePlayback = useCallback(() => {
    clearVoicePlayback()
    if (voicePlaybackContextRef.current) {
      void voicePlaybackContextRef.current.close().catch(() => {
        // Ignore shutdown errors.
      })
      voicePlaybackContextRef.current = null
    }
    voicePlaybackTimeRef.current = 0
  }, [clearVoicePlayback])

  const appendVoiceAssistantTranscript = useCallback((delta: string) => {
    if (!delta) {
      return
    }

    emitSylicaActivity()
    let activeTurnId = activeVoiceAssistantTurnIdRef.current
    if (!activeTurnId) {
      activeTurnId = `voice-assistant-${Date.now()}`
      activeVoiceAssistantTurnIdRef.current = activeTurnId
      globalActiveVoiceAssistantTurnId = activeTurnId
    }

    const turnId = activeTurnId
    const applyDelta = (previousMessages: FollowUpChatMessage[]) => {
      const existingMessage = previousMessages.find(
        (message) => message.id === turnId
      )
      if (existingMessage) {
        return previousMessages.map((message) =>
          message.id === turnId
            ? {
                ...message,
                content: `${message.content}${delta}`,
                pending: true,
              }
            : message
        )
      }

      return [
        ...previousMessages,
        {
          id: turnId,
          role: "assistant",
          content: delta,
          createdAt: Date.now(),
          pending: true,
        },
      ].slice(-VOICE_TRANSCRIPT_MESSAGE_LIMIT)
    }

    updateGlobalVoiceTranscript(applyDelta)
  }, [])

  const finishVoiceAssistantTranscript = useCallback(() => {
    const activeTurnId = activeVoiceAssistantTurnIdRef.current
    activeVoiceAssistantTurnIdRef.current = null
    globalActiveVoiceAssistantTurnId = null
    if (!activeTurnId) {
      return
    }

    emitSylicaActivity()
    const finishTurn = (previousMessages: FollowUpChatMessage[]) =>
      previousMessages.map((message) =>
        message.id === activeTurnId
          ? {
              ...message,
              pending: false,
            }
          : message
      )

    updateGlobalVoiceTranscript(finishTurn)
  }, [])

  const beginVoiceUserTranscript = useCallback(() => {
    if (activeVoiceUserTurnIdRef.current) {
      return
    }

    const nextTurnId = `voice-user-${Date.now()}`
    activeVoiceUserTurnIdRef.current = nextTurnId
    globalActiveVoiceUserTurnId = nextTurnId
    emitSylicaActivity()
    const beginTurn = (previousMessages: FollowUpChatMessage[]) =>
      [
        ...previousMessages,
        {
          id: nextTurnId,
          role: "user",
          content: "Listening...",
          createdAt: Date.now(),
          pending: true,
        },
      ].slice(-VOICE_TRANSCRIPT_MESSAGE_LIMIT)

    updateGlobalVoiceTranscript(beginTurn)
  }, [])

  const appendVoiceUserTranscript = useCallback(
    (delta: string) => {
      if (!delta) {
        return
      }

      emitSylicaActivity()
      let activeTurnId = activeVoiceUserTurnIdRef.current
      if (!activeTurnId) {
        activeTurnId = `voice-user-${Date.now()}`
        activeVoiceUserTurnIdRef.current = activeTurnId
        globalActiveVoiceUserTurnId = activeTurnId
      }

      const turnId = activeTurnId
      const appendDelta = (previousMessages: FollowUpChatMessage[]) => {
        const existingMessage = previousMessages.find(
          (message) => message.id === turnId
        )
        if (!existingMessage) {
          return [
            ...previousMessages,
            {
              id: turnId,
              role: "user",
              content: delta,
              createdAt: Date.now(),
              pending: true,
            },
          ].slice(-VOICE_TRANSCRIPT_MESSAGE_LIMIT)
        }

        return previousMessages.map((message) =>
          message.id === turnId
            ? {
                ...message,
                content:
                  message.content === "Listening..."
                    ? delta
                    : `${message.content}${delta}`,
                pending: true,
              }
            : message
        )
      }

      updateGlobalVoiceTranscript(appendDelta)
    },
    []
  )

  const finishVoiceUserTranscript = useCallback(
    (transcript: string) => {
      const normalizedTranscript = transcript.trim()
      if (!normalizedTranscript) {
        return
      }

      let activeTurnId = activeVoiceUserTurnIdRef.current
      if (!activeTurnId) {
        activeTurnId = `voice-user-${Date.now()}`
      }
      activeVoiceUserTurnIdRef.current = null
      globalActiveVoiceUserTurnId = null

      const turnId = activeTurnId
      emitSylicaActivity()
      const finishTurn = (previousMessages: FollowUpChatMessage[]) => {
        const existingMessage = previousMessages.find(
          (message) => message.id === turnId
        )
        if (!existingMessage) {
          return [
            ...previousMessages,
            {
              id: turnId,
              role: "user",
              content: normalizedTranscript,
              createdAt: Date.now(),
              pending: false,
            },
          ].slice(-VOICE_TRANSCRIPT_MESSAGE_LIMIT)
        }

        return previousMessages.map((message) =>
          message.id === turnId
            ? {
                ...message,
                content: normalizedTranscript,
                pending: false,
              }
            : message
        )
      }

      updateGlobalVoiceTranscript(finishTurn)
    },
    []
  )

  const discardVoiceUserTranscript = useCallback(() => {
    const activeTurnId = activeVoiceUserTurnIdRef.current
    activeVoiceUserTurnIdRef.current = null
    globalActiveVoiceUserTurnId = null
    voiceUserTranscriptDraftRef.current = ""

    if (!activeTurnId) {
      return
    }

    updateGlobalVoiceTranscript((previousMessages) =>
      previousMessages.filter((message) => message.id !== activeTurnId)
    )
  }, [])

  const finishVoiceUserTranscriptFromDraft = useCallback(
    (fallbackText = "No clear voice instruction heard") => {
      const transcript =
        voiceUserTranscriptDraftRef.current.trim() || fallbackText
      finishVoiceUserTranscript(transcript)
    },
    [finishVoiceUserTranscript]
  )

  const clearVoiceThinkingTimeout = useCallback(() => {
    if (voiceThinkingTimeoutRef.current !== null) {
      window.clearTimeout(voiceThinkingTimeoutRef.current)
      voiceThinkingTimeoutRef.current = null
    }
  }, [])

  const scheduleVoiceThinkingTimeout = useCallback(() => {
    clearVoiceThinkingTimeout()
    voiceThinkingTimeoutRef.current = window.setTimeout(() => {
      voiceThinkingTimeoutRef.current = null

      if (
        voiceAudioStoppingRef.current ||
        !globalVoiceSessionActive ||
        voicePlaybackSourcesRef.current.length > 0
      ) {
        return
      }

      finishVoiceAssistantTranscript()
      finishVoiceUserTranscriptFromDraft()
      setIsVoiceCompanionHearing(false)
      setIsVoiceSpeaking(false)
      setVoiceStatus("Listening")
      setVoiceLastHeard((previousTranscript) =>
        previousTranscript === "Listening..."
          ? "No clear voice instruction heard"
          : previousTranscript
      )
    }, VOICE_THINKING_TIMEOUT_MS)
  }, [
    clearVoiceThinkingTimeout,
    finishVoiceAssistantTranscript,
    finishVoiceUserTranscriptFromDraft,
  ])

  const playVoiceAudioDelta = useCallback(
    (audioBase64: string) => {
      const AudioContextConstructor =
        window.AudioContext || (window as any).webkitAudioContext
      if (!AudioContextConstructor) {
        return
      }

      let audioContext = voicePlaybackContextRef.current
      if (!audioContext || audioContext.state === "closed") {
        audioContext = new AudioContextConstructor({
          sampleRate: VOICE_AUDIO_SAMPLE_RATE,
        })
        voicePlaybackContextRef.current = audioContext
        voicePlaybackTimeRef.current = audioContext.currentTime
      }

      if (audioContext.state === "suspended") {
        void audioContext.resume().catch(() => {
          // Ignore resume races.
        })
      }

      const bytes = base64ToBytes(audioBase64)
      const sampleCount = Math.floor(bytes.byteLength / 2)
      if (sampleCount <= 0) {
        return
      }

      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      const audioBuffer = audioContext.createBuffer(
        1,
        sampleCount,
        VOICE_AUDIO_SAMPLE_RATE
      )
      const channelData = audioBuffer.getChannelData(0)
      for (let index = 0; index < sampleCount; index += 1) {
        channelData[index] = view.getInt16(index * 2, true) / 0x8000
      }

      const source = audioContext.createBufferSource()
      source.buffer = audioBuffer
      source.connect(audioContext.destination)

      const startAt = Math.max(
        audioContext.currentTime + 0.02,
        voicePlaybackTimeRef.current || audioContext.currentTime
      )
      voicePlaybackTimeRef.current = startAt + audioBuffer.duration
      voicePlaybackSourcesRef.current.push(source)

      source.onended = () => {
        voicePlaybackSourcesRef.current = voicePlaybackSourcesRef.current.filter(
          (candidate) => candidate !== source
        )
        if (voicePlaybackSourcesRef.current.length === 0) {
          setIsVoiceSpeaking(false)
          if (!voiceAudioStoppingRef.current) {
            setVoiceStatus("Listening")
          }
        }
      }

      setIsVoiceSpeaking(true)
      setVoiceStatus("Speaking")
      source.start(startAt)
    },
    [base64ToBytes]
  )

  const stopVoiceCompanion = (options: { manual?: boolean } = {}) => {
    if (options.manual) {
      markVoiceManualStop()
    }

    if (globalVoiceCleanup && globalVoiceCleanup !== stopVoiceCompanion) {
      globalVoiceCleanup()
      globalVoiceCleanup = null
      emitVoiceActive(false)
      setIsVoiceCompanionActive(false)
      setIsVoiceCompanionHearing(false)
      setIsVoiceSpeaking(false)
      setVoiceStatus("Ready for voice chat")
      return
    }

    voiceAudioStoppingRef.current = true
    globalVoiceSessionActive = false
    globalVoiceCleanup = null
    clearVoiceThinkingTimeout()
    emitVoiceActive(false)
    void window.electronAPI.stopVoiceRealtime().catch(() => {
      // Ignore stop races when the app is closing.
    })

    if (voiceAudioProcessorNodeRef.current) {
      voiceAudioProcessorNodeRef.current.onaudioprocess = null
      try {
        voiceAudioProcessorNodeRef.current.disconnect()
      } catch (_error) {
        // Ignore disconnect errors.
      }
      voiceAudioProcessorNodeRef.current = null
    }

    if (voiceAudioSourceNodeRef.current) {
      try {
        voiceAudioSourceNodeRef.current.disconnect()
      } catch (_error) {
        // Ignore disconnect errors.
      }
      voiceAudioSourceNodeRef.current = null
    }

    if (voiceAudioSinkNodeRef.current) {
      try {
        voiceAudioSinkNodeRef.current.disconnect()
      } catch (_error) {
        // Ignore disconnect errors.
      }
      voiceAudioSinkNodeRef.current = null
    }

    if (voiceAudioContextRef.current) {
      void voiceAudioContextRef.current.close().catch(() => {
        // Ignore shutdown errors.
      })
      voiceAudioContextRef.current = null
    }

    if (voiceAudioStreamRef.current) {
      voiceAudioStreamRef.current.getTracks().forEach((track) => track.stop())
      voiceAudioStreamRef.current = null
    }

    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel()
    }

    closeVoicePlayback()
    voiceResponseTextRef.current = ""
    voiceUserTranscriptDraftRef.current = ""
    activeVoiceUserTurnIdRef.current = null
    activeVoiceAssistantTurnIdRef.current = null
    globalActiveVoiceUserTurnId = null
    globalActiveVoiceAssistantTurnId = null
    setIsVoiceCompanionActive(false)
    setIsVoiceCompanionHearing(false)
    setIsVoiceSpeaking(false)
    setVoiceStatus("Ready for voice chat")
    resetVoiceSegment()
  }

  const startVoiceCompanion = async () => {
    if (
      !isPersistedMode ||
      isLiveSessionActive ||
      isVoiceCompanionActive
    ) {
      return
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      showToast(
        "Voice Companion",
        "Microphone capture is not supported in this desktop runtime.",
        "error"
      )
      return
    }

    try {
      globalVoiceManualStopAt = 0
      setVoiceStatus("Checking screen access")
      const screenPermission =
        await window.electronAPI.requestScreenCaptureAccess({
          openSettingsOnFailure: true,
        })
      if (!screenPermission.granted) {
        const message =
          screenPermission.error ||
          "Screen Recording access is required so Sylica can see your screen."
        setVoiceStatus("Screen access required")
        showToast("Screen Access Needed", message, "error")
        return
      }

      setVoiceStatus("Opening microphone")
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })

      const AudioContextConstructor =
        window.AudioContext || (window as any).webkitAudioContext
      if (!AudioContextConstructor) {
        stream.getTracks().forEach((track) => track.stop())
        throw new Error("Voice audio processing is not supported here.")
      }

      stopVoiceCompanion()
      voiceAudioStoppingRef.current = false
      resetVoiceSegment()
      clearVoiceThinkingTimeout()
      voiceResponseTextRef.current = ""
      voiceUserTranscriptDraftRef.current = ""
      voiceOutboundSendQueueRef.current = Promise.resolve()
      activeVoiceUserTurnIdRef.current = null
      activeVoiceAssistantTurnIdRef.current = null
      clearGlobalVoiceTranscript()
      setMessages([])

      setVoiceStatus("Connecting realtime voice")
      const startResponse = await window.electronAPI.startVoiceRealtime({
        instructions: buildRealtimeVoiceInstructions(
          voiceMemory,
          phoneNotificationContextRef.current,
          voiceLiveContext
        ),
        voice: "marin",
        owner: "widget",
        provider: voiceRealtimeProvider,
      })

      if (!startResponse.success) {
        throw new Error(startResponse.error)
      }

      const audioContext = new AudioContextConstructor({
        sampleRate: VOICE_AUDIO_SAMPLE_RATE,
      })
      const sourceNode = audioContext.createMediaStreamSource(stream)
      const processorNode = audioContext.createScriptProcessor(4096, 1, 1)
      const sinkNode = audioContext.createGain()
      sinkNode.gain.value = 0

      processorNode.onaudioprocess = (event) => {
        if (voiceAudioStoppingRef.current) {
          return
        }

        const inputBuffer = event.inputBuffer
        const frameCount = inputBuffer.length
        const monoSamples = new Float32Array(frameCount)
        const channelCount = inputBuffer.numberOfChannels
        if (channelCount === 0) {
          return
        }

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
        const resampledSamples = resampleAudio(monoSamples, audioContext.sampleRate)
        const pcmChunk = float32ToInt16(resampledSamples)

        if (voiceRealtimeProvider === "deepgram") {
          enqueueRealtimeVoiceAudio([pcmChunk])
          const isSpeech = rms >= getRealtimeVoiceSpeechThreshold()
          if (isSpeech !== voiceIsSpeechActiveRef.current) {
            voiceIsSpeechActiveRef.current = isSpeech
            setIsVoiceCompanionHearing(isSpeech)
          }
          return
        }

        const isSpeech = Boolean(processRealtimeVoiceGate(pcmChunk, rms))
        if (isSpeech !== voiceIsSpeechActiveRef.current) {
          voiceIsSpeechActiveRef.current = isSpeech
          setIsVoiceCompanionHearing(isSpeech)
        }
      }

      sourceNode.connect(processorNode)
      processorNode.connect(sinkNode)
      sinkNode.connect(audioContext.destination)
      await audioContext.resume()

      voiceAudioStreamRef.current = stream
      voiceAudioContextRef.current = audioContext
      voiceAudioSourceNodeRef.current = sourceNode
      voiceAudioProcessorNodeRef.current = processorNode
      voiceAudioSinkNodeRef.current = sinkNode
      globalVoiceSessionActive = true
      globalVoiceCleanup = stopVoiceCompanion
      emitVoiceActive(true)
      setIsVoiceCompanionActive(true)
      setVoiceStatus(`Listening on ${startResponse.data.model}`)
    } catch (error) {
      stopVoiceCompanion()
      const message =
        error instanceof Error ? error.message : "Failed to start voice chat."
      if (/OpenAI API key/i.test(message)) {
        showToast(
          "OpenAI Key Required",
          "OpenAI key was not found in .env or Settings. Add it, then start voice again.",
          "error"
        )
      } else if (/Deepgram API key/i.test(message)) {
        showToast(
          "Deepgram Key Required",
          "Deepgram key was not found in .env. Add it, then start voice again.",
          "error"
        )
      } else {
        showToast("Voice Companion", message, "error")
      }
    }
  }

  useEffect(() => {
    if (
      !voiceAutoStartSignal ||
      lastVoiceAutoStartSignalRef.current === voiceAutoStartSignal
    ) {
      return
    }

    const signalTimestamp = Number(voiceAutoStartSignal)
    if (
      globalVoiceManualStopAt > 0 &&
      (!Number.isFinite(signalTimestamp) || signalTimestamp <= globalVoiceManualStopAt)
    ) {
      return
    }

    if (
      !isPersistedMode ||
      isVoiceCompanionActive ||
      isLiveSessionActive ||
      isSending ||
      isHistoryLoading
    ) {
      return
    }

    lastVoiceAutoStartSignalRef.current = voiceAutoStartSignal
    void startVoiceCompanion()
  }, [
    isHistoryLoading,
    isLiveSessionActive,
    isPersistedMode,
    isSending,
    isVoiceCompanionActive,
    voiceAutoStartSignal,
  ])

  useEffect(() => {
    if (!isPersistedMode) {
      return
    }

    globalVoiceRealtimeUnsubscribe?.()

    const unsubscribe = window.electronAPI.onVoiceRealtimeEvent((event) => {
      if (event.owner === "cursor") {
        return
      }

      emitSylicaActivity()
      globalVoiceSessionActive = true
      emitVoiceActive(true)
      setIsVoiceCompanionActive(true)

      if (event.type === "ready") {
        setVoiceStatus("Realtime voice ready")
        return
      }

      if (event.type === "session_updated") {
        return
      }

      if (event.type === "speech_started") {
        clearVoiceThinkingTimeout()
        voiceUserTranscriptDraftRef.current = ""
        finishVoiceAssistantTranscript()
        clearVoicePlayback()
        beginVoiceUserTranscript()
        setIsVoiceCompanionHearing(true)
        setVoiceLastHeard("Listening...")
        setVoiceStatus("Listening")
        return
      }

      if (event.type === "speech_stopped") {
        setIsVoiceCompanionHearing(false)
        setVoiceStatus("Thinking")
        scheduleVoiceThinkingTimeout()
        return
      }

      if (event.type === "input_transcript_delta") {
        voiceUserTranscriptDraftRef.current += event.delta
        appendVoiceUserTranscript(event.delta)
        setVoiceLastHeard((previousTranscript) =>
          previousTranscript === "Listening..."
            ? event.delta
            : `${previousTranscript}${event.delta}`
        )
        return
      }

      if (event.type === "input_transcript") {
        clearVoiceThinkingTimeout()
        const transcript = normalizeRealtimeVoiceTranscript(event.transcript)
        voiceUserTranscriptDraftRef.current = transcript
        if (isVoiceStopTranscript(transcript)) {
          setVoiceLastHeard(transcript)
          finishVoiceUserTranscript(transcript)
          stopVoiceCompanion({ manual: true })
          return
        }

        if (!isClearRealtimeVoiceIntent(transcript)) {
          discardVoiceUserTranscript()
          setIsVoiceCompanionHearing(false)
          setVoiceLastHeard("")
          setVoiceStatus("Listening")
          return
        }

        setVoiceLastHeard(transcript)
        finishVoiceUserTranscript(transcript)
        setVoiceMemory((previousMemory) => {
          const nextMemory = updateVoiceMemory(previousMemory, transcript)
          if (nextMemory !== previousMemory) {
            void window.electronAPI.updateVoiceRealtimeInstructions({
              instructions: buildRealtimeVoiceInstructions(
                nextMemory,
                phoneNotificationContextRef.current,
                voiceLiveContextRef.current
              ),
              voice: "marin",
            })
          }
          return nextMemory
        })
        void (async () => {
          let handled = false

          // Skip triggers we already early-fired from the assistant's own text
          // so the same task doesn't launch twice in one turn.
          if (!earlyFiredAgentForResponseRef.current) {
            handled =
              (await voiceAgentCommandHandlerRef.current(transcript)) || handled
          }

          handled =
            (await voiceSearchRequestHandlerRef.current(transcript)) || handled

          if (!earlyFiredComputerForResponseRef.current) {
            handled =
              (await voiceComputerCommandHandlerRef.current(transcript)) ||
              handled
          }

          if (handled || voiceAudioStoppingRef.current || !globalVoiceSessionActive) {
            if (
              handled &&
              !voiceAudioStoppingRef.current &&
              voicePlaybackSourcesRef.current.length === 0
            ) {
              setVoiceStatus("Listening")
            }
            return
          }

          const response = await window.electronAPI.requestVoiceRealtimeResponse()
          if (!response.success) {
            throw new Error(response.error)
          }
        })().catch((error) => {
          if (voiceAudioStoppingRef.current) {
            return
          }

          const message =
            error instanceof Error
              ? error.message
              : "Failed to create realtime voice response."
          console.error("Realtime voice response failed:", error)
          setVoiceStatus("Voice error")
          showToast("Voice Companion", message, "error")
        })
        return
      }

      if (event.type === "text_delta") {
        clearVoiceThinkingTimeout()
        if (
          activeVoiceUserTurnIdRef.current &&
          voiceUserTranscriptDraftRef.current.trim()
        ) {
          finishVoiceUserTranscriptFromDraft()
        }
        voiceResponseTextRef.current += event.text
        appendVoiceAssistantTranscript(event.text)
        // Early-fire: if the model has now said "Starting agent mode: ..." or
        // "Starting computer use: ...", kick off the action immediately so
        // the working animation shows without waiting for the final transcript.
        if (
          !earlyFiredAgentForResponseRef.current ||
          !earlyFiredComputerForResponseRef.current
        ) {
          voiceAssistantEarlyTriggerHandlerRef.current(
            voiceResponseTextRef.current
          )
        }
        return
      }

      if (event.type === "audio_delta") {
        clearVoiceThinkingTimeout()
        if (
          activeVoiceUserTurnIdRef.current &&
          voiceUserTranscriptDraftRef.current.trim()
        ) {
          finishVoiceUserTranscriptFromDraft()
        }
        playVoiceAudioDelta(event.audio)
        return
      }

      if (event.type === "response_done") {
        clearVoiceThinkingTimeout()
        if (activeVoiceUserTurnIdRef.current) {
          finishVoiceUserTranscriptFromDraft()
        }
        finishVoiceAssistantTranscript()
        // Reset early-fire flags so the next assistant response can trigger
        // its own actions without being blocked by the previous turn.
        earlyFiredAgentForResponseRef.current = false
        earlyFiredComputerForResponseRef.current = false
        voiceResponseTextRef.current = ""
        if (voicePlaybackSourcesRef.current.length === 0) {
          setIsVoiceSpeaking(false)
          setVoiceStatus("Listening")
        }
        return
      }

      if (event.type === "error") {
        clearVoiceThinkingTimeout()
        console.error("Realtime voice error:", event.error)
        stopVoiceCompanion()
        globalVoiceSessionActive = false
        emitVoiceActive(false)
        setVoiceStatus("Voice error")
        setIsVoiceCompanionActive(false)
        setIsVoiceCompanionHearing(false)
        setIsVoiceSpeaking(false)
        showToast("Voice Companion", event.error, "error")
      }
    })
    globalVoiceRealtimeUnsubscribe = unsubscribe

    return () => {
      if (!globalVoiceSessionActive) {
        unsubscribe()
        if (globalVoiceRealtimeUnsubscribe === unsubscribe) {
          globalVoiceRealtimeUnsubscribe = null
        }
      }
    }
  }, [
    appendVoiceAssistantTranscript,
    appendVoiceUserTranscript,
    beginVoiceUserTranscript,
    clearVoicePlayback,
    clearVoiceThinkingTimeout,
    discardVoiceUserTranscript,
    finishVoiceAssistantTranscript,
    finishVoiceUserTranscript,
    finishVoiceUserTranscriptFromDraft,
    isPersistedMode,
    playVoiceAudioDelta,
    scheduleVoiceThinkingTimeout,
    showToast,
  ])

  useEffect(() => {
    const handleBeforeUnload = () => {
      globalVoiceCleanup?.()
    }

    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload)
    }
  }, [])

  const baseSurfaceClassName =
    mode === "follow_up"
      ? "w-full min-w-0 space-y-1.5 text-white"
      : panelMode === "voice" || panelMode === "live"
        ? "w-full min-w-0 space-y-2.5 text-white"
        : "sylica-liquid-panel w-full min-w-0 space-y-2 p-2.5 text-white"
  const isVoiceOrLivePanel = panelMode === "voice" || panelMode === "live"
  const surfaceClassName = className.trim().length
    ? `${baseSurfaceClassName} ${className}`
    : baseSurfaceClassName

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
      return "Computer task helper"
    }

    if (computerUseState.status === "starting") {
      return "Starting computer task..."
    }

    if (computerUseState.status === "stopping") {
      return "Stopping computer task..."
    }

    if (computerUseState.status === "waiting_for_secret") {
      return "Waiting for manual login..."
    }

    return computerUseState.currentAction || "Running computer task..."
  })()

  const computerPreviewLabel =
    computerUseState.currentUrl.trim() ||
    (computerUseState.needsSecretInput
      ? "Complete the secret step in Chrome, then continue."
      : "Launch PC or browser automation from the computer icon in the widget strip.")

  const voiceStatusLabel = isVoiceCompanionActive
    ? isVoiceSpeaking
      ? "Realtime voice speaking"
      : isSending
        ? "Realtime voice thinking"
        : isVoiceCompanionHearing
          ? "Realtime voice hearing you"
          : "Realtime voice listening"
    : "Realtime voice"
  const voicePreviewLabel =
    voiceLastHeard.trim() ||
    (voiceMemory.trim()
      ? "Uses your screen and remembered context."
      : "Talk naturally; I will use your screen when useful.")
  const voiceProviderOptions: Array<{
    value: VoiceRealtimeProvider
    label: string
  }> = [
    { value: "openai", label: "OpenAI" },
    { value: "deepgram", label: "DG" },
  ]

  const threadButtonsDisabled =
    isSending ||
    isLiveSessionActive ||
    isComputerUseSessionActive ||
    isVoiceCompanionActive
  const inputPlaceholder =
    isLiveSessionActive && isPersistedMode
      ? "Add a live instruction..."
      : isSelectedComputerThread
        ? "Start a new computer task from the computer icon."
        : placeholder

  return (
    <div className={surfaceClassName}>
      {isPersistedMode && (
        <div className="space-y-2">
          {!voiceFocused && (
          <div className="flex items-center gap-2 overflow-x-auto pb-1 text-[11px] [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <button
              type="button"
              onClick={startNewChat}
              disabled={threadButtonsDisabled}
              className={`shrink-0 rounded-full border px-2.5 py-1 transition ${
                activeThreadId === null
                  ? "border-[#a8d8c4]/30 bg-[rgba(168, 216, 196, 0.12)] text-white"
                  : "border-white/10 bg-white/[0.05] text-white/70 hover:text-white"
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
                    ? "border-[#a8d8c4]/30 bg-[rgba(168, 216, 196, 0.12)] text-white"
                    : "border-white/10 bg-white/[0.05] text-white/70 hover:text-white"
                } ${threadButtonsDisabled ? "cursor-not-allowed opacity-60" : ""}`}
                title={thread.title}
              >
                <span className="inline-flex items-center gap-1.5">
                  {thread.mode === "live_interview" && (
                    <span className="rounded-full border border-[#a8d8c4]/20 bg-[#1f2a26] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] text-[#cce8db]">
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
          )}

          <div className="flex items-center justify-between gap-2 border-b border-white/8 px-1 pb-2 text-[10px] text-white/72">
            <div className="min-w-0 flex-1">
              {panelMode === "voice" ? (
                <>
                  <div className="flex items-center gap-1.5 truncate text-white">
                    <Volume2 className="h-3.5 w-3.5 text-[#a8d8c4]" />
                    <span className="truncate">{voiceStatusLabel}</span>
                  </div>
                  <div className="truncate text-[9px] text-white/42">
                    {voiceStatus} - {voicePreviewLabel}
                  </div>
                </>
              ) : (
                <>
                  <div className="truncate text-white">{liveStatusLabel}</div>
                  <div className="truncate text-[9px] text-white/42">
                    {livePreviewLabel}
                  </div>
                </>
              )}
            </div>
            {panelMode === "voice" && (
              <div className="flex shrink-0 items-center rounded-full border border-white/10 bg-white/[0.04] p-0.5 text-[9px]">
                {voiceProviderOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    disabled={isVoiceCompanionActive || isSending}
                    onClick={() => {
                      setVoiceRealtimeProvider(option.value)
                      persistVoiceRealtimeProvider(option.value)
                    }}
                    className={`h-6 rounded-full px-2 transition ${
                      voiceRealtimeProvider === option.value
                        ? "bg-[#a8d8c4] text-black"
                        : "text-white/58 hover:text-white"
                    } ${
                      isVoiceCompanionActive || isSending
                        ? "cursor-not-allowed opacity-55"
                        : ""
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
            <Button
              type="button"
              size="sm"
              onClick={() => {
                void (
                  panelMode === "voice"
                    ? isVoiceCompanionActive
                      ? stopVoiceCompanion({ manual: true })
                      : startVoiceCompanion()
                    : isLiveSessionActive
                      ? stopLiveInterview()
                      : startLiveInterview()
                )
              }}
              disabled={
                panelMode === "voice"
                  ? !isVoiceCompanionActive &&
                    (isSending || isLiveSessionActive || isHistoryLoading)
                  : isLiveActionPending ||
                    isSending ||
                    isHistoryLoading ||
                    isVoiceCompanionActive
              }
              className={`h-7 rounded-full px-3 text-[10px] ${
                (panelMode === "voice" ? isVoiceCompanionActive : isLiveSessionActive)
                  ? "bg-white/10 text-white hover:bg-white/15"
                  : "bg-[#a8d8c4] text-black hover:bg-[#bce5d2]"
              }`}
            >
              {panelMode === "voice" ? (
                isVoiceCompanionActive ? (
                  <span className="inline-flex items-center gap-1">
                    <MicOff className="h-3 w-3" />
                    Stop
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <Mic className="h-3 w-3" />
                    Start
                  </span>
                )
              ) : isLiveActionPending ? (
                "..."
              ) : isLiveSessionActive ? (
                "Stop Live"
              ) : (
                "Start Live"
              )}
            </Button>
          </div>

          {!voiceFocused && panelMode === "voice" && (
          <div className="sylica-glass-chip flex items-center justify-between gap-2 rounded-[16px] px-3 py-2 text-[10px] text-white/62">
            <div className="min-w-0 flex-1">
              {panelMode === "voice" ? (
                <>
                  <div className="truncate">{liveStatusLabel}</div>
                  <div className="truncate text-[9px] text-white/42">
                    {livePreviewLabel}
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-1.5 truncate">
                    <Volume2 className="h-3 w-3 text-[#a8d8c4]/80" />
                    <span className="truncate">{voiceStatusLabel}</span>
                  </div>
                  <div className="truncate text-[9px] text-white/42">
                    {voiceStatus} - {voicePreviewLabel}
                  </div>
                </>
              )}
            </div>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                void (
                  panelMode === "voice"
                    ? isLiveSessionActive
                      ? stopLiveInterview()
                      : startLiveInterview()
                  : isVoiceCompanionActive
                      ? stopVoiceCompanion({ manual: true })
                      : startVoiceCompanion()
                )
              }}
              disabled={
                panelMode === "voice"
                  ? isLiveActionPending ||
                    isSending ||
                    isHistoryLoading ||
                    isVoiceCompanionActive
                  : !isVoiceCompanionActive &&
                    (isSending || isLiveSessionActive || isHistoryLoading)
              }
              className={`h-6 rounded-full px-2.5 text-[10px] ${
                (panelMode === "voice" ? isLiveSessionActive : isVoiceCompanionActive)
                  ? "bg-white/10 text-white hover:bg-white/15"
                  : "bg-[#a8d8c4] text-black hover:bg-[#bce5d2]"
              }`}
            >
              {panelMode === "voice" ? (
                isLiveActionPending ? (
                  "..."
                ) : isLiveSessionActive ? (
                  "Stop Live"
                ) : (
                  "Live Interview"
                )
              ) : isVoiceCompanionActive ? (
                <span className="inline-flex items-center gap-1">
                  <MicOff className="h-3 w-3" />
                  Stop
                </span>
              ) : (
                <span className="inline-flex items-center gap-1">
                  <Mic className="h-3 w-3" />
                  Voice
                </span>
              )}
            </Button>
          </div>
          )}

          {(isComputerUseSessionActive || isSelectedComputerThread) && (
            <div className="flex items-center justify-between gap-2 border-b border-sky-300/12 px-1 pb-2 text-[10px] text-white/72">
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
          className={`${maxHeightClassName} space-y-2 overflow-y-auto ${isVoiceOrLivePanel ? "pr-0" : "pr-1"} [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden`}
        >
          {displayedMessages.map((message, index) => {
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
                  } space-y-1.5 ${
                    isLiveSuggestionMessage
                      ? "rounded-[14px] border border-[#a8d8c4]/16 bg-[#a8d8c4]/10 px-2.5 py-2 text-white backdrop-blur-xl"
                      : isComputerUseMessage
                        ? "rounded-[14px] border border-sky-300/16 bg-sky-300/10 px-2.5 py-2 text-white backdrop-blur-xl"
                      : message.role === "user"
                        ? "rounded-[14px] bg-[var(--sylica-accent-soft)] px-2.5 py-1.5 text-white"
                      : message.error
                          ? "rounded-[14px] bg-red-500/10 px-3 py-2 text-red-100"
                          : "px-1 py-1 text-white/[0.92]"
                  } ${message.pending ? "opacity-75" : ""}`}
                >
                  {isLiveSuggestionMessage && (
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 text-[9px] uppercase tracking-[0.14em] text-[#cce8db]">
                        <span className="rounded-full border border-[#a8d8c4]/20 bg-[#1f2a26] px-1.5 py-0.5">
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

      <div
        className={
          isCompactFollowUpComposer
            ? "sylica-glass-chip flex items-center gap-1.5 rounded-full px-2 py-1"
            : isVoiceOrLivePanel
              ? "sylica-glass-chip flex items-center gap-1.5 rounded-full px-2 py-0.5"
              : "sylica-glass-chip flex items-end gap-1.5 rounded-full px-2.5 py-1.5"
        }
      >
        {isCompactFollowUpComposer && quickActions.length > 0 && (
          <div className="flex shrink-0 items-center gap-1">
            {quickActions.map((action) => (
              <button
                key={action.label}
                type="button"
                onClick={() => {
                  void submitMessage(action.message)
                }}
                disabled={isSending || isSelectedComputerThread}
                title={action.title || action.label}
                className="sylica-dock-tab rounded-full border border-[#a8d8c4]/18 bg-[#a8d8c4]/10 px-2 py-1 text-[10px] font-medium leading-none text-[#cce8db] transition hover:bg-[#a8d8c4]/16 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
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
          className={
            isCompactFollowUpComposer
              ? "max-h-[58px] min-h-[18px] flex-1 resize-none bg-transparent py-0 text-[10.5px] leading-[1.3] text-white outline-none placeholder:text-white/24"
              : isVoiceOrLivePanel
                ? "max-h-[72px] min-h-[19px] flex-1 resize-none bg-transparent py-0 text-[11px] leading-[1.35] text-white outline-none placeholder:text-white/26"
              : "max-h-[136px] min-h-[24px] flex-1 resize-none bg-transparent py-1 text-[12px] leading-[1.45] text-white outline-none placeholder:text-white/28"
          }
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
          className={
            isCompactFollowUpComposer
              ? "sylica-send-button h-7 w-7 rounded-full bg-[var(--sylica-accent)] text-[#0d1418] hover:brightness-110"
              : isVoiceOrLivePanel
                ? "sylica-send-button h-7 w-7 rounded-full bg-[var(--sylica-accent)] text-[#0d1418] hover:brightness-110"
              : "sylica-send-button h-8 w-8 rounded-full bg-[var(--sylica-accent)] text-[#0d1418] hover:brightness-110"
          }
        >
          {isSending ? "..." : <SendHorizontal className={isCompactFollowUpComposer || isVoiceOrLivePanel ? "h-3.5 w-3.5" : "h-4 w-4"} />}
        </Button>
      </div>
    </div>
  )
}
