import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { BrowserWindow, app, shell } from "electron"
import { OpenAI } from "openai"
import { backendClient } from "./BackendClient"
import { configHelper } from "./ConfigHelper"
import type { ChatThreadSummary } from "../shared/followUpChat"
import {
  EMPTY_AGENT_STATE,
  type AgentArtifact,
  type AgentArtifactType,
  type AgentEvent,
  type AgentPhase,
  type AgentState,
  type AgentStartData,
} from "../shared/agent"

const AGENT_STATE_EVENT = "agent-state"
const AGENT_MODEL =
  (process.env.OPENAI_AGENT_MODEL || process.env.AGENT_MODEL || "").trim() ||
  "gpt-5"
const AGENT_FALLBACK_MODELS = ["gpt-5", "gpt-4.1", "gpt-4o"]
const MAX_EVENTS = 80
const MAX_TREE_LINES = 220
const MAX_FILE_SNIPPETS = 18
const MAX_FILE_SNIPPET_BYTES = 18 * 1024
const MAX_AGENT_FILE_BYTES = 900 * 1024

function getDefaultAgentWorkspacePath(): string {
  try {
    return path.resolve(app.getPath("documents"))
  } catch (_error) {
    return path.resolve(os.homedir(), "Documents")
  }
}

interface AgentControllerDeps {
  getMainWindow: () => BrowserWindow | null
}

interface AgentFileWrite {
  relativePath: string
  content: string
  type?: AgentArtifactType
  title?: string
}

interface AgentPhaseResult {
  summary: string
  files: AgentFileWrite[]
  commands: string[]
}

interface PresentationSlide {
  title: string
  bullets: string[]
}

function nowIso(): string {
  return new Date().toISOString()
}

function isActiveAgentStatus(status: AgentState["status"]): boolean {
  return (
    status === "planning" ||
    status === "awaiting_workspace" ||
    status === "awaiting_approval" ||
    status === "running"
  )
}

function sanitizeTitle(value: string, fallback: string): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  return normalized.length > 0 ? normalized.slice(0, 80) : fallback
}

function sanitizeRelativePath(value: string): string {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/")
}

function ensureArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function parseJsonObject(value: string): Record<string, unknown> {
  const trimmed = value.trim()
  if (!trimmed) {
    return {}
  }

  try {
    return JSON.parse(trimmed)
  } catch (_error) {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1].trim())
      } catch (_innerError) {
        return {}
      }
    }

    const first = trimmed.indexOf("{")
    const last = trimmed.lastIndexOf("}")
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(trimmed.slice(first, last + 1))
      } catch (_innerError) {
        return {}
      }
    }
  }

  return {}
}

function supportsReasoningEffort(model: string): boolean {
  return /^gpt-5/i.test(model)
}

