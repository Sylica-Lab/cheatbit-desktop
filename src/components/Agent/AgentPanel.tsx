import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkBreaks from "remark-breaks"
import {
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Compass,
  Computer,
  ExternalLink,
  FileText,
  FolderOpen,
  Globe,
  Hammer,
  Headphones,
  Loader2,
  Lightbulb,
  MessagesSquare,
  SendHorizontal,
  Sparkles,
  Square,
  Wand2,
  XCircle,
} from "lucide-react"
import {
  type AgentArtifact,
  type AgentPhase,
  type AgentState,
} from "../../../shared/agent"
import {
  type ComputerUseState,
  type FollowUpChatMessage,
} from "../../../shared/followUpChat"
import { useToast } from "../../contexts/toast"

interface AgentPanelProps {
  state: AgentState
  onStateChange: (state: AgentState) => void
  onOpenInterviewMode?: () => void
  computerUseState?: ComputerUseState
  onStartComputerTask?: (task: string) => Promise<void> | void
  onStopComputerTask?: () => Promise<void> | void
  onResumeComputerTask?: () => Promise<void> | void
}

type AgentMode = "plan" | "build"
type RoutedIntent = "chat" | "build" | "browse"

const ACTIVE_AGENT_STATUSES: AgentState["status"][] = [
  "planning",
  "awaiting_workspace",
  "awaiting_approval",
  "running",
]

function isActiveAgentStatus(status: AgentState["status"]): boolean {
  return ACTIVE_AGENT_STATUSES.includes(status)
}

function isActiveComputerStatus(status: ComputerUseState["status"] | undefined): boolean {
  return (
    status === "starting" ||
    status === "running" ||
    status === "waiting_for_secret" ||
    status === "stopping"
  )
}

function getAgentStatusCopy(status: AgentState["status"]): string {
  switch (status) {
    case "planning":
      return "Planning"
    case "awaiting_workspace":
      return "Choose folder"
    case "awaiting_approval":
      return "Needs approval"
    case "running":
      return "Building"
    case "completed":
      return "Done"
    case "error":
      return "Error"
    case "stopped":
      return "Stopped"
    default:
      return "Idle"
  }
}

function getFileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

function getActivePhase(state: AgentState): AgentPhase | null {
  if (!state.activePhaseId) return null
  return state.phases.find((phase) => phase.id === state.activePhaseId) || null
}

const BUILD_KEYWORDS =
  /\b(build|create|make( me| us)?|develop|implement|scaffold|set up|setup|spin up|generate|design|write|code(?:\b| (?:me|us|a|an|the)))\b.*\b(app|website|web ?app|page|landing|component|api|backend|frontend|service|script|game|dashboard|tool|portal|server|library|repo|project|next\.?js|react|vue|svelte|python|typescript|node\.?js|express)\b/i

const BROWSE_KEYWORDS =
  /\b(open (chrome|browser|firefox|edge)|browse to|navigate to|go to (https?:\/\/|www\.)|click on|fill out|sign in to|log ?in(to)? \w|search (google|youtube|amazon)|on (?:google|youtube|gmail|amazon|twitter)|fill in (?:the )?form|automate (?:the )?browser|tab|website (?:to|at))\b/i

const URL_HINT = /\bhttps?:\/\/|\bwww\.[\w-]+\.[a-z]{2,}/i

function detectIntent(text: string, mode: AgentMode): RoutedIntent {
  const trimmed = text.trim()
  if (!trimmed) return "chat"
  if (mode === "plan") return "chat"

  if (BROWSE_KEYWORDS.test(trimmed) || URL_HINT.test(trimmed)) {
    return "browse"
  }
  if (BUILD_KEYWORDS.test(trimmed)) {
    return "build"
  }
  // Heuristic: a question is usually chat
  if (/^(what|why|how|when|where|who|which|should|can|could|do (?:i|we|you)|is|are)\b/i.test(trimmed) ||
      trimmed.endsWith("?")) {
    return "chat"
  }
  // Short imperative starting with build verb -> build
  if (/^(build|create|make|develop|implement|scaffold|generate|design|code|write)\b/i.test(trimmed)) {
    return "build"
  }
  return "chat"
}

