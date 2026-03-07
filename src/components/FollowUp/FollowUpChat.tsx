import { useQueryClient } from "@tanstack/react-query"
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter"
import { dracula } from "react-syntax-highlighter/dist/esm/styles/prism"
import { SendHorizontal } from "lucide-react"
import React, { useEffect, useRef, useState } from "react"
import { Button } from "../ui/button"
import { useToast } from "../../contexts/toast"
import type {
  FollowUpChatMessage,
  FollowUpChatTurn,
} from "../../../shared/followUpChat"

export const FOLLOW_UP_CHAT_QUERY_KEY = ["follow_up_chat"] as const

interface FollowUpChatProps {
  currentContext: string
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
          className="rounded bg-black/35 px-1.5 py-0.5 font-mono text-[11px]"
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

function renderMessageContent(content: string) {
  return parseMarkdownBlocks(content).map((block, index) => {
    if (block.type === "code") {
      return (
        <div
          key={`${block.type}-${index}`}
          className="overflow-hidden rounded-xl border border-white/10"
        >
          <SyntaxHighlighter
            language={block.language || "text"}
            style={dracula}
            customStyle={{
              margin: 0,
              padding: "0.8rem",
              fontSize: "12px",
              backgroundColor: "rgba(15, 23, 42, 0.78)",
            }}
          >
            {block.value}
          </SyntaxHighlighter>
        </div>
      )
    }

    if (block.type === "heading") {
      const headingClassName =
        block.level <= 2
          ? "text-[13px] font-semibold tracking-[0.01em]"
          : "text-[12px] font-semibold"

      return (
        <div key={`${block.type}-${index}`} className={headingClassName}>
          {renderInlineMarkdown(block.value)}
        </div>
      )
    }

    if (block.type === "unordered-list") {
      return (
        <div key={`${block.type}-${index}`} className="space-y-1.5">
          {block.items.map((item, itemIndex) => (
            <div key={`${block.type}-${itemIndex}`} className="flex items-start gap-2">
              <div className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-current/60" />
              <div className="min-w-0 flex-1">
                {renderInlineMarkdown(item)}
              </div>
            </div>
          ))}
        </div>
      )
    }

    if (block.type === "ordered-list") {
      return (
        <div key={`${block.type}-${index}`} className="space-y-1.5">
          {block.items.map((item, itemIndex) => (
            <div key={`${block.type}-${itemIndex}`} className="flex items-start gap-2">
              <div className="min-w-[1.1rem] shrink-0 text-white/55">
                {itemIndex + 1}.
              </div>
              <div className="min-w-0 flex-1">
                {renderInlineMarkdown(item)}
              </div>
            </div>
          ))}
        </div>
      )
    }

    if (block.type === "blockquote") {
      return (
        <div
          key={`${block.type}-${index}`}
          className="border-l-2 border-white/15 pl-3 text-white/72"
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
        className="text-[12px] leading-[1.55] whitespace-pre-wrap"
      >
        {renderInlineMarkdown(block.value)}
      </div>
    )
  })
}

export function FollowUpChat({ currentContext }: FollowUpChatProps) {
  const queryClient = useQueryClient()
  const { showToast } = useToast()
  const [messages, setMessages] = useState<FollowUpChatMessage[]>([])
  const [input, setInput] = useState("")
  const [isSending, setIsSending] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const syncMessages = () => {
      const cachedMessages =
        (queryClient.getQueryData(FOLLOW_UP_CHAT_QUERY_KEY) as
          | FollowUpChatMessage[]
          | undefined) || []
      setMessages(cachedMessages)
    }

    syncMessages()

    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event?.query?.queryKey?.[0] === FOLLOW_UP_CHAT_QUERY_KEY[0]) {
        syncMessages()
      }
    })

    return () => {
      unsubscribe()
    }
  }, [queryClient])

  useEffect(() => {
    if (!inputRef.current) {
      return
    }

    inputRef.current.style.height = "0px"
    inputRef.current.style.height = `${Math.min(
      inputRef.current.scrollHeight,
      120
    )}px`
  }, [input])

  useEffect(() => {
    if (!messagesRef.current) {
      return
    }

    messagesRef.current.scrollTop = messagesRef.current.scrollHeight
  }, [messages])

  const persistMessages = (nextMessages: FollowUpChatMessage[]) => {
    queryClient.setQueryData(FOLLOW_UP_CHAT_QUERY_KEY, nextMessages)
    setMessages(nextMessages)
  }

  const sendFollowUp = async () => {
    const trimmedInput = input.trim()
    if (!trimmedInput || isSending) {
      return
    }

    if (!currentContext.trim()) {
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

    const nextMessages = [...messages, userMessage, pendingAssistantMessage]
    persistMessages(nextMessages)
    setInput("")
    setIsSending(true)

    try {
      const chatHistory: FollowUpChatTurn[] = messages
        .filter((message) => !message.pending)
        .map((message) => ({
          role: message.role,
          content: message.content,
        }))
        .slice(-10)

      const response = await window.electronAPI.submitTextFollowUp({
        message: trimmedInput,
        currentContext,
        chatHistory,
      })

      if (!response.success) {
        throw new Error(response.error)
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
          : "Failed to generate a follow-up response."
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
      showToast("Follow-up Failed", message, "error")
    } finally {
      setIsSending(false)
    }
  }

  return (
    <div className="space-y-2 rounded-[16px] border border-white/10 bg-white/[0.03] p-2.5">
      {messages.length > 0 && (
        <div
          ref={messagesRef}
          className="max-h-[13rem] space-y-2 overflow-y-auto pr-1"
        >
          {messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${
                message.role === "user" ? "justify-end" : "justify-start"
              }`}
            >
              <div
                className={`max-w-[92%] space-y-1.5 rounded-[14px] px-3 py-2 ${
                  message.role === "user"
                    ? "bg-[#7df9c7] text-black"
                    : message.error
                    ? "border border-red-500/20 bg-red-500/10 text-red-100"
                    : "border border-white/10 bg-black/25 text-white/90"
                } ${message.pending ? "opacity-75" : ""}`}
              >
                {renderMessageContent(message.content)}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2 rounded-[14px] border border-white/10 bg-black/25 px-3 py-2">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              void sendFollowUp()
            }
          }}
          rows={1}
          placeholder="Follow-up..."
          className="max-h-[120px] min-h-[22px] flex-1 resize-none bg-transparent py-1 text-[13px] leading-5 text-white outline-none placeholder:text-white/28"
        />
        <Button
          type="button"
          size="icon"
          onClick={() => {
            void sendFollowUp()
          }}
          disabled={isSending || input.trim().length === 0}
          title="Send follow-up"
          aria-label="Send follow-up"
          className="h-9 w-9 rounded-full bg-[#7df9c7] text-black hover:bg-[#97ffd3]"
        >
          {isSending ? "..." : <SendHorizontal className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  )
}