function inferArtifactType(filePath: string, fallback?: AgentArtifactType): AgentArtifactType {
  const lower = filePath.toLowerCase()
  if (lower.endsWith(".tsx") || lower.endsWith(".ts") || lower.endsWith(".jsx") || lower.endsWith(".js") || lower.endsWith(".css") || lower.endsWith(".html") || lower.endsWith(".json")) {
    return "code"
  }
  if (lower.endsWith(".pptx") || lower.includes("deck") || lower.includes("slides")) {
    return "presentation"
  }
  if (lower.endsWith(".md") || lower.endsWith(".txt")) {
    return fallback || "document"
  }
  return fallback || "other"
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function stripMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[#*_>\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function splitSentences(value: string, limit = 5): string[] {
  const cleaned = stripMarkdown(value)
  const sentences = cleaned
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
    .slice(0, limit)

  if (sentences.length > 0) {
    return sentences.map((sentence) => sentence.slice(0, 150))
  }

  return cleaned ? [cleaned.slice(0, 150)] : []
}

function isPresentationTask(prompt: string, phase: AgentPhase, files: AgentFileWrite[]): boolean {
  const haystack = [
    prompt,
    phase.title,
    phase.goal,
    ...files.map((file) => `${file.relativePath} ${file.title || ""} ${file.type || ""}`),
  ]
    .join(" ")
    .toLowerCase()

  return /\b(presentation|pptx|powerpoint|slide deck|slides|deck)\b/.test(haystack)
}

function hasPptxFile(files: AgentFileWrite[]): boolean {
  return files.some((file) => file.relativePath.toLowerCase().endsWith(".pptx"))
}

function isWebsiteTask(prompt: string, phase?: AgentPhase): boolean {
  const haystack = [prompt, phase?.title || "", phase?.goal || ""]
    .join(" ")
    .toLowerCase()

  return /\b(landing\s*page|website|web\s*page|homepage|site|frontend|ui|clone\s+this|clone\s+the|html|css|react|vite|next\.?js|saas|dashboard|portfolio)\b/.test(
    haystack
  )
}

function hasWebsiteFiles(files: AgentFileWrite[]): boolean {
  return files.some((file) =>
    /\.(html|css|js|jsx|ts|tsx|json|vue|svelte)$/i.test(file.relativePath)
  )
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function createWebsiteFallbackFiles(prompt: string, taskId: string): AgentPhaseResult {
  const safePrompt = sanitizeTitle(stripMarkdown(prompt), "AI landing page")
  const escapedPrompt = escapeHtml(safePrompt)
  const basePath = `sylica-agent-output/${taskId}/landing-page`
  return {
    summary: "Created a complete editable landing page with HTML, CSS, and JavaScript.",
    commands: [],
    files: [
      {
        relativePath: `${basePath}/index.html`,
        title: "Landing page HTML",
        type: "code",
        content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapedPrompt}</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <main class="page-shell">
      <nav class="nav">
        <a class="brand" href="#top" aria-label="Home">
          <span class="brand-orb"></span>
          <span>Sylica</span>
        </a>
        <div class="nav-links">
          <a href="#features">Features</a>
          <a href="#workflow">Workflow</a>
          <a href="#demo">Demo</a>
        </div>
        <a class="nav-cta" href="#demo">Try preview</a>
      </nav>

      <section id="top" class="hero">
        <div class="hero-copy">
          <p class="eyebrow">Always-on AI workspace</p>
          <h1>${escapedPrompt}</h1>
          <p class="lede">
            A polished landing page generated as editable local files. Replace this copy with your product promise, add real screenshots, and ship it as a static page or fold it into any frontend stack.
          </p>
          <div class="actions">
            <a class="primary" href="#demo">Start building</a>
            <a class="secondary" href="#features">See features</a>
          </div>
        </div>
        <div class="hero-visual" aria-label="Product preview">
          <div class="glass-card card-one">
            <span class="status-dot"></span>
            <strong>Realtime context</strong>
            <p>Voice, screen, files, and workflow awareness in one compact assistant.</p>
          </div>
          <div class="glass-card card-two">
            <div class="wave"></div>
            <p>Agent mode creates artifacts, code, decks, and research inside your workspace.</p>
          </div>
          <div class="orbit orbit-a"></div>
          <div class="orbit orbit-b"></div>
        </div>
      </section>

      <section id="features" class="features">
        <article>
          <span>01</span>
          <h2>Voice first</h2>
          <p>Wake the assistant, talk naturally, and keep your hands on the work.</p>
        </article>
        <article>
          <span>02</span>
          <h2>Workspace agent</h2>
          <p>Generate real files, edit projects, create decks, and review output with approvals.</p>
        </article>
        <article>
          <span>03</span>
          <h2>Multi-device</h2>
          <p>Bridge your phone, desktop, notifications, clipboard, and commands.</p>
        </article>
      </section>

      <section id="workflow" class="workflow">
        <p class="eyebrow">How it works</p>
        <h2>From instruction to artifact</h2>
        <div class="steps">
          <div>Describe the goal</div>
          <div>Approve the phase</div>
          <div>Receive editable files</div>
        </div>
      </section>

      <section id="demo" class="demo">
        <div>
          <p class="eyebrow">Preview</p>
          <h2>Make this page yours</h2>
          <p>Open these files in any editor. The page is static, responsive, and ready to customize.</p>
        </div>
        <button id="pulseButton" type="button">Animate preview</button>
      </section>
    </main>
    <script src="./script.js"></script>
  </body>
</html>
`,
      },
      {
        relativePath: `${basePath}/styles.css`,
        title: "Landing page styles",
        type: "code",
        content: `:root {
  color-scheme: light;
  --ink: #10151f;
  --muted: #667085;
  --paper: #f6f2e8;
  --panel: rgba(255, 255, 255, 0.72);
  --line: rgba(16, 21, 31, 0.12);
  --mint: #2fd59f;
  --blue: #485cff;
  --shadow: 0 24px 80px rgba(16, 21, 31, 0.14);
}

* {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
}

body {
  margin: 0;
  min-height: 100vh;
  font-family: "Satoshi", "Aptos", "Segoe UI", sans-serif;
  color: var(--ink);
  background:
    radial-gradient(circle at 15% 12%, rgba(47, 213, 159, 0.24), transparent 28rem),
    radial-gradient(circle at 88% 8%, rgba(72, 92, 255, 0.2), transparent 30rem),
    linear-gradient(135deg, #fbf7ed, var(--paper));
}

a {
  color: inherit;
  text-decoration: none;
}

.page-shell {
  width: min(1120px, calc(100% - 32px));
  margin: 0 auto;
  padding: 24px 0 56px;
}

.nav,
.features article,
.workflow,
.demo,
.glass-card {
  border: 1px solid var(--line);
  background: var(--panel);
  backdrop-filter: blur(22px);
  box-shadow: var(--shadow);
}

.nav {
  position: sticky;
  top: 16px;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border-radius: 999px;
  padding: 10px 12px 10px 16px;
}

.brand,
.nav-links,
.actions,
.steps {
  display: flex;
  align-items: center;
  gap: 12px;
}

.brand {
  font-weight: 800;
  letter-spacing: -0.03em;
}

.brand-orb {
  width: 24px;
  height: 24px;
  border-radius: 999px;
  background: conic-gradient(from 120deg, var(--mint), var(--blue), #111827, var(--mint));
  box-shadow: 0 0 24px rgba(72, 92, 255, 0.35);
}

.nav-links {
  color: var(--muted);
  font-size: 14px;
}

.nav-cta,
.primary,
.secondary,
.demo button {
  border-radius: 999px;
  padding: 12px 18px;
  font-weight: 800;
}

.nav-cta,
.primary,
.demo button {
  border: 0;
  color: white;
  background: #10151f;
}

.secondary {
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.52);
}

.hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, 0.82fr);
  gap: 42px;
  align-items: center;
  min-height: 680px;
}

.eyebrow {
  margin: 0 0 14px;
  color: var(--blue);
  font-size: 12px;
  font-weight: 900;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

h1,
h2,
p {
  margin-top: 0;
}

h1 {
  max-width: 760px;
  margin-bottom: 20px;
  font-size: clamp(48px, 8vw, 104px);
  line-height: 0.88;
  letter-spacing: -0.08em;
}

h2 {
  margin-bottom: 12px;
  font-size: clamp(28px, 4vw, 56px);
  line-height: 0.95;
  letter-spacing: -0.055em;
}

.lede {
  max-width: 620px;
  color: var(--muted);
  font-size: 18px;
  line-height: 1.7;
}

.hero-visual {
  position: relative;
  min-height: 480px;
  border-radius: 42px;
  background:
    linear-gradient(120deg, rgba(255,255,255,0.22), transparent),
    radial-gradient(circle at 50% 50%, rgba(72,92,255,0.3), transparent 15rem);
}

.glass-card {
  position: absolute;
  border-radius: 28px;
  padding: 24px;
}

.card-one {
  top: 40px;
  left: 14px;
  width: 72%;
}

.card-two {
  right: 10px;
  bottom: 46px;
  width: 72%;
}

.status-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 8px;
  border-radius: 999px;
  background: var(--mint);
  box-shadow: 0 0 22px var(--mint);
}

.wave {
  height: 64px;
  margin-bottom: 18px;
  border-radius: 18px;
  background: repeating-linear-gradient(90deg, var(--blue) 0 8px, transparent 8px 18px);
  mask-image: linear-gradient(90deg, transparent, black 18%, black 82%, transparent);
}

.orbit {
  position: absolute;
  border: 1px solid rgba(72, 92, 255, 0.3);
  border-radius: 999px;
  animation: float 7s ease-in-out infinite;
}

.orbit-a {
  inset: 118px 70px;
}

.orbit-b {
  inset: 170px 38px 92px 118px;
  animation-delay: -2s;
}

.features {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 18px;
}

.features article,
.workflow,
.demo {
  border-radius: 30px;
  padding: 28px;
}

.features span {
  color: var(--mint);
  font-weight: 900;
}

.features p,
.workflow p,
.demo p {
  color: var(--muted);
  line-height: 1.65;
}

.workflow,
.demo {
  margin-top: 18px;
}

.steps {
  flex-wrap: wrap;
}

.steps div {
  border-radius: 999px;
  background: rgba(16, 21, 31, 0.06);
  padding: 12px 16px;
  font-weight: 800;
}

.demo {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
}

.is-pulsing .hero-visual {
  animation: pulseGlow 900ms ease both;
}

@keyframes float {
  50% {
    transform: translateY(-14px) rotate(2deg);
  }
}

@keyframes pulseGlow {
  50% {
    filter: saturate(1.4) brightness(1.06);
    transform: scale(1.012);
  }
}

@media (max-width: 820px) {
  .nav-links {
    display: none;
  }

  .hero {
    grid-template-columns: 1fr;
    min-height: auto;
    padding: 76px 0 42px;
  }

  .features {
    grid-template-columns: 1fr;
  }

  .demo {
    align-items: flex-start;
    flex-direction: column;
  }
}
`,
      },
      {
        relativePath: `${basePath}/script.js`,
        title: "Landing page interactions",
        type: "code",
        content: `const button = document.querySelector("#pulseButton");

button?.addEventListener("click", () => {
  document.body.classList.remove("is-pulsing");
  window.requestAnimationFrame(() => {
    document.body.classList.add("is-pulsing");
  });
});
`,
      },
      {
        relativePath: `${basePath}/README.md`,
        title: "Landing page README",
        type: "document",
        content: `# Landing page

Generated for: ${safePrompt}

Open \`index.html\` in a browser or copy the files into your web project. The main editable files are:

- \`index.html\`
- \`styles.css\`
- \`script.js\`
`,
      },
    ],
  }
}