function getIntentMeta(intent: RoutedIntent): {
  label: string
  description: string
  Icon: React.ComponentType<{ className?: string }>
} {
  switch (intent) {
    case "build":
      return {
        label: "Build",
        description: "I'll spin up the agent and start building this.",
        Icon: Hammer,
      }
    case "browse":
      return {
        label: "Browser",
        description: "I'll drive the browser to do this for you.",
        Icon: Globe,
      }
    default:
      return {
        label: "Chat",
        description: "Just chatting — I'll think it through with you.",
        Icon: MessagesSquare,
      }
  }
}

function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

const AgentPanel: React.FC<AgentPanelProps> = ({
  state,
  onStateChange,
  onOpenInterviewMode,
  computerUseState,
  onStartComputerTask,
  onStopComputerTask,
}) => {
  const { showToast } = useToast()
  const [mode, setMode] = useState<AgentMode>("plan")
  const [input, setInput] = useState("")
  const [messages, setMessages] = useState<FollowUpChatMessage[]>([])
  const [isSending, setIsSending] = useState(false)
  const [showTaskDetails, setShowTaskDetails] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const isAgentActive = isActiveAgentStatus(state.status)
  const isBrowserActive = isActiveComputerStatus(computerUseState?.status)
  const isAnyToolRunning = isAgentActive || isBrowserActive

  // Auto-open the task details whenever a tool starts running so the panel
  // shows live progress immediately when the user opens it from the dock pill.
  useEffect(() => {
    if (isAnyToolRunning) {
      setShowTaskDetails(true)
    }
  }, [isAnyToolRunning])
  const activePhase = useMemo(() => getActivePhase(state), [state])
  const intent = detectIntent(input, mode)
  const intentMeta = getIntentMeta(intent)
  const canSend = input.trim().length > 0 && !isSending

  // Auto-grow textarea
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = "0px"
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [input])

  // Scroll to bottom on new messages
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
  }, [messages.length, state.events.length])

  // Seed welcome message when entering panel for first time
  useEffect(() => {
    if (messages.length === 0) {
      const greeting: FollowUpChatMessage = {
        id: "welcome",
        role: "assistant",
        content:
          mode === "plan"
            ? "**Plan mode** — let's think this through. Tell me what you have in mind and I'll help shape it before we build."
            : "**Build mode** — describe what you want. I'll figure out whether to chat, write code, or drive the browser.",
        createdAt: Date.now(),
      }
      setMessages([greeting])
    }
    // We deliberately only fire this once per mount per mode change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  const switchMode = (next: AgentMode) => {
    if (next === mode) return
    setMode(next)
    setMessages([])
  }

  const pushMessage = useCallback((msg: FollowUpChatMessage) => {
    setMessages((prev) => [...prev, msg])
  }, [])

  const updateMessage = useCallback(
    (id: string, update: Partial<FollowUpChatMessage>) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, ...update } : m))
      )
    },
    []
  )

  const runChat = async (userText: string) => {
    const assistantId = makeId()
    pushMessage({
      id: assistantId,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
      pending: true,
    })

    try {
      const history = messages
        .filter((m) => m.id !== "welcome")
        .slice(-12)
        .map((m) => ({ role: m.role, content: m.content }))

      const response = await window.electronAPI.submitTextFollowUp({
        message: userText,
        currentContext: mode === "plan" ? "Planning session" : "Building session",
        chatHistory: history,
        mode: "agent",
      })

      if (!response.success) {
        updateMessage(assistantId, {
          content: response.error || "Something went wrong.",
          pending: false,
          error: true,
        })
        return
      }
      updateMessage(assistantId, {
        content: response.data.reply,
        pending: false,
      })
    } catch (error) {
      updateMessage(assistantId, {
        content: error instanceof Error ? error.message : "Request failed.",
        pending: false,
        error: true,
      })
    }
  }

  const runBuild = async (userText: string) => {
    const assistantId = makeId()
    pushMessage({
      id: assistantId,
      role: "assistant",
      content: `Starting build agent for: _${userText}_`,
      createdAt: Date.now(),
      pending: true,
    })

    try {
      const response = await window.electronAPI.startAgentTask({
        prompt: userText,
      })
      if (!response.success) {
        updateMessage(assistantId, {
          content: response.error || "Failed to start the agent.",
          pending: false,
          error: true,
        })
        return
      }
      onStateChange(response.data.state)
      updateMessage(assistantId, {
        content: `Agent is on it. I'll show progress below.`,
        pending: false,
      })
      setShowTaskDetails(true)
    } catch (error) {
      updateMessage(assistantId, {
        content: error instanceof Error ? error.message : "Failed to start.",
        pending: false,
        error: true,
      })
    }
  }

  const runBrowse = async (userText: string) => {
    if (!onStartComputerTask) {
      pushMessage({
        id: makeId(),
        role: "assistant",
        content: "Browser control isn't wired up in this view.",
        createdAt: Date.now(),
        error: true,
      })
      return
    }

    const assistantId = makeId()
    pushMessage({
      id: assistantId,
      role: "assistant",
      content: `Driving the browser to: _${userText}_`,
      createdAt: Date.now(),
      pending: true,
    })

    try {
      await onStartComputerTask(userText)
      updateMessage(assistantId, {
        content: `Browser is on it. Watch progress below.`,
        pending: false,
      })
      setShowTaskDetails(true)
    } catch (error) {
      updateMessage(assistantId, {
        content: error instanceof Error ? error.message : "Failed to start.",
        pending: false,
        error: true,
      })
    }
  }

  const handleSubmit = async () => {
    const text = input.trim()
    if (!text || isSending) return

    setInput("")
    setIsSending(true)
    pushMessage({
      id: makeId(),
      role: "user",
      content: text,
      createdAt: Date.now(),
    })

    try {
      const routed = detectIntent(text, mode)
      if (routed === "build") {
        await runBuild(text)
      } else if (routed === "browse") {
        await runBrowse(text)
      } else {
        await runChat(text)
      }
    } finally {
      setIsSending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void handleSubmit()
    }
  }

  const chooseWorkspace = async () => {
    const response = await window.electronAPI.selectAgentWorkspace()
    if (!response.success) {
      showToast("Agent", response.error || "Workspace was not selected.", "neutral")
      return
    }
    pushMessage({
      id: makeId(),
      role: "assistant",
      content: `Workspace set to \`${getFileName(response.data.workspacePath)}\`.`,
      createdAt: Date.now(),
    })
  }

  const approvePhase = async () => {
    if (!state.taskId || !activePhase) return
    const response = await window.electronAPI.approveAgentPhase({
      taskId: state.taskId,
      phaseId: activePhase.id,
    })
    if (!response.success) {
      showToast("Agent", response.error || "Failed to approve phase.", "error")
      return
    }
    onStateChange(response.data.state)
  }

  const rejectPhase = async () => {
    if (!state.taskId || !activePhase) return
    const response = await window.electronAPI.rejectAgentPhase({
      taskId: state.taskId,
      phaseId: activePhase.id,
    })
    if (!response.success) {
      showToast("Agent", response.error || "Failed to reject phase.", "error")
      return
    }
    onStateChange(response.data.state)
  }

  const stopAll = async () => {
    if (isAgentActive) {
      const response = await window.electronAPI.stopAgentTask()
      if (response.success) onStateChange(response.data.state)
    }
    if (isBrowserActive && onStopComputerTask) {
      await onStopComputerTask()
    }
  }

  const openArtifact = async (artifact: AgentArtifact) => {
    const response = await window.electronAPI.openAgentArtifact({
      artifactId: artifact.id,
    })
    if (!response.success) {
      showToast("Agent", response.error || "Failed to open artifact.", "error")
    }
  }

  const openWorkspace = async () => {
    const response = await window.electronAPI.openAgentWorkspace()
    if (!response.success) {
      showToast("Agent", response.error || "No workspace to open.", "error")
    }
  }

  return (
    <div className="flex w-full max-w-[var(--sylica-widget-panel-width)] flex-col gap-2" style={{ color: "rgba(255,255,255,0.9)" }}>
      {/* Header: Mode toggle + tool status. Right padding reserves space for
          the panel's absolute close (X) button so it doesn't sit on top of the
          Interview / Stop pills — same minimize affordance as the voice panel. */}
      <div className="flex items-center justify-between gap-2 px-0.5 pr-7">
        <div className="flex items-center gap-1.5">
          <span className="grid h-5 w-5 place-items-center rounded-full sylica-icon-pop" style={{ backgroundColor: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.9)" }}>
            <Brain className="h-3 w-3" />
          </span>
          <span className="text-[11px] font-semibold tracking-tight" style={{ color: "rgba(255,255,255,0.95)" }}>
            Agent
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onOpenInterviewMode && !isAnyToolRunning && (
            <button
              type="button"
              onClick={onOpenInterviewMode}
              className="sylica-pop-btn flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] transition hover:border-white/20"
              style={{ borderColor: "rgba(255,255,255,0.1)", backgroundColor: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.8)" }}
              title="Switch to Interview Mode"
            >
              <Headphones className="h-2.5 w-2.5" />
              Interview
            </button>
          )}
          {isAnyToolRunning && (
            <button
              type="button"
              onClick={() => void stopAll()}
              className="sylica-pop-btn flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] transition"
              style={{ backgroundColor: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.9)" }}
            >
              <Square className="h-2.5 w-2.5" />
              Stop
            </button>
          )}
        </div>
      </div>

      {/* Plan / Build segmented control */}
      <div className="flex items-center gap-1 rounded-full border p-0.5" style={{ borderColor: "rgba(255,255,255,0.08)", backgroundColor: "rgba(255,255,255,0.03)" }}>
        <button
          type="button"
          onClick={() => switchMode("plan")}
          className="sylica-pop-btn flex flex-1 items-center justify-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium transition"
          style={mode === "plan" ? { backgroundColor: "rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.95)" } : { color: "rgba(255,255,255,0.65)" }}
        >
          <Lightbulb className="h-3 w-3" />
          Plan
        </button>
        <button
          type="button"
          onClick={() => switchMode("build")}
          className="sylica-pop-btn flex flex-1 items-center justify-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium transition"
          style={mode === "build" ? { backgroundColor: "rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.95)" } : { color: "rgba(255,255,255,0.65)" }}
        >
          <Hammer className="h-3 w-3" />
          Build
        </button>
      </div>

      {/* Scrollable conversation */}
      <div
        ref={scrollRef}
        className="sylica-panel-scroll flex flex-col gap-2 pr-0.5"
        style={{ maxHeight: "min(22rem, 50vh)" }}
      >
        {messages.map((message) => (
          <div
            key={message.id}
            className={`sylica-message-enter flex ${
              message.role === "user" ? "justify-end" : "justify-start"
            }`}
          >
            <div
              className={`max-w-[92%] rounded-[12px] px-2.5 py-1.5 text-[11px] leading-[1.5] ${
                message.role === "user"
                  ? "bg-white/10"
                  : message.error
                    ? "bg-red-500/10"
                    : ""
              } ${message.pending ? "opacity-70" : ""}`}
              style={{
                color: message.error ? "rgba(254,202,202,0.95)" : "rgba(255,255,255,0.95)",
                backgroundColor: message.role === "user" ? "rgba(255,255,255,0.08)" : message.error ? "rgba(239,68,68,0.12)" : "transparent"
              }}
            >
              {message.pending && message.content === "" ? (
                <span className="inline-flex items-center gap-1.5" style={{ color: "rgba(255,255,255,0.6)" }}>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Thinking…
                </span>
              ) : (
                <div className="prose prose-invert prose-sm max-w-none text-[11px] leading-[1.5] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&>p]:my-1 [&>ul]:my-1 [&>ol]:my-1 [&_code]:rounded [&_code]:bg-black/30 [&_code]:px-1 [&_code]:py-0.5">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkBreaks]}
                  >
                    {message.content}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          </div>
        ))}

        {/* Inline live task progress — shows both blocks when both tools run together */}
        {isAnyToolRunning && (
          <div className="rounded-xl border p-2 space-y-2" style={{ borderColor: "rgba(255,255,255,0.06)", backgroundColor: "rgba(255,255,255,0.02)" }}>
            <button
              type="button"
              onClick={() => setShowTaskDetails((v) => !v)}
              className="flex w-full items-center justify-between gap-2 text-[10px]"
              style={{ color: "rgba(255,255,255,0.8)" }}
            >
              <span className="flex items-center gap-1.5 flex-wrap">
                {isAgentActive && (
                  <span className="flex items-center gap-1">
                    <Wand2 className="h-3 w-3" style={{ color: "rgba(255,255,255,0.7)" }} />
                    <span className="font-medium" style={{ color: "rgba(255,255,255,0.95)" }}>Working</span>
                    <span style={{ color: "rgba(255,255,255,0.55)" }}>
                      {getAgentStatusCopy(state.status)}
                    </span>
                  </span>
                )}
                {isAgentActive && isBrowserActive && (
                  <span style={{ color: "rgba(255,255,255,0.3)" }}>·</span>
                )}
                {isBrowserActive && (
                  <span className="flex items-center gap-1">
                    <Compass className="h-3 w-3" style={{ color: "rgba(255,255,255,0.7)" }} />
                    <span className="font-medium" style={{ color: "rgba(255,255,255,0.95)" }}>Using</span>
                    <span style={{ color: "rgba(255,255,255,0.55)" }}>
                      {computerUseState?.currentAction || computerUseState?.status || ""}
                    </span>
                  </span>
                )}
              </span>
              {showTaskDetails ? (
                <ChevronUp className="h-3 w-3" style={{ color: "rgba(255,255,255,0.6)" }} />
              ) : (
                <ChevronDown className="h-3 w-3" style={{ color: "rgba(255,255,255,0.6)" }} />
              )}
            </button>

            {showTaskDetails && (
              <div className="space-y-2 border-t pt-2" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
                {isBrowserActive && computerUseState?.currentUrl && (
                  <div className="flex items-center gap-1.5 text-[9px]" style={{ color: "rgba(255,255,255,0.6)" }}>
                    <Globe className="h-2.5 w-2.5 shrink-0" />
                    <span className="truncate">{computerUseState.currentUrl}</span>
                  </div>
                )}
                {isAgentActive && state.events.slice(-3).map((event) => (
                  <div key={event.id} className="flex gap-1.5 text-[9px]" style={{ color: "rgba(255,255,255,0.6)" }}>
                    <span className="mt-0.5 h-1 w-1 shrink-0 rounded-full" style={{ backgroundColor: "rgba(255,255,255,0.4)" }} />
                    <span className="line-clamp-2">{event.message}</span>
                  </div>
                ))}
                {state.phases.length > 0 && (
                  <div className="text-[9px]" style={{ color: "rgba(255,255,255,0.55)" }}>
                    Phases: {state.phases.length}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Approval needed inline */}
        {activePhase && state.status === "awaiting_approval" && (
          <div className="rounded-xl border p-2" style={{ borderColor: "rgba(255,255,255,0.1)", backgroundColor: "rgba(255,255,255,0.04)" }}>
            <div className="text-[10px] font-medium" style={{ color: "rgba(255,255,255,0.95)" }}>
              {activePhase.title}
            </div>
            <p className="line-clamp-2 text-[9px]" style={{ color: "rgba(255,255,255,0.6)" }}>{activePhase.goal}</p>
            <div className="mt-1.5 flex gap-1">
              <button
                type="button"
                onClick={() => void approvePhase()}
                className="sylica-pop-btn flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1 text-[9px] font-medium transition"
                style={{ backgroundColor: "rgba(255,255,255,0.92)", color: "#1a1c20" }}
              >
                <CheckCircle2 className="h-3 w-3" />
                Approve
              </button>
              <button
                type="button"
                onClick={() => void rejectPhase()}
                className="sylica-pop-btn flex items-center justify-center gap-1 rounded-lg border px-2 py-1 text-[9px] transition"
                style={{ borderColor: "rgba(255,255,255,0.1)", backgroundColor: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.85)" }}
              >
                <XCircle className="h-3 w-3" />
                Reject
              </button>
            </div>
          </div>
        )}

        {/* Workspace needed inline */}
        {state.status === "awaiting_workspace" && (
          <div className="flex items-center justify-between gap-2 rounded-xl border px-2 py-1.5" style={{ borderColor: "rgba(255,255,255,0.06)", backgroundColor: "rgba(255,255,255,0.03)" }}>
            <div className="flex min-w-0 items-center gap-1.5">
              <FolderOpen className="h-3 w-3 shrink-0" style={{ color: "rgba(255,255,255,0.6)" }} />
              <span className="truncate text-[10px]" style={{ color: "rgba(255,255,255,0.75)" }}>
                Pick a folder for this build
              </span>
            </div>
            <button
              type="button"
              onClick={() => void chooseWorkspace()}
              className="sylica-pop-btn shrink-0 rounded-md px-2 py-0.5 text-[9px] font-medium transition"
              style={{ backgroundColor: "rgba(255,255,255,0.92)", color: "#1a1c20" }}
            >
              Choose
            </button>
          </div>
        )}

        {/* Artifacts inline */}
        {state.artifacts.length > 0 && (
          <div className="rounded-xl border p-2" style={{ borderColor: "rgba(255,255,255,0.05)", backgroundColor: "rgba(255,255,255,0.02)" }}>
            <div className="flex items-center justify-between pb-1.5 text-[10px]" style={{ color: "rgba(255,255,255,0.75)" }}>
              <span className="flex items-center gap-1.5">
                <Sparkles className="h-3 w-3" />
                Artifacts ({state.artifacts.length})
              </span>
              <button
                type="button"
                onClick={() => void openWorkspace()}
                className="sylica-pop-btn rounded text-[9px] transition"
                style={{ color: "rgba(255,255,255,0.6)" }}
              >
                Open folder
              </button>
            </div>
            <div className="space-y-1">
              {state.artifacts.slice(-3).map((artifact) => (
                <div
                  key={artifact.id}
                  className="flex items-center gap-1.5 rounded-lg border px-2 py-1"
                  style={{ borderColor: "rgba(255,255,255,0.04)", backgroundColor: "rgba(0,0,0,0.15)" }}
                >
                  <FileText className="h-3 w-3 shrink-0" style={{ color: "rgba(255,255,255,0.5)" }} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[9px]" style={{ color: "rgba(255,255,255,0.75)" }}>
                      {artifact.title}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void openArtifact(artifact)}
                    className="sylica-pop-btn rounded p-1 transition"
                    style={{ backgroundColor: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.6)" }}
                  >
                    <ExternalLink className="h-2.5 w-2.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Composer */}
      <div
        className="rounded-xl border transition focus-within:border-white/20"
        style={{ borderColor: "rgba(255,255,255,0.08)", backgroundColor: "rgba(255,255,255,0.03)" }}
      >
        <textarea
          ref={inputRef}
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            mode === "plan"
              ? "Talk through your idea…"
              : "Build something, browse the web, or just ask…"
          }
          className="block w-full resize-none bg-transparent px-2.5 py-2 text-[11px] leading-[1.5] outline-none"
          style={{ maxHeight: 120, color: "rgba(255,255,255,0.95)" }}
        />
        <div
          className="flex items-center justify-between gap-2 border-t px-2 py-1"
          style={{ borderColor: "rgba(255,255,255,0.05)" }}
        >
          {mode === "build" && input.trim().length > 0 ? (
            <div className="flex min-w-0 items-center gap-1 text-[9px]" style={{ color: "rgba(255,255,255,0.6)" }}>
              <intentMeta.Icon className="h-2.5 w-2.5" />
              <span className="font-medium" style={{ color: "rgba(255,255,255,0.85)" }}>{intentMeta.label}</span>
              <span className="truncate" style={{ color: "rgba(255,255,255,0.45)" }}>— {intentMeta.description}</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-[9px]" style={{ color: "rgba(255,255,255,0.5)" }}>
              <Computer className="h-2.5 w-2.5" />
              <span>
                {mode === "plan"
                  ? "Plan mode — chat only"
                  : "Build mode — chat, code, or browser"}
              </span>
            </div>
          )}
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSend}
            className="sylica-pop-btn shrink-0 rounded-full p-1 transition"
            style={canSend ? { backgroundColor: "rgba(255,255,255,0.92)", color: "#1a1c20" } : { backgroundColor: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.35)" }}
            aria-label="Send"
            title="Send (Enter)"
          >
            {isSending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <SendHorizontal className="h-3 w-3" />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

export default AgentPanel