function extractSlidesFromFiles(prompt: string, phase: AgentPhase, result: AgentPhaseResult): PresentationSlide[] {
  const slides: PresentationSlide[] = [
    {
      title: sanitizeTitle(stripMarkdown(prompt), "Sylica Agent Deck"),
      bullets: splitSentences(result.summary || phase.goal, 3),
    },
  ]

  for (const file of result.files) {
    if (slides.length >= 8) {
      break
    }

    const lines = file.content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)

    const heading = lines.find((line) => /^#{1,3}\s+/.test(line))
    const bullets = lines
      .filter((line) => /^[-*]\s+/.test(line) || /^\d+[.)]\s+/.test(line))
      .map((line) => stripMarkdown(line.replace(/^[-*]\s+|^\d+[.)]\s+/, "")))
      .filter(Boolean)
      .slice(0, 5)

    const title = sanitizeTitle(
      stripMarkdown((heading || file.title || path.basename(file.relativePath)).replace(/^#{1,3}\s+/, "")),
      "Agent output"
    )

    slides.push({
      title,
      bullets: bullets.length > 0 ? bullets : splitSentences(file.content, 4),
    })
  }

  if (slides.length === 1) {
    slides.push({
      title: sanitizeTitle(phase.title, "Phase summary"),
      bullets: splitSentences(`${phase.goal}. ${result.summary}`, 5),
    })
  }

  return slides.map((slide) => ({
    title: sanitizeTitle(slide.title, "Slide"),
    bullets: slide.bullets.length > 0 ? slide.bullets : ["Generated by Sylica Agent."],
  }))
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function writeZipUInt16(value: number): Buffer {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16LE(value, 0)
  return buffer
}

function writeZipUInt32(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value >>> 0, 0)
  return buffer
}

function createStoredZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8")
    const data = entry.data
    const crc = crc32(data)

    const localHeader = Buffer.concat([
      writeZipUInt32(0x04034b50),
      writeZipUInt16(20),
      writeZipUInt16(0),
      writeZipUInt16(0),
      writeZipUInt16(0),
      writeZipUInt16(0),
      writeZipUInt32(crc),
      writeZipUInt32(data.length),
      writeZipUInt32(data.length),
      writeZipUInt16(name.length),
      writeZipUInt16(0),
      name,
    ])

    localParts.push(localHeader, data)

    const centralHeader = Buffer.concat([
      writeZipUInt32(0x02014b50),
      writeZipUInt16(20),
      writeZipUInt16(20),
      writeZipUInt16(0),
      writeZipUInt16(0),
      writeZipUInt16(0),
      writeZipUInt16(0),
      writeZipUInt32(crc),
      writeZipUInt32(data.length),
      writeZipUInt32(data.length),
      writeZipUInt16(name.length),
      writeZipUInt16(0),
      writeZipUInt16(0),
      writeZipUInt16(0),
      writeZipUInt16(0),
      writeZipUInt32(0),
      writeZipUInt32(offset),
      name,
    ])

    centralParts.push(centralHeader)
    offset += localHeader.length + data.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.concat([
    writeZipUInt32(0x06054b50),
    writeZipUInt16(0),
    writeZipUInt16(0),
    writeZipUInt16(entries.length),
    writeZipUInt16(entries.length),
    writeZipUInt32(centralDirectory.length),
    writeZipUInt32(offset),
    writeZipUInt16(0),
  ])

  return Buffer.concat([...localParts, centralDirectory, end])
}

function createSlideXml(slide: PresentationSlide): string {
  const body = slide.bullets
    .slice(0, 6)
    .map(
      (bullet) => `<a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US" sz="2300"/><a:t>${escapeXml(
        bullet
      )}</a:t></a:r></a:p>`
    )
    .join("")

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="640000" y="520000"/><a:ext cx="7900000" cy="900000"/></a:xfrm></p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="3800" b="1"/><a:t>${escapeXml(
          slide.title
        )}</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="760000" y="1650000"/><a:ext cx="7700000" cy="4000000"/></a:xfrm></p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/>${body}</p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`
}

function buildPptx(slides: PresentationSlide[]): Buffer {
  const slideEntries = slides.map((slide, index) => ({
    name: `ppt/slides/slide${index + 1}.xml`,
    data: Buffer.from(createSlideXml(slide), "utf8"),
  }))
  const slideRels = slides.map((_, index) => ({
    name: `ppt/slides/_rels/slide${index + 1}.xml.rels`,
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`,
      "utf8"
    ),
  }))
  const slideIds = slides
    .map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`)
    .join("")
  const presentationRels = [
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>`,
    ...slides.map(
      (_, index) =>
        `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`
    ),
  ].join("")
  const contentTypes = [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`,
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`,
    `<Default Extension="xml" ContentType="application/xml"/>`,
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`,
    `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>`,
    `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`,
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>`,
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`,
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`,
    ...slides.map(
      (_, index) =>
        `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
    ),
    `</Types>`,
  ].join("")

  return createStoredZip([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    {
      name: "_rels/.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
        "utf8"
      ),
    },
    {
      name: "docProps/core.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Sylica Agent Deck</dc:title><dc:creator>Sylica Agent</dc:creator><cp:lastModifiedBy>Sylica Agent</cp:lastModifiedBy></cp:coreProperties>`,
        "utf8"
      ),
    },
    {
      name: "docProps/app.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Sylica Agent</Application><PresentationFormat>On-screen Show (16:9)</PresentationFormat><Slides>${slides.length}</Slides></Properties>`,
        "utf8"
      ),
    },
    {
      name: "ppt/presentation.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="9144000" cy="5143500" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
        "utf8"
      ),
    },
    {
      name: "ppt/_rels/presentation.xml.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${presentationRels}</Relationships>`,
        "utf8"
      ),
    },
    {
      name: "ppt/slideMasters/slideMaster1.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`,
        "utf8"
      ),
    },
    {
      name: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`,
        "utf8"
      ),
    },
    {
      name: "ppt/slideLayouts/slideLayout1.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" type="blank"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld></p:sldLayout>`,
        "utf8"
      ),
    },
    {
      name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
        "utf8"
      ),
    },
    {
      name: "ppt/theme/theme1.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Sylica"><a:themeElements><a:clrScheme name="Sylica"><a:dk1><a:sysClr val="windowText" lastClr="111827"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="111827"/></a:dk2><a:lt2><a:srgbClr val="F4F7F5"/></a:lt2><a:accent1><a:srgbClr val="2FD59F"/></a:accent1><a:accent2><a:srgbClr val="5B6CFF"/></a:accent2><a:accent3><a:srgbClr val="111827"/></a:accent3><a:accent4><a:srgbClr val="94A3B8"/></a:accent4><a:accent5><a:srgbClr val="DFFCF1"/></a:accent5><a:accent6><a:srgbClr val="0F172A"/></a:accent6><a:hlink><a:srgbClr val="5B6CFF"/></a:hlink><a:folHlink><a:srgbClr val="2FD59F"/></a:folHlink></a:clrScheme><a:fontScheme name="Sylica"><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/></a:minorFont></a:fontScheme><a:fmtScheme name="Sylica"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme></a:themeElements></a:theme>`,
        "utf8"
      ),
    },
    ...slideEntries,
    ...slideRels,
  ])
}

function isSafeWorkspaceCommand(command: string): boolean {
  const normalized = command.trim()
  if (!normalized || normalized.length > 180) {
    return false
  }

  if (/[|;&<>`]/.test(normalized) || normalized.includes("$(")) {
    return false
  }

  if (
    /\b(rm|del|erase|rmdir|rd|remove-item|format|shutdown|reboot|reg|sc|schtasks)\b/i.test(
      normalized
    ) ||
    /\b(git\s+reset|git\s+clean|npm\s+publish|pnpm\s+publish|yarn\s+publish|deploy|wrangler|vercel|netlify|firebase)\b/i.test(
      normalized
    )
  ) {
    return false
  }

  return /^(npm|pnpm|yarn|node|npx|bun|deno|go|cargo|python|python3|pytest|tsc|vite|flutter|dart)\b/i.test(
    normalized
  )
}

export class AgentController {
  private readonly deps: AgentControllerDeps
  private readonly listeners = new Set<(state: AgentState) => void>()
  private state: AgentState = { ...EMPTY_AGENT_STATE }
  private thread: ChatThreadSummary | null = null
  private stoppingTaskId: string | null = null

  constructor(deps: AgentControllerDeps) {
    this.deps = deps
  }

  public getState(): AgentState {
    return {
      ...this.state,
      phases: this.state.phases.map((phase) => ({ ...phase })),
      events: this.state.events.map((event) => ({ ...event })),
      artifacts: this.state.artifacts.map((artifact) => ({ ...artifact })),
    }
  }

  public subscribe(listener: (state: AgentState) => void): () => void {
    this.listeners.add(listener)
    listener(this.getState())
    return () => {
      this.listeners.delete(listener)
    }
  }

  public async startTask(payload: {
    prompt: string
    workspacePath?: string
  }): Promise<
    | { success: true; data: AgentStartData }
    | { success: false; error: string; authRequired?: boolean }
  > {
    const prompt = payload.prompt.trim()
    const requestedWorkspacePath = String(payload.workspacePath || "").trim()
    const workspacePath = requestedWorkspacePath || getDefaultAgentWorkspacePath()

    if (!prompt) {
      return { success: false, error: "Describe what the agent should build first." }
    }

    if (isActiveAgentStatus(this.state.status)) {
      return { success: false, error: "An agent task is already active." }
    }

    if (!requestedWorkspacePath) {
      try {
        fs.mkdirSync(workspacePath, { recursive: true })
      } catch (_error) {
        this.resetForNewTask(prompt, "")
        this.updateState({ status: "awaiting_workspace" })
        this.addEvent("approval", "Choose a workspace folder before Agent Mode starts.")
        return { success: true, data: { state: this.getState() } }
      }
    }

    const workspaceCheck = this.validateWorkspace(workspacePath)
    if ("error" in workspaceCheck) {
      return { success: false, error: workspaceCheck.error }
    }

    const taskId = `agent-${Date.now()}-${randomUUID().slice(0, 8)}`
    this.thread = null
    this.stoppingTaskId = null
    this.state = {
      ...EMPTY_AGENT_STATE,
      status: "planning",
      taskId,
      prompt,
      workspacePath: workspaceCheck.path,
    }
    this.emitState()
    this.addEvent("thinking", "Agent Mode is preparing a phase plan.")
    if (!requestedWorkspacePath) {
      this.addEvent("approval", `Using Documents as workspace: ${workspaceCheck.path}`)
    }

    try {
      const usageDecision = await backendClient.consumeUsage("agent")
      if (!usageDecision.allowed) {
        this.updateState({
          status: "error",
          error: usageDecision.error || "Agent Mode is not available for this account.",
        })
        return {
          success: false,
          error: usageDecision.error || "Agent Mode is not available for this account.",
          authRequired: !usageDecision.session,
        }
      }

      this.thread = await backendClient.createChatThread("agent", sanitizeTitle(prompt, "Agent task"))
      await backendClient.appendChatMessage({
        threadId: this.thread.id,
        role: "user",
        content: prompt,
      })

      const phases = await this.createPhasePlan(prompt, workspaceCheck.path)
      this.state = {
        ...this.state,
        status: "awaiting_approval",
        threadId: this.thread.id,
        phases,
        activePhaseId: phases[0]?.id || null,
      }
      this.addEvent("approval", "Plan is ready. Approve the first phase when you want it to run.", phases[0]?.id)
      this.emitState()

      await this.persistAssistantMessage(
        `Agent plan:\n${phases.map((phase, index) => `${index + 1}. ${phase.title} - ${phase.goal}`).join("\n")}`
      )

      return { success: true, data: { state: this.getState() } }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to start Agent Mode."
      this.updateState({ status: "error", error: message })
      this.addEvent("error", message)
      return { success: false, error: message }
    }
  }

  public async approvePhase(payload: {
    taskId: string
    phaseId: string
  }): Promise<{ success: true; data: { state: AgentState } } | { success: false; error: string }> {
    if (payload.taskId !== this.state.taskId) {
      return { success: false, error: "That agent task is no longer active." }
    }

    const phase = this.state.phases.find((candidate) => candidate.id === payload.phaseId)
    if (!phase) {
      return { success: false, error: "Agent phase not found." }
    }

    if (this.state.status !== "awaiting_approval" || phase.status !== "awaiting_approval") {
      return { success: false, error: "This phase is not waiting for approval." }
    }

    void this.runPhase(phase.id)
    return { success: true, data: { state: this.getState() } }
  }

  public async rejectPhase(payload: {
    taskId: string
    phaseId: string
    reason?: string
  }): Promise<{ success: true; data: { state: AgentState } } | { success: false; error: string }> {
    if (payload.taskId !== this.state.taskId) {
      return { success: false, error: "That agent task is no longer active." }
    }

    const reason = String(payload.reason || "").trim()
    this.updatePhase(payload.phaseId, {
      status: "rejected",
      summary: reason || "Rejected by user.",
    })
    this.updateState({ status: "stopped", activePhaseId: null })
    this.addEvent("done", reason || "Agent task stopped before this phase ran.", payload.phaseId)
    await this.persistAssistantMessage(`Agent task stopped: ${reason || "phase rejected by user."}`)
    return { success: true, data: { state: this.getState() } }
  }

  public async stop(): Promise<{ success: true; data: { state: AgentState } }> {
    this.stoppingTaskId = this.state.taskId
    this.updateState({ status: "stopped", activePhaseId: null })
    this.addEvent("done", "Agent task stopped.")
    await this.persistAssistantMessage("Agent task stopped.")
    return { success: true, data: { state: this.getState() } }
  }

  public async openArtifact(artifactId: string): Promise<{ success: true } | { success: false; error: string }> {
    const artifact = this.state.artifacts.find((candidate) => candidate.id === artifactId)
    if (!artifact) {
      return { success: false, error: "Artifact not found." }
    }

    await shell.openPath(artifact.path)
    return { success: true }
  }

  public async openWorkspace(): Promise<{ success: true } | { success: false; error: string }> {
    if (!this.state.workspacePath) {
      return { success: false, error: "No workspace is selected." }
    }

    await shell.openPath(this.state.workspacePath)
    return { success: true }
  }

  private resetForNewTask(prompt: string, workspacePath: string): void {
    this.thread = null
    this.stoppingTaskId = null
    this.state = {
      ...EMPTY_AGENT_STATE,
      taskId: `agent-${Date.now()}-${randomUUID().slice(0, 8)}`,
      prompt,
      workspacePath,
    }
    this.emitState()
  }

  private validateWorkspace(workspacePath: string): { ok: true; path: string } | { ok: false; error: string } {
    const resolved = path.resolve(workspacePath)
    if (!fs.existsSync(resolved)) {
      return { ok: false, error: "Workspace folder does not exist." }
    }

    if (!fs.statSync(resolved).isDirectory()) {
      return { ok: false, error: "Workspace must be a folder." }
    }

    return { ok: true, path: resolved }
  }

  private isInsideWorkspace(targetPath: string): boolean {
    if (!this.state.workspacePath) {
      return false
    }

    const workspace = path.resolve(this.state.workspacePath)
    const target = path.resolve(targetPath)
    return target === workspace || target.startsWith(`${workspace}${path.sep}`)
  }

  private emitState(): void {
    const state = this.getState()
    for (const listener of this.listeners) {
      listener(state)
    }

    const mainWindow = this.deps.getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(AGENT_STATE_EVENT, state)
    }
  }

  private updateState(partial: Partial<AgentState>): void {
    this.state = { ...this.state, ...partial }
    this.emitState()
  }

  private updatePhase(phaseId: string, partial: Partial<AgentPhase>): void {
    this.state = {
      ...this.state,
      phases: this.state.phases.map((phase) =>
        phase.id === phaseId ? { ...phase, ...partial } : phase
      ),
    }
    this.emitState()
  }

  private addEvent(type: AgentEvent["type"], message: string, phaseId?: string): void {
    if (!this.state.taskId) {
      return
    }

    const event: AgentEvent = {
      id: `evt-${Date.now()}-${randomUUID().slice(0, 6)}`,
      taskId: this.state.taskId,
      type,
      message,
      createdAt: nowIso(),
      phaseId,
    }

    this.state = {
      ...this.state,
      events: [...this.state.events, event].slice(-MAX_EVENTS),
    }
    this.emitState()
  }

  private async persistAssistantMessage(content: string): Promise<void> {
    if (!this.thread?.id) {
      return
    }

    try {
      const response = await backendClient.appendChatMessage({
        threadId: this.thread.id,
        role: "assistant",
        content,
      })
      this.thread = response.thread
    } catch (error) {
      console.warn("Failed to persist agent message:", error)
    }
  }

  private async createPhasePlan(prompt: string, workspacePath: string): Promise<AgentPhase[]> {
    if (isWebsiteTask(prompt)) {
      return [
        {
          id: "phase-1",
          title: "Build landing page files",
          goal: "Create the actual editable website files: HTML, CSS, and JavaScript inside the selected workspace.",
          status: "awaiting_approval",
          summary: "",
          requiresApproval: true,
        },
        {
          id: "phase-2",
          title: "Polish responsive UI",
          goal: "Improve layout, copy, visual hierarchy, animations, and mobile responsiveness in the generated page files.",
          status: "pending",
          summary: "",
          requiresApproval: true,
        },
        {
          id: "phase-3",
          title: "Verify and package",
          goal: "Review the generated website files and summarize exactly where the editable output is located.",
          status: "pending",
          summary: "",
          requiresApproval: true,
        },
      ]
    }

    const snapshot = this.buildWorkspaceSnapshot(workspacePath)
    const system = `You are Sylica Agent Planner. Create a concise phase plan for a desktop agent that can edit files and create artifacts inside one workspace.
Return JSON only. The plan must use 3 to 5 phases. Every phase requires approval.
Roles available: Planner, Research, Code, Design, Presentation, QA.
Do not include browser or mouse-control phases. Computer Use is separate.
The first phase must create or modify useful artifacts. Do not create a pure "understand and plan" phase.`
    const user = `User task:
${prompt}

Workspace:
${workspacePath}

Workspace snapshot:
${snapshot}

Return JSON:
{
  "phases": [
    { "title": "short phase title", "goal": "specific outcome for this phase" }
  ]
}`

    const response = await this.createChatCompletion(system, user, 1400)
    const parsed = parseJsonObject(response)
    const rawPhases = ensureArray<Record<string, unknown>>(parsed.phases)
    const phases = rawPhases
      .map((phase, index) => ({
        id: `phase-${index + 1}`,
        title: sanitizeTitle(String(phase.title || ""), `Phase ${index + 1}`),
        goal: sanitizeTitle(String(phase.goal || ""), "Move the task forward."),
        status: index === 0 ? "awaiting_approval" as const : "pending" as const,
        summary: "",
        requiresApproval: true,
      }))
      .slice(0, 5)

    if (phases.length > 0) {
      return phases
    }

    return [
      {
        id: "phase-1",
        title: "Create first useful artifact",
        goal: "Generate or edit the first concrete files needed for the task inside the selected workspace.",
        status: "awaiting_approval",
        summary: "",
        requiresApproval: true,
      },
      {
        id: "phase-2",
        title: "Create editable artifacts",
        goal: "Generate the requested files or implementation inside the selected workspace.",
        status: "pending",
        summary: "",
        requiresApproval: true,
      },
      {
        id: "phase-3",
        title: "Review and package results",
        goal: "Check the produced work and summarize final artifacts for the user.",
        status: "pending",
        summary: "",
        requiresApproval: true,
      },
    ]
  }

  private async runPhase(phaseId: string): Promise<void> {
    const taskId = this.state.taskId
    const phase = this.state.phases.find((candidate) => candidate.id === phaseId)
    if (!taskId || !phase) {
      return
    }

    this.updatePhase(phaseId, { status: "running" })
    this.updateState({ status: "running", activePhaseId: phaseId, error: "" })
    this.addEvent("worker", `${phase.title}: ${phase.goal}`, phaseId)

    try {
      const result = await this.executePhase(phase)
      if (this.stoppingTaskId === taskId || this.state.taskId !== taskId) {
        return
      }

      const artifacts = result.files.map((file) => this.writeAgentFile(file))
      const deckArtifact = this.maybeWritePresentationDeck(phase, result)
      if (deckArtifact) {
        artifacts.push(deckArtifact)
      }
      this.state = {
        ...this.state,
        artifacts: [...this.state.artifacts, ...artifacts],
      }
      this.updatePhase(phaseId, {
        status: "completed",
        summary: result.summary,
      })
      this.addEvent("done", result.summary || `${phase.title} completed.`, phaseId)
      artifacts.forEach((artifact) => {
        this.addEvent("artifact", `Created ${artifact.title}`, phaseId)
      })
      const commandSummaries = await this.runVerificationCommands(result.commands, phaseId)
      await this.persistAssistantMessage(
        `Completed ${phase.title}:\n${result.summary || "Phase completed."}${
          artifacts.length
            ? `\n\nArtifacts:\n${artifacts.map((artifact) => `- ${artifact.title}: ${artifact.path}`).join("\n")}`
            : ""
        }${
          commandSummaries.length
            ? `\n\nVerification:\n${commandSummaries.map((line) => `- ${line}`).join("\n")}`
            : ""
        }`
      )

      const nextPhase = this.state.phases.find((candidate) => candidate.status === "pending")
      if (nextPhase) {
        this.updatePhase(nextPhase.id, { status: "awaiting_approval" })
        this.updateState({
          status: "awaiting_approval",
          activePhaseId: nextPhase.id,
        })
        this.addEvent("approval", `Ready for next phase: ${nextPhase.title}`, nextPhase.id)
        return
      }

      this.updateState({
        status: "completed",
        activePhaseId: null,
      })
      this.addEvent("done", "Agent task completed.")
      await this.persistAssistantMessage("Agent task completed.")
    } catch (error) {
      const message = error instanceof Error ? error.message : "Agent phase failed."
      this.updatePhase(phaseId, { status: "error", summary: message })
      this.updateState({ status: "error", error: message, activePhaseId: phaseId })
      this.addEvent("error", message, phaseId)
      await this.persistAssistantMessage(`Agent phase failed: ${message}`)
    }
  }

  private async executePhase(phase: AgentPhase): Promise<AgentPhaseResult> {
    const snapshot = this.buildWorkspaceSnapshot(this.state.workspacePath)
    const artifactDir = path.join(
      this.state.workspacePath,
      "sylica-agent-output",
      this.state.taskId || "task"
    )
    const system = `You are Sylica Agent, an autonomous workspace agent.
You create editable local files, code, designs, research notes, and presentation source artifacts.
You are NOT controlling the user's mouse or browser. You only produce files inside the selected workspace.
Return JSON only. If the user asks for a website or landing page, you must return actual code files, not just a markdown summary.`
    const user = `Overall task:
${this.state.prompt}

Current phase:
${phase.title}
${phase.goal}

Workspace:
${this.state.workspacePath}

Generated output folder available:
${path.relative(this.state.workspacePath, artifactDir)}

Workspace snapshot and snippets:
${snapshot}

Rules:
- If editing existing code, return complete replacement file content for the relative path.
- If creating a website/design/presentation/research artifact, prefer files under sylica-agent-output/${this.state.taskId || "task"}/.
- For website or landing page work, return at minimum index.html, styles.css, and script.js. Markdown alone is a failed output.
- For presentations, create an editable markdown outline and an HTML deck preview. If a native PPTX generator is not available, do not fake a binary PPTX.
- Include only safe verification commands when useful, such as npm test, npm run build, or tsc. Do not include publish, deploy, delete, admin, secret, or payment commands.
- Keep files focused. Do not write outside the workspace.

Return JSON:
{
  "summary": "short user-facing summary of what this phase did",
  "files": [
    {
      "relativePath": "path/inside/workspace.ext",
      "title": "artifact title",
      "type": "code|design|presentation|research|document|other",
      "content": "full file content"
    }
  ],
  "commands": ["optional safe verification command to run inside workspace"]
}`

    const response = await this.createChatCompletion(system, user, 3600)
    const parsed = parseJsonObject(response)
    const summary = sanitizeTitle(String(parsed.summary || ""), `${phase.title} completed.`)
    const files = ensureArray<Record<string, unknown>>(parsed.files)
      .map((file) => ({
        relativePath: sanitizeRelativePath(String(file.relativePath || "")),
        content: typeof file.content === "string" ? file.content : "",
        type: this.normalizeArtifactType(file.type),
        title: sanitizeTitle(String(file.title || ""), "Agent artifact"),
      }))
      .filter((file) => file.relativePath && file.content)
    const commands = ensureArray<unknown>(parsed.commands)
      .map((command) => String(command || "").trim())
      .filter(Boolean)
      .slice(0, 4)
    const isWebsite = isWebsiteTask(this.state.prompt, phase)

    if (isWebsite && !hasWebsiteFiles(files)) {
      return createWebsiteFallbackFiles(
        this.state.prompt,
        this.state.taskId || "task"
      )
    }

    if (files.length > 0) {
      return { summary, files, commands }
    }

    if (isWebsite) {
      return createWebsiteFallbackFiles(
        this.state.prompt,
        this.state.taskId || "task"
      )
    }

    const fallbackPath = `sylica-agent-output/${this.state.taskId || "task"}/${phase.id}-summary.md`
    return {
      summary,
      files: [
        {
          relativePath: fallbackPath,
          title: `${phase.title} summary`,
          type: "document",
          content: `# ${phase.title}\n\n${summary}\n\n## Task\n\n${this.state.prompt}\n`,
        },
      ],
      commands,
    }
  }

  private normalizeArtifactType(value: unknown): AgentArtifactType {
    const normalized = String(value || "").trim()
    return normalized === "code" ||
      normalized === "design" ||
      normalized === "presentation" ||
      normalized === "research" ||
      normalized === "document" ||
      normalized === "other"
      ? normalized
      : "other"
  }

  private writeAgentFile(file: AgentFileWrite): AgentArtifact {
    if (Buffer.byteLength(file.content, "utf8") > MAX_AGENT_FILE_BYTES) {
      throw new Error(`Generated file is too large: ${file.relativePath}`)
    }

    const relativePath = sanitizeRelativePath(file.relativePath)
    const targetPath = path.resolve(this.state.workspacePath, relativePath)
    if (!this.isInsideWorkspace(targetPath)) {
      throw new Error(`Refused to write outside workspace: ${file.relativePath}`)
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.writeFileSync(targetPath, file.content, "utf8")

    return {
      id: `artifact-${Date.now()}-${randomUUID().slice(0, 6)}`,
      type: inferArtifactType(targetPath, file.type),
      title: file.title || path.basename(targetPath),
      path: targetPath,
      createdAt: nowIso(),
    }
  }

  private maybeWritePresentationDeck(
    phase: AgentPhase,
    result: AgentPhaseResult
  ): AgentArtifact | null {
    if (
      !isPresentationTask(this.state.prompt, phase, result.files) ||
      hasPptxFile(result.files)
    ) {
      return null
    }

    const taskId = this.state.taskId || "task"
    const relativePath = `sylica-agent-output/${taskId}/sylica-agent-deck.pptx`
    const targetPath = path.resolve(this.state.workspacePath, relativePath)
    if (!this.isInsideWorkspace(targetPath)) {
      throw new Error("Refused to write presentation outside workspace.")
    }

    const slides = extractSlidesFromFiles(this.state.prompt, phase, result)
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.writeFileSync(targetPath, buildPptx(slides))

    return {
      id: `artifact-${Date.now()}-${randomUUID().slice(0, 6)}`,
      type: "presentation",
      title: "Editable PowerPoint deck",
      path: targetPath,
      createdAt: nowIso(),
    }
  }

  private async runVerificationCommands(
    commands: string[],
    phaseId: string
  ): Promise<string[]> {
    const summaries: string[] = []
    for (const command of commands) {
      if (this.stoppingTaskId === this.state.taskId) {
        break
      }

      if (!isSafeWorkspaceCommand(command)) {
        const message = `Skipped unsafe or unsupported command: ${command}`
        this.addEvent("info", message, phaseId)
        summaries.push(message)
        continue
      }

      this.addEvent("worker", `Running verification: ${command}`, phaseId)
      const result = await this.runWorkspaceCommand(command)
      const status = result.exitCode === 0 ? "passed" : `failed (${result.exitCode})`
      const message = `${command} ${status}`
      this.addEvent(result.exitCode === 0 ? "done" : "error", message, phaseId)
      summaries.push(
        result.output ? `${message}\n${result.output.slice(-1200)}` : message
      )
    }

    return summaries
  }

  private runWorkspaceCommand(
    command: string
  ): Promise<{ exitCode: number; output: string }> {
    return new Promise((resolve) => {
      const child = spawn(command, {
        cwd: this.state.workspacePath,
        shell: true,
        windowsHide: true,
        env: {
          ...process.env,
          CI: "true",
        },
      })
      let output = ""
      let settled = false
      const timeoutId = setTimeout(() => {
        if (!settled) {
          settled = true
          child.kill()
          resolve({
            exitCode: -1,
            output: `${output}\nCommand timed out after 90 seconds.`.trim(),
          })
        }
      }, 90_000)

      const append = (chunk: Buffer) => {
        output = `${output}${chunk.toString("utf8")}`.slice(-6000)
      }

      child.stdout?.on("data", append)
      child.stderr?.on("data", append)
      child.on("error", (error) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeoutId)
        resolve({
          exitCode: -1,
          output: error.message,
        })
      })
      child.on("close", (code) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeoutId)
        resolve({
          exitCode: code ?? 0,
          output: output.trim(),
        })
      })
    })
  }

  private buildWorkspaceSnapshot(workspacePath: string): string {
    const treeLines: string[] = []
    const snippets: string[] = []
    const ignored = new Set([
      ".git",
      "node_modules",
      "dist",
      "dist-electron",
      "release",
      ".wrangler",
      ".next",
      "build",
      "coverage",
    ])

    const walk = (dir: string, depth: number) => {
      if (treeLines.length >= MAX_TREE_LINES || depth > 4) {
        return
      }

      let entries: fs.Dirent[] = []
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch (_error) {
        return
      }

      for (const entry of entries.slice(0, 80)) {
        if (treeLines.length >= MAX_TREE_LINES || ignored.has(entry.name)) {
          continue
        }

        const fullPath = path.join(dir, entry.name)
        const relativePath = path.relative(workspacePath, fullPath)
        treeLines.push(`${"  ".repeat(depth)}${entry.isDirectory() ? "[dir]" : "[file]"} ${relativePath}`)

        if (entry.isDirectory()) {
          walk(fullPath, depth + 1)
        } else if (snippets.length < MAX_FILE_SNIPPETS && this.isReadableTextFile(fullPath)) {
          try {
            const raw = fs.readFileSync(fullPath)
            snippets.push(
              `--- ${relativePath} ---\n${raw.toString("utf8").slice(0, MAX_FILE_SNIPPET_BYTES)}`
            )
          } catch (_error) {
            // Ignore unreadable files in the planning snapshot.
          }
        }
      }
    }

    walk(workspacePath, 0)
    return [
      `OS: ${os.platform()} ${os.release()}`,
      "Tree:",
      treeLines.join("\n") || "(empty workspace)",
      snippets.length ? "\nFile snippets:" : "",
      snippets.join("\n\n"),
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 70_000)
  }

  private isReadableTextFile(filePath: string): boolean {
    const lower = filePath.toLowerCase()
    if (/\.(png|jpe?g|gif|webp|ico|icns|pdf|zip|exe|dll|mp4|mov|mp3|wav|ttf|woff2?)$/i.test(lower)) {
      return false
    }

    try {
      const stat = fs.statSync(filePath)
      return stat.size <= MAX_FILE_SNIPPET_BYTES
    } catch (_error) {
      return false
    }
  }

  private getOpenAIClient(): OpenAI {
    const apiKey = configHelper.getConfiguredApiKey("openai")
    if (!apiKey) {
      throw new Error("OpenAI API key is not configured for Agent Mode.")
    }

    return new OpenAI({ apiKey })
  }

  private async createChatCompletion(
    system: string,
    user: string,
    maxTokens: number
  ): Promise<string> {
    const models = [
      AGENT_MODEL,
      ...AGENT_FALLBACK_MODELS.filter((model) => model !== AGENT_MODEL),
    ]
    let lastError: unknown = null

    for (const model of models) {
      const request: Record<string, unknown> = {
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: maxTokens,
        temperature: 0.25,
      }

      if (supportsReasoningEffort(model)) {
        request.reasoning_effort = "high"
        request.max_completion_tokens = maxTokens
        delete request.max_tokens
        delete request.temperature
      }

      try {
        const response = await this.getOpenAIClient().chat.completions.create(request as any)
        return response.choices[0]?.message?.content?.trim() || ""
      } catch (error) {
        lastError = error
        const message = error instanceof Error ? error.message : String(error)
        const canTryFallback = /model|not found|does not exist|unsupported|access|invalid/i.test(message)
        if (!canTryFallback || model === models[models.length - 1]) {
          throw error
        }
        console.warn(`Agent model ${model} failed, trying fallback.`, message)
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Agent model request failed.")
  }
}
