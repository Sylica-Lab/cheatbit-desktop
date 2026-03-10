import { execFile, spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { OpenAI } from "openai"
import { app, type BrowserWindow } from "electron"
import type { Browser, Page } from "puppeteer-core"
import { backendClient } from "./BackendClient"
import { configHelper } from "./ConfigHelper"
import { TOGETHER_BASE_URL } from "../shared/aiConfig"
import type {
  BrowserAgentAction,
  ChatThreadSummary,
  ComputerUseResumeData,
  ComputerUseStartData,
  ComputerUseState,
} from "../shared/followUpChat"
import { EMPTY_COMPUTER_USE_STATE } from "../shared/followUpChat"

const execFileAsync = promisify(execFile)

const COMPUTER_USE_STATE_EVENT = "computer-use-state"
const COMPUTER_USE_MODEL = "moonshotai/Kimi-K2.5"
const CHROME_DEBUGGING_PORT = 9227
const MAX_AGENT_STEPS = 18
const MAX_INTERACTIVE_TARGETS = 35
const SNAPSHOT_TEXT_LIMIT = 2800
const STEP_SETTLE_DELAY_MS = 900

type PuppeteerRuntime = typeof import("puppeteer-core")

let puppeteerRuntimeCache: PuppeteerRuntime | null = null

function getPuppeteerRuntime(): PuppeteerRuntime {
  if (puppeteerRuntimeCache) {
    return puppeteerRuntimeCache
  }

  process.env.WS_NO_BUFFER_UTIL = "1"
  process.env.WS_NO_UTF_8_VALIDATE = "1"

  const puppeteerModule = require("puppeteer-core") as PuppeteerRuntime & {
    default?: PuppeteerRuntime
  }

  puppeteerRuntimeCache = (puppeteerModule.default || puppeteerModule) as PuppeteerRuntime
  return puppeteerRuntimeCache
}

interface BrowserAgentControllerDeps {
  getMainWindow: () => BrowserWindow | null
}

interface BrowserTarget {
  targetId: string
  selector: string
  tag: string
  role: string
  text: string
  label: string
  placeholder: string
  type: string
  href: string
  value: string
  disabled: boolean
  x: number
  y: number
  width: number
  height: number
}

interface BrowserSnapshot {
  url: string
  title: string
  bodyText: string
  selectedText: string
  activeElement: string
  headings: string[]
  pageKind: "standard" | "dom_light" | "canvas_heavy" | "pdf_like"
  domConfidence: "high" | "medium" | "low"
  interactiveTargets: BrowserTarget[]
  tabSummaries: Array<{
    index: number
    title: string
    url: string
  }>
  screenshotBase64: string | null
}

interface PlannedBrowserAction {
  thought: string
  statusMessage: string
  action: BrowserAgentAction
}

interface ActiveComputerUseSession {
  id: string
  thread: ChatThreadSummary
  task: string
  browser: Browser | null
  page: Page | null
  stepCount: number
  currentAction: string
  currentUrl: string
  currentTitle: string
  needsSecretInput: boolean
  latestError: string
  actionHistory: string[]
  extractedNotes: string[]
  isStopping: boolean
  waitingForSecret: boolean
  launchedChrome: boolean
  ownsBrowserProcess: boolean
  lastPageSignature: string | null
  lastPageSummary: string
}

interface ActionExecutionResult {
  summary: string
  extractedNote?: string
}

interface BrowserEvaluateSnapshot {
  interactiveTargets: BrowserTarget[]
  bodyText: string
  selectedText: string
  activeElement: string
  headings: string[]
  canvasCount: number
  embedCount: number
  inputCount: number
}

export interface BrowserAgentContextSnapshot {
  threadId: string
  status: ComputerUseState["status"]
  task: string
  currentUrl: string
  currentTitle: string
  currentAction: string
  stepCount: number
  needsSecretInput: boolean
  latestError: string
  pageSignature: string | null
  pageSummary: string
  extractedNotes: string[]
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeTaskTitle(task: string) {
  const normalized = task.replace(/\s+/g, " ").trim()
  if (!normalized) {
    return "Computer task"
  }

  if (normalized.length <= 54) {
    return `Computer Use · ${normalized}`
  }

  return `Computer Use · ${normalized.slice(0, 51).trimEnd()}...`
}

function toSafeJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed) {
    return null
  }

  try {
    return JSON.parse(trimmed) as Record<string, unknown>
  } catch (_error) {
    const firstBrace = trimmed.indexOf("{")
    const lastBrace = trimmed.lastIndexOf("}")
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as Record<
          string,
          unknown
        >
      } catch (_nestedError) {
        return null
      }
    }
    return null
  }
}

function sanitizeText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function extractTaskSearchQuery(task: string): string {
  const normalized = task.replace(/\s+/g, " ").trim()
  const searchMatch = normalized.match(
    /\bsearch for\b\s+(.+?)(?:\.\s*|,\s*|\s+and\s+(?:open|show|tell|summarize)\b|$)/i
  )
  if (searchMatch?.[1]) {
    return searchMatch[1].trim()
  }

  return normalized
}

function looksLikeSearchTarget(target: BrowserTarget): boolean {
  const combined = [
    target.role,
    target.label,
    target.placeholder,
    target.text,
    target.type,
  ]
    .join(" ")
    .toLowerCase()

  return (
    target.type === "search" ||
    combined.includes("search") ||
    combined.includes("find") ||
    combined.includes("lookup")
  )
}

function inferFallbackAction(
  task: string,
  snapshot: BrowserSnapshot
): { action: BrowserAgentAction; statusMessage: string } | null {
  const normalized = task.replace(/\s+/g, " ").trim()

  if (/\bsearch for\b/i.test(normalized)) {
    const query = extractTaskSearchQuery(normalized)
    const searchTarget = snapshot.interactiveTargets.find((target) =>
      looksLikeSearchTarget(target)
    )

    if (searchTarget && query) {
      return {
        statusMessage: "Searching on the page...",
        action: {
          type: "type",
          targetId: searchTarget.targetId,
          text: query,
          submit: true,
        },
      }
    }
  }

  return null
}

function inferPageKind(input: {
  url: string
  bodyTextLength: number
  interactiveTargetCount: number
  canvasCount: number
  embedCount: number
}): BrowserSnapshot["pageKind"] {
  const url = input.url.toLowerCase()
  if (url.includes(".pdf") || input.embedCount > 0) {
    return "pdf_like"
  }

  if (input.canvasCount > 0 && input.bodyTextLength < 240) {
    return "canvas_heavy"
  }

  if (input.bodyTextLength < 180 && input.interactiveTargetCount < 3) {
    return "dom_light"
  }

  return "standard"
}

function inferDomConfidence(input: {
  bodyTextLength: number
  interactiveTargetCount: number
  headingCount: number
}): BrowserSnapshot["domConfidence"] {
  if (
    input.bodyTextLength >= 700 ||
    input.interactiveTargetCount >= 8 ||
    input.headingCount >= 3
  ) {
    return "high"
  }

  if (
    input.bodyTextLength >= 180 ||
    input.interactiveTargetCount >= 3 ||
    input.headingCount >= 1
  ) {
    return "medium"
  }

  return "low"
}

export class BrowserAgentController {
  private readonly deps: BrowserAgentControllerDeps
  private readonly openaiClient: OpenAI
  private state: ComputerUseState = { ...EMPTY_COMPUTER_USE_STATE }
  private session: ActiveComputerUseSession | null = null

  constructor(deps: BrowserAgentControllerDeps) {
    this.deps = deps
    const apiKey = configHelper.getConfiguredApiKey("together")
    this.openaiClient = new OpenAI({
      apiKey,
      baseURL: TOGETHER_BASE_URL,
      timeout: 90000,
      maxRetries: 1,
    })
  }

  public getState(): ComputerUseState {
    return { ...this.state }
  }

  public hasActiveSession(): boolean {
    return this.session !== null
  }

  public async startTask(task: string): Promise<
    | { success: true; data: ComputerUseStartData }
    | { success: false; error: string; authRequired?: boolean }
  > {
    const normalizedTask = task.trim()
    if (!normalizedTask) {
      return {
        success: false,
        error: "Enter a browser task first.",
      }
    }

    if (this.session) {
      return {
        success: false,
        error: "A computer task is already running.",
      }
    }

    try {
      const usageDecision = await backendClient.consumeUsage("computer_use")
      if (!usageDecision.allowed) {
        return {
          success: false,
          error:
            usageDecision.error || "Computer Use is available on the Pro plan.",
          authRequired: !usageDecision.session,
        }
      }

      const thread = await backendClient.createChatThread(
        "computer_use",
        normalizeTaskTitle(normalizedTask)
      )
      const savedTask = await backendClient.appendChatMessage({
        threadId: thread.id,
        role: "user",
        content: normalizedTask,
      })
      const savedStart = await backendClient.appendChatMessage({
        threadId: thread.id,
        role: "assistant",
        content: "Starting browser task...",
      })

      const nextThread = savedStart.thread || savedTask.thread || thread
      this.session = {
        id: `comp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        thread: nextThread,
        task: normalizedTask,
        browser: null,
        page: null,
        stepCount: 0,
        currentAction: "Starting browser task...",
        currentUrl: "",
        currentTitle: "",
        needsSecretInput: false,
        latestError: "",
        actionHistory: [],
        extractedNotes: [],
        isStopping: false,
        waitingForSecret: false,
        launchedChrome: false,
        ownsBrowserProcess: false,
        lastPageSignature: null,
        lastPageSummary: "",
      }

      this.updateState({
        status: "starting",
        threadId: nextThread.id,
        task: normalizedTask,
        currentUrl: "",
        currentTitle: "",
        currentAction: "Starting browser task...",
        stepCount: 0,
        needsSecretInput: false,
        latestError: "",
      })

      void this.runSession(this.session)

      return {
        success: true,
        data: {
          thread: nextThread,
          state: this.getState(),
        },
      }
    } catch (error) {
      this.resetState()
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to start browser control.",
      }
    }
  }

  public async stopTask(): Promise<
    | { success: true; data: { state: ComputerUseState } }
    | { success: false; error: string }
  > {
    const session = this.session
    if (!session) {
      return {
        success: true,
        data: { state: this.getState() },
      }
    }

    session.isStopping = true
    session.waitingForSecret = false
    this.clearSession()
    this.updateState({
      status: "stopping",
      threadId: session.thread.id,
      task: session.task,
      currentUrl: session.currentUrl,
      currentTitle: session.currentTitle,
      currentAction: "Stopping browser task...",
      stepCount: session.stepCount,
      needsSecretInput: false,
      latestError: "",
    })

    try {
      await this.appendAssistantMessage(
        session.thread.id,
        "Stopped the browser task."
      )
      this.updateState({
        status: "completed",
        threadId: session.thread.id,
        task: session.task,
        currentUrl: session.currentUrl,
        currentTitle: session.currentTitle,
        currentAction: "Stopped browser task.",
        stepCount: session.stepCount,
        needsSecretInput: false,
        latestError: "",
      })
      await this.disconnectBrowser(session)
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to stop browser control.",
      }
    }

    return {
      success: true,
      data: { state: this.getState() },
    }
  }

  public async resumeAfterSecret(): Promise<
    | { success: true; data: ComputerUseResumeData }
    | { success: false; error: string }
  > {
    const session = this.session
    if (!session) {
      return {
        success: false,
        error: "No browser task is active.",
      }
    }

    if (!session.waitingForSecret) {
      return {
        success: false,
        error: "The browser task is not waiting for secret input.",
      }
    }

    session.waitingForSecret = false
    session.needsSecretInput = false
    this.updateState({
      status: "running",
      threadId: session.thread.id,
      task: session.task,
      currentUrl: session.currentUrl,
      currentTitle: session.currentTitle,
      currentAction: "Resuming browser task...",
      stepCount: session.stepCount,
      needsSecretInput: false,
      latestError: "",
    })

    await this.appendAssistantMessage(
      session.thread.id,
      "Resuming after manual secret entry."
    )
    void this.runSession(session)

    return {
      success: true,
      data: { state: this.getState() },
    }
  }

  public shutdown(): void {
    this.resetState()
  }

  public getContextSnapshot(): BrowserAgentContextSnapshot | null {
    const session = this.session
    if (!session) {
      return null
    }

    return {
      threadId: session.thread.id,
      status: this.state.status,
      task: session.task,
      currentUrl: session.currentUrl,
      currentTitle: session.currentTitle,
      currentAction: session.currentAction,
      stepCount: session.stepCount,
      needsSecretInput: session.needsSecretInput,
      latestError: session.latestError,
      pageSignature: session.lastPageSignature,
      pageSummary: session.lastPageSummary,
      extractedNotes: session.extractedNotes.slice(-3),
    }
  }

  private clearSession(): void {
    this.session = null
  }

  private resetState(): void {
    this.clearSession()
    this.state = { ...EMPTY_COMPUTER_USE_STATE }
    this.emitState()
  }

  private emitState(): void {
    const mainWindow = this.deps.getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) {
      return
    }

    mainWindow.webContents.send(COMPUTER_USE_STATE_EVENT, this.getState())
  }

  private updateState(partial: Partial<ComputerUseState>): void {
    this.state = {
      ...this.state,
      ...partial,
    }
    this.emitState()
  }

  private isCurrentSession(session: ActiveComputerUseSession | null): boolean {
    return Boolean(session) && this.session?.id === session?.id
  }

  private canContinueSession(session: ActiveComputerUseSession | null): boolean {
    return (
      this.isCurrentSession(session) &&
      !session?.isStopping &&
      !session?.waitingForSecret
    )
  }

  private canEmitForSession(session: ActiveComputerUseSession | null): boolean {
    return this.isCurrentSession(session) && !session?.isStopping
  }

  private hashValue(value: string): string {
    return crypto.createHash("sha1").update(value).digest("hex")
  }

  private buildBrowserPageSignature(snapshot: BrowserSnapshot): string {
    return this.hashValue(
      JSON.stringify({
        url: snapshot.url,
        title: snapshot.title,
        headings: snapshot.headings.slice(0, 4),
        bodyText: snapshot.bodyText.slice(0, 420),
        selectedText: snapshot.selectedText,
        activeElement: snapshot.activeElement,
        pageKind: snapshot.pageKind,
        interactiveTargets: snapshot.interactiveTargets
          .slice(0, 6)
          .map((target) => ({
            id: target.targetId,
            text: target.text,
            label: target.label,
            placeholder: target.placeholder,
            href: target.href,
          })),
      })
    )
  }

  private buildBrowserPageSummary(snapshot: BrowserSnapshot): string {
    const headingLine =
      snapshot.headings.length > 0
        ? snapshot.headings.slice(0, 2).join(" · ")
        : snapshot.title
    const textPreview = snapshot.bodyText.trim().replace(/\s+/g, " ").slice(0, 180)
    return [headingLine, textPreview].filter(Boolean).join(" — ").trim()
  }

  private async runSession(session: ActiveComputerUseSession): Promise<void> {
    if (!this.canContinueSession(session)) {
      return
    }

    try {
      if (!session.browser) {
        const { browser, launchedChrome, ownsBrowserProcess } =
          await this.connectToControlledChrome()
        session.browser = browser
        session.launchedChrome = launchedChrome
        session.ownsBrowserProcess = ownsBrowserProcess

        if (!this.canContinueSession(session)) {
          await this.disconnectBrowser(session)
          return
        }
      }

      if (!session.page || session.page.isClosed()) {
        session.page = await this.openControlledPage(session.browser)
        if (!this.canContinueSession(session)) {
          await this.disconnectBrowser(session)
          return
        }
      }

      while (
        this.canContinueSession(session) &&
        session.stepCount < MAX_AGENT_STEPS
      ) {
        const snapshot = await this.captureSnapshot(session)
        if (!this.canContinueSession(session)) {
          return
        }
        session.currentUrl = snapshot.url
        session.currentTitle = snapshot.title
        session.lastPageSignature = this.buildBrowserPageSignature(snapshot)
        session.lastPageSummary = this.buildBrowserPageSummary(snapshot)
        this.updateState({
          status: "running",
          threadId: session.thread.id,
          task: session.task,
          currentUrl: snapshot.url,
          currentTitle: snapshot.title,
          currentAction: session.currentAction,
          stepCount: session.stepCount,
          needsSecretInput: false,
          latestError: "",
        })

        const planned =
          session.stepCount === 0 && this.isBlankPageSnapshot(snapshot)
            ? await this.planInitialAction(session, snapshot).catch(() =>
                this.planNextAction(session, snapshot)
              )
            : await this.planNextAction(session, snapshot)
        if (!this.canContinueSession(session)) {
          return
        }
        const action = this.validateAction(planned.action, snapshot)
        session.currentAction =
          sanitizeText(planned.statusMessage) || this.describeAction(action, snapshot)
        if (action.type === "open_url") {
          session.currentUrl = action.url
        }

        this.updateState({
          status: "running",
          threadId: session.thread.id,
          task: session.task,
          currentUrl:
            action.type === "open_url"
              ? action.url
              : session.currentUrl || snapshot.url,
          currentTitle: snapshot.title,
          currentAction: session.currentAction,
          stepCount: session.stepCount,
          needsSecretInput: false,
          latestError: "",
        })

        if (action.type === "request_secret_input") {
          session.waitingForSecret = true
          session.needsSecretInput = true
          const reason =
            sanitizeText(action.reason) ||
            "Manual secret entry is required in Chrome before continuing."
          await this.appendAssistantMessage(session.thread.id, reason, session)
          if (!this.canEmitForSession(session)) {
            return
          }
          this.updateState({
            status: "waiting_for_secret",
            threadId: session.thread.id,
            task: session.task,
            currentUrl: snapshot.url,
            currentTitle: snapshot.title,
            currentAction: "Waiting for manual secret input...",
            stepCount: session.stepCount,
            needsSecretInput: true,
            latestError: "",
          })
          return
        }

        if (action.type === "finish") {
          const resultText =
            sanitizeText(action.result) || "Finished the browser task."
          await this.appendAssistantMessage(session.thread.id, resultText, session)
          if (!this.canEmitForSession(session)) {
            return
          }
          this.updateState({
            status: "completed",
            threadId: session.thread.id,
            task: session.task,
            currentUrl: snapshot.url,
            currentTitle: snapshot.title,
            currentAction: "Task finished.",
            stepCount: session.stepCount,
            needsSecretInput: false,
            latestError: "",
          })
          await this.disconnectBrowser(session)
          this.clearSession()
          return
        }

        const executionResult = await this.executeAction(session, action, snapshot)
        if (!this.canContinueSession(session)) {
          return
        }
        session.stepCount += 1
        session.actionHistory.push(executionResult.summary)
        if (executionResult.extractedNote) {
          session.extractedNotes.push(executionResult.extractedNote)
        }

        await this.appendAssistantMessage(
          session.thread.id,
          executionResult.summary,
          session
        )
        if (!this.canContinueSession(session)) {
          return
        }
        await wait(STEP_SETTLE_DELAY_MS)
      }

      if (!this.canContinueSession(session)) {
        return
      }

      await this.failSession(
        session,
        "Stopped because the browser task reached the step limit."
      )
    } catch (error) {
      if (session.isStopping) {
        return
      }
      const message =
        error instanceof Error ? error.message : "Browser automation failed."
      await this.failSession(session, message)
    }
  }

  private async failSession(
    session: ActiveComputerUseSession,
    message: string
  ): Promise<void> {
    if (session.isStopping) {
      return
    }

    if (!this.isCurrentSession(session)) {
      return
    }

    session.latestError = message
    await this.appendAssistantMessage(session.thread.id, message, session)
    if (!this.canEmitForSession(session)) {
      return
    }
    this.updateState({
      status: "error",
      threadId: session.thread.id,
      task: session.task,
      currentUrl: session.currentUrl,
      currentTitle: session.currentTitle,
      currentAction: "Browser task failed.",
      stepCount: session.stepCount,
      needsSecretInput: false,
      latestError: message,
    })
    await this.disconnectBrowser(session)
    this.clearSession()
  }

  private async appendAssistantMessage(
    threadId: string,
    content: string,
    session?: ActiveComputerUseSession
  ): Promise<void> {
    const normalized = content.trim()
    if (!normalized) {
      return
    }

    if (session && !this.canEmitForSession(session)) {
      return
    }

    try {
      const response = await backendClient.appendChatMessage({
        threadId,
        role: "assistant",
        content: normalized,
      })

      if (session && !this.canEmitForSession(session)) {
        return
      }

      if (this.session && this.session.thread.id === threadId) {
        this.session.thread = response.thread
      }
    } catch (error) {
      console.error("Failed to persist browser agent message:", error)
    }
  }

  private async connectToControlledChrome(): Promise<{
    browser: Browser
    launchedChrome: boolean
    ownsBrowserProcess: boolean
  }> {
    const puppeteer = getPuppeteerRuntime()
    const browserUrl = `http://127.0.0.1:${CHROME_DEBUGGING_PORT}`
    const debuggerVersion = await this.readChromeVersion(browserUrl)

    if (debuggerVersion) {
      const browser = await puppeteer.connect({
        browserURL: browserUrl,
        defaultViewport: null,
      })

      return { browser, launchedChrome: false, ownsBrowserProcess: false }
    }

    const browser = await this.launchDedicatedChrome()
    return { browser, launchedChrome: true, ownsBrowserProcess: true }
  }

  private async launchDedicatedChrome(): Promise<Browser> {
    const chromePath = this.findChromeExecutable()
    if (!chromePath) {
      throw new Error("Google Chrome was not found on this computer.")
    }

    const browserUrl = `http://127.0.0.1:${CHROME_DEBUGGING_PORT}`
    const profileDir = this.getBrowserAgentProfileDir()
    const args = [
      `--remote-debugging-port=${CHROME_DEBUGGING_PORT}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--start-maximized",
      "--disable-backgrounding-occluded-windows",
      "about:blank",
    ]

    const chromeProcess = spawn(chromePath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    })
    chromeProcess.unref()

    const debuggerVersion = await this.waitForChromeDebugger(browserUrl)
    if (!debuggerVersion) {
      throw new Error(
        "Chrome started but the automation port never became available."
      )
    }

    const puppeteer = getPuppeteerRuntime()
    return puppeteer.connect({
      browserURL: browserUrl,
      defaultViewport: null,
    })
  }

  private async disconnectBrowser(session: ActiveComputerUseSession): Promise<void> {
    if (!session.browser) {
      return
    }

    try {
      await session.browser.disconnect()
    } catch (_error) {
      // Ignore disconnect errors.
    } finally {
      session.browser = null
      session.page = null
      session.ownsBrowserProcess = false
    }
  }

  private async relaunchChromeForAutomation(): Promise<void> {
    const chromePath = this.findChromeExecutable()
    if (!chromePath) {
      throw new Error("Google Chrome was not found on this computer.")
    }

    const chromeUserDataDir = this.getChromeUserDataDir()
    if (!chromeUserDataDir || !fs.existsSync(chromeUserDataDir)) {
      throw new Error("Chrome profile data was not found on this computer.")
    }

    await this.stopChromeProcesses()
    await wait(1200)

    const args = [
      `--remote-debugging-port=${CHROME_DEBUGGING_PORT}`,
      `--user-data-dir=${chromeUserDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--start-minimized",
      "about:blank",
    ]

    const chromeProcess = spawn(chromePath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    })
    chromeProcess.unref()
  }

  private async stopChromeProcesses(): Promise<void> {
    try {
      if (process.platform === "win32") {
        await execFileAsync("taskkill", ["/IM", "chrome.exe", "/F"])
        return
      }

      if (process.platform === "darwin") {
        await execFileAsync("pkill", ["-f", "Google Chrome"])
        return
      }

      await execFileAsync("pkill", ["-f", "chrome"])
    } catch (_error) {
      // It is fine if Chrome was not running.
    }
  }

  private async readChromeVersion(browserUrl: string): Promise<Record<string, unknown> | null> {
    try {
      const response = await fetch(`${browserUrl}/json/version`)
      if (!response.ok) {
        return null
      }

      return (await response.json()) as Record<string, unknown>
    } catch (_error) {
      return null
    }
  }

  private async waitForChromeDebugger(
    browserUrl: string
  ): Promise<Record<string, unknown> | null> {
    const maxAttempts = 24
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const version = await this.readChromeVersion(browserUrl)
      if (version) {
        return version
      }

      await wait(500)
    }

    return null
  }

  private findChromeExecutable(): string | null {
    const candidates: string[] = []

    if (process.platform === "win32") {
      const localAppData = process.env.LOCALAPPDATA || ""
      const programFiles = process.env.PROGRAMFILES || ""
      const programFilesX86 = process.env["PROGRAMFILES(X86)"] || ""
      candidates.push(
        path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe")
      )
    } else if (process.platform === "darwin") {
      candidates.push(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      )
    } else {
      candidates.push(
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/snap/bin/chromium"
      )
    }

    return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null
  }

  private getChromeUserDataDir(): string | null {
    const homeDir = os.homedir()
    if (process.platform === "win32") {
      const localAppData = process.env.LOCALAPPDATA || ""
      return localAppData
        ? path.join(localAppData, "Google", "Chrome", "User Data")
        : null
    }

    if (process.platform === "darwin") {
      return path.join(homeDir, "Library", "Application Support", "Google", "Chrome")
    }

    return path.join(homeDir, ".config", "google-chrome")
  }

  private getBrowserAgentProfileDir(): string {
    const baseDir = app.getPath("userData")
    const profileDir = path.join(baseDir, "browser-agent-profile")
    fs.mkdirSync(profileDir, { recursive: true })
    return profileDir
  }

  private async resolveWorkingPage(browser: Browser): Promise<Page> {
    const pages = await browser.pages()
    const usablePage =
      [...pages]
        .reverse()
        .find((page) => {
          const url = page.url()
          return (
            !page.isClosed() &&
            !url.startsWith("devtools://") &&
            !url.startsWith("chrome://")
          )
        }) || null

    if (usablePage) {
      return usablePage
    }

    return browser.newPage()
  }

  private async openControlledPage(browser: Browser): Promise<Page> {
    const page = await browser.newPage()
    await page.bringToFront()
    return page
  }

  private async captureSnapshot(
    session: ActiveComputerUseSession
  ): Promise<BrowserSnapshot> {
    const page = session.page
    if (!page) {
      throw new Error("No browser page is available for automation.")
    }

    const evaluated = await page.evaluate((limit, textLimit) => {
      const normalizeText = (value: string) => value.replace(/\s+/g, " ").trim()
      const isVisible = (element: Element) => {
        const style = window.getComputedStyle(element as HTMLElement)
        const rect = (element as HTMLElement).getBoundingClientRect()
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.width > 0 &&
          rect.height > 0
        )
      }

      document
        .querySelectorAll("[data-sylica-agent-id]")
        .forEach((element) => element.removeAttribute("data-sylica-agent-id"))

      const summarizeElement = (element: Element | null) => {
        if (!element) {
          return ""
        }

        const htmlElement = element as HTMLElement
        const inputElement = element as HTMLInputElement
        const parts = [
          element.tagName.toLowerCase(),
          normalizeText(
            element.getAttribute("aria-label") ||
              htmlElement.innerText ||
              htmlElement.textContent ||
              inputElement.value ||
              inputElement.placeholder ||
              ""
          ).slice(0, 120),
        ].filter(Boolean)

        return parts.join(": ")
      }

      const candidates = Array.from(
        document.querySelectorAll(
          [
            "a[href]",
            "button",
            "input",
            "textarea",
            "select",
            "[role='button']",
            "[contenteditable='true']",
            "[type='file']",
          ].join(",")
        )
      )
        .filter((element) => isVisible(element))
        .slice(0, limit)

      const interactiveTargets = candidates.map((element, index) => {
        const targetId = `target-${index + 1}`
        element.setAttribute("data-sylica-agent-id", targetId)
        const htmlElement = element as HTMLElement
        const inputElement = element as HTMLInputElement
        const selector = `[data-sylica-agent-id="${targetId}"]`
        const rect = htmlElement.getBoundingClientRect()
        return {
          targetId,
          selector,
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role") || "",
          text: normalizeText(
            htmlElement.innerText ||
              htmlElement.textContent ||
              inputElement.value ||
              ""
          ).slice(0, 140),
          label: normalizeText(
            element.getAttribute("aria-label") ||
              htmlElement.getAttribute("title") ||
              ""
          ).slice(0, 140),
          placeholder: normalizeText(
            inputElement.placeholder || element.getAttribute("placeholder") || ""
          ).slice(0, 140),
          type: normalizeText(inputElement.type || ""),
          href: normalizeText((element as HTMLAnchorElement).href || "").slice(0, 220),
          value: normalizeText(inputElement.value || "").slice(0, 120),
          disabled:
            inputElement.disabled ||
            htmlElement.getAttribute("aria-disabled") === "true",
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        }
      })

      const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
        .filter((element) => isVisible(element))
        .map((element) => normalizeText(element.textContent || ""))
        .filter(Boolean)
        .slice(0, 6)

      const selectedText = normalizeText(window.getSelection()?.toString() || "").slice(
        0,
        240
      )
      const bodyText = normalizeText(document.body?.innerText || "").slice(0, textLimit)
      const activeElement = summarizeElement(document.activeElement)

      return {
        interactiveTargets,
        bodyText,
        selectedText,
        activeElement,
        headings,
        canvasCount: document.querySelectorAll("canvas").length,
        embedCount: document.querySelectorAll("embed, object, iframe[src*='.pdf']").length,
        inputCount: document.querySelectorAll("input, textarea, select").length,
      }
    }, MAX_INTERACTIVE_TARGETS, SNAPSHOT_TEXT_LIMIT) as BrowserEvaluateSnapshot

    const [title, url, pages] = await Promise.all([
      page.title(),
      Promise.resolve(page.url()),
      session.browser
        ? session.browser.pages().then(async (browserPages) =>
            Promise.all(
              browserPages
                .filter((browserPage) => !browserPage.isClosed())
                .slice(0, 8)
                .map(async (browserPage, index) => ({
                  index,
                  title: (await browserPage.title()).trim() || "Untitled",
                  url: browserPage.url(),
                }))
            )
          )
        : Promise.resolve([]),
    ])

    const pageKind = inferPageKind({
      url,
      bodyTextLength: evaluated.bodyText.length,
      interactiveTargetCount: evaluated.interactiveTargets.length,
      canvasCount: evaluated.canvasCount,
      embedCount: evaluated.embedCount,
    })
    const domConfidence = inferDomConfidence({
      bodyTextLength: evaluated.bodyText.length,
      interactiveTargetCount: evaluated.interactiveTargets.length,
      headingCount: evaluated.headings.length,
    })
    const shouldAttachScreenshot =
      pageKind !== "standard" || domConfidence !== "high"

    let screenshotBase64: string | null = null
    if (shouldAttachScreenshot) {
      try {
        const screenshot = await page.screenshot({
          type: "jpeg",
          quality: 45,
          fullPage: false,
          captureBeyondViewport: false,
          encoding: "base64",
        })
        screenshotBase64 =
          typeof screenshot === "string"
            ? screenshot
            : Buffer.from(screenshot).toString("base64")
      } catch (_error) {
        screenshotBase64 = null
      }
    }

    return {
      url,
      title,
      bodyText: evaluated.bodyText,
      selectedText: evaluated.selectedText,
      activeElement: evaluated.activeElement,
      headings: evaluated.headings,
      pageKind,
      domConfidence,
      interactiveTargets: evaluated.interactiveTargets,
      tabSummaries: pages,
      screenshotBase64,
    }
  }

  private async planNextAction(
    session: ActiveComputerUseSession,
    snapshot: BrowserSnapshot
  ): Promise<PlannedBrowserAction> {
    const actionHistory = session.actionHistory.slice(-8).join("\n") || "None yet."
    const extractedNotes = session.extractedNotes.slice(-5).join("\n") || "None yet."
    const targetLines =
      snapshot.interactiveTargets.length > 0
        ? snapshot.interactiveTargets
            .map((target) => {
              const parts = [
                `${target.targetId}`,
                `${target.tag}${target.type ? `:${target.type}` : ""}`,
                target.text ? `text="${target.text}"` : "",
                target.label ? `label="${target.label}"` : "",
                target.placeholder ? `placeholder="${target.placeholder}"` : "",
                target.value ? `value="${target.value}"` : "",
                target.href ? `href="${target.href}"` : "",
                target.disabled ? "disabled=true" : "",
                `box=${target.x},${target.y},${target.width}x${target.height}`,
              ].filter(Boolean)
              return `- ${parts.join(" | ")}`
            })
            .join("\n")
        : "- No interactive targets detected."

    const tabLines =
      snapshot.tabSummaries.length > 0
        ? snapshot.tabSummaries
            .map((tab) => `- [${tab.index}] ${tab.title} | ${tab.url}`)
            .join("\n")
        : "- No tabs listed."

    const prompt = `You are Sylica AI controlling Chrome for a browser task.
Goal:
${session.task}

Current page:
- Title: ${snapshot.title || "Untitled"}
- URL: ${snapshot.url || "unknown"}

Open tabs:
${tabLines}

Page structure:
- Kind: ${snapshot.pageKind}
- DOM confidence: ${snapshot.domConfidence}
- Selected text: ${snapshot.selectedText || "None"}
- Focused element: ${snapshot.activeElement || "None"}
- Headings:
${snapshot.headings.length > 0 ? snapshot.headings.map((heading) => `  - ${heading}`).join("\n") : "  - None"}

Recent page text:
${snapshot.bodyText || "No readable page text."}

Interactive targets:
${targetLines}

Recent action history:
${actionHistory}

Extracted notes:
${extractedNotes}

Rules:
- Return JSON only.
- Finish the task in the fewest safe steps.
- Use targetId values from the list instead of inventing selectors.
- Prefer DOM targets and URLs when DOM confidence is high.
- Use the screenshot only as fallback context when the page kind is not standard or the DOM is weak.
- Pay attention to selected text, headings, and the focused element.
- If credentials, OTPs, payment data, or secrets are needed, return request_secret_input.
- Do not guess file paths.
- If the task is done, return finish with a short result.
- Prefer open_url for direct navigation when a destination is obvious.
- Prefer click/type/select actions over vague key presses.

Return exactly:
{
  "thought": "short reasoning",
  "statusMessage": "very short status for the UI",
  "action": {
    "type": "open_url|new_tab|switch_tab|close_tab|click|type|press_key|scroll|select_option|upload_file|download_file|wait_for|extract|finish|request_secret_input"
  }
}`

    const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }]
    if (snapshot.screenshotBase64) {
      content.push({
        type: "image_url",
        image_url: {
          url: `data:image/jpeg;base64,${snapshot.screenshotBase64}`,
        },
      })
    }

    const response = await this.openaiClient.chat.completions.create({
      model: COMPUTER_USE_MODEL,
      temperature: 0.1,
      max_tokens: 520,
      messages: [
        {
          role: "system",
          content:
            "You are a precise browser automation planner. Output strict JSON only.",
        },
        {
          role: "user",
          content: content as any,
        },
      ],
    })

    const rawText = sanitizeText(response.choices[0]?.message?.content)
    const parsed = toSafeJson(rawText)
    if (!parsed || !isObject(parsed.action)) {
      const fallback = inferFallbackAction(session.task, snapshot)
      if (fallback) {
        return {
          thought: "Recovered from malformed planner output using the current page structure.",
          statusMessage: fallback.statusMessage,
          action: fallback.action,
        }
      }

      throw new Error("The browser planner returned invalid JSON.")
    }

    return {
      thought: sanitizeText(parsed.thought),
      statusMessage: sanitizeText(parsed.statusMessage),
      action: parsed.action as unknown as BrowserAgentAction,
    }
  }

  private isBlankPageSnapshot(snapshot: BrowserSnapshot): boolean {
    const url = snapshot.url.trim().toLowerCase()
    const title = snapshot.title.trim().toLowerCase()
    return (
      url === "" ||
      url === "about:blank" ||
      (url.startsWith("chrome://newtab") && snapshot.bodyText.length < 80) ||
      (title === "about:blank" && snapshot.bodyText.length < 80)
    )
  }

  private async planInitialAction(
    session: ActiveComputerUseSession,
    snapshot: BrowserSnapshot
  ): Promise<PlannedBrowserAction> {
    const tabLines =
      snapshot.tabSummaries.length > 0
        ? snapshot.tabSummaries
            .map((tab) => `- [${tab.index}] ${tab.title} | ${tab.url}`)
            .join("\n")
        : "- No tabs listed."

    const response = await this.openaiClient.chat.completions.create({
      model: COMPUTER_USE_MODEL,
      temperature: 0.05,
      max_tokens: 180,
      messages: [
        {
          role: "system",
          content:
            "You are a precise browser automation planner. Return strict JSON only. On a blank/new tab, choose the fastest sensible first browser action.",
        },
        {
          role: "user",
          content: `Goal:\n${session.task}\n\nCurrent page is blank or a new tab.\nOpen tabs:\n${tabLines}\n\nReturn exactly:\n{\n  "thought": "short reasoning",\n  "statusMessage": "very short status for the UI",\n  "action": {\n    "type": "open_url|new_tab|switch_tab|request_secret_input|finish"\n  }\n}\n\nRules:\n- Prefer open_url when the destination is obvious from the task.\n- Do not use click/type on a blank page.\n- If you need a signed-in site, still open its URL first.\n- Return JSON only.`,
        },
      ],
    })

    const rawText = sanitizeText(response.choices[0]?.message?.content)
    const parsed = toSafeJson(rawText)
    if (!parsed || !isObject(parsed.action)) {
      throw new Error("The initial browser planner returned invalid JSON.")
    }

    return {
      thought: sanitizeText(parsed.thought),
      statusMessage: sanitizeText(parsed.statusMessage) || "Opening site...",
      action: parsed.action as unknown as BrowserAgentAction,
    }
  }

  private validateAction(
    value: BrowserAgentAction,
    snapshot: BrowserSnapshot
  ): BrowserAgentAction {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("The browser planner did not return a valid action.")
    }

    const raw = value as Record<string, unknown>
    const type = sanitizeText(raw.type)
    const hasTarget = (targetId: string) =>
      snapshot.interactiveTargets.some((target) => target.targetId === targetId)

    switch (type) {
      case "open_url":
        if (!sanitizeText(raw.url)) {
          throw new Error("Browser planner returned open_url without a URL.")
        }
        return { type, url: sanitizeText(raw.url) }
      case "new_tab":
        return { type, url: sanitizeText(raw.url) || undefined }
      case "switch_tab":
        return {
          type,
          tabIndex: Math.max(0, Number(raw.tabIndex) || 0),
        }
      case "close_tab":
        return {
          type,
          tabIndex:
            raw.tabIndex === undefined ? undefined : Math.max(0, Number(raw.tabIndex) || 0),
        }
      case "click": {
        const targetId = sanitizeText(raw.targetId)
        if (!targetId || !hasTarget(targetId)) {
          throw new Error("Browser planner returned click with an unknown target.")
        }
        return { type, targetId }
      }
      case "type": {
        const targetId = sanitizeText(raw.targetId)
        const text = sanitizeText(raw.text)
        if (!targetId || !hasTarget(targetId) || !text) {
          throw new Error("Browser planner returned type with incomplete fields.")
        }
        return {
          type,
          targetId,
          text,
          submit: Boolean(raw.submit),
        }
      }
      case "press_key":
        if (!sanitizeText(raw.key)) {
          throw new Error("Browser planner returned press_key without a key.")
        }
        return { type, key: sanitizeText(raw.key) }
      case "scroll":
        return {
          type,
          direction: raw.direction === "up" ? "up" : "down",
          amount: Math.max(220, Math.min(1800, Number(raw.amount) || 680)),
        }
      case "select_option": {
        const targetId = sanitizeText(raw.targetId)
        const value = sanitizeText(raw.value)
        if (!targetId || !hasTarget(targetId) || !value) {
          throw new Error("Browser planner returned select_option with incomplete fields.")
        }
        return { type, targetId, value }
      }
      case "upload_file": {
        const targetId = sanitizeText(raw.targetId)
        const filePath = sanitizeText(raw.filePath)
        if (!targetId || !hasTarget(targetId) || !filePath) {
          throw new Error("Browser planner returned upload_file with incomplete fields.")
        }
        return { type, targetId, filePath }
      }
      case "download_file": {
        const targetId = sanitizeText(raw.targetId)
        if (!targetId || !hasTarget(targetId)) {
          throw new Error("Browser planner returned download_file with an unknown target.")
        }
        return {
          type,
          targetId,
          suggestedPath: sanitizeText(raw.suggestedPath) || undefined,
        }
      }
      case "wait_for": {
        const targetId = sanitizeText(raw.targetId)
        if (targetId && !hasTarget(targetId)) {
          throw new Error("Browser planner returned wait_for with an unknown target.")
        }
        return {
          type,
          targetId: targetId || undefined,
          timeoutMs: Math.max(600, Math.min(8000, Number(raw.timeoutMs) || 1800)),
        }
      }
      case "extract": {
        const targetId = sanitizeText(raw.targetId)
        if (targetId && !hasTarget(targetId)) {
          throw new Error("Browser planner returned extract with an unknown target.")
        }
        return {
          type,
          targetId: targetId || undefined,
          question: sanitizeText(raw.question) || undefined,
        }
      }
      case "finish": {
        const result = sanitizeText(raw.result)
        if (!result) {
          throw new Error("Browser planner returned finish without a result.")
        }
        return { type, result }
      }
      case "request_secret_input": {
        const reason =
          sanitizeText(raw.reason) ||
          "Manual secret entry is required before the browser task can continue."
        return { type, reason }
      }
      default:
        throw new Error(`Unsupported browser action: ${type || "unknown"}.`)
    }
  }

  private describeAction(action: BrowserAgentAction, snapshot: BrowserSnapshot): string {
    if (action.type === "open_url") {
      return `Opening ${action.url}`
    }
    if (action.type === "new_tab") {
      return action.url ? `Opening a new tab for ${action.url}` : "Opening a new tab"
    }
    if (action.type === "switch_tab") {
      return `Switching to tab ${action.tabIndex + 1}`
    }
    if (action.type === "close_tab") {
      return action.tabIndex !== undefined
        ? `Closing tab ${action.tabIndex + 1}`
        : "Closing the current tab"
    }
    if ("targetId" in action) {
      const target = snapshot.interactiveTargets.find(
        (candidate) => candidate.targetId === action.targetId
      )
      const label =
        target?.text || target?.label || target?.placeholder || action.targetId

      switch (action.type) {
        case "click":
          return `Clicking ${label}`
        case "type":
          return `Typing into ${label}`
        case "select_option":
          return `Selecting in ${label}`
        case "upload_file":
          return `Uploading through ${label}`
        case "download_file":
          return `Downloading from ${label}`
        case "wait_for":
          return `Waiting for ${label}`
        case "extract":
          return `Reading ${label}`
      }
    }
    if (action.type === "press_key") {
      return `Pressing ${action.key}`
    }
    if (action.type === "scroll") {
      return `Scrolling ${action.direction}`
    }
    if (action.type === "wait_for") {
      return "Waiting for the page"
    }
    if (action.type === "extract") {
      return "Reading the page"
    }
    return "Working in Chrome"
  }

  private async executeAction(
    session: ActiveComputerUseSession,
    action: BrowserAgentAction,
    snapshot: BrowserSnapshot
  ): Promise<ActionExecutionResult> {
    const page = session.page
    const browser = session.browser
    if (!page || !browser) {
      throw new Error("Browser control is not available.")
    }

    const getSelector = (targetId: string) => {
      const target = snapshot.interactiveTargets.find(
        (candidate) => candidate.targetId === targetId
      )
      if (!target) {
        throw new Error(`Target ${targetId} is no longer available on the page.`)
      }
      return target.selector
    }

    const settlePage = async () => {
      try {
        await page.waitForNavigation({
          timeout: 2500,
          waitUntil: "domcontentloaded",
        })
      } catch (_error) {
        // Ignore navigation timeouts after non-navigation actions.
      }
      await wait(400)
    }

    switch (action.type) {
      case "open_url":
        await page.bringToFront()
        await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 30000 })
        return { summary: `Opened ${action.url}.` }
      case "new_tab": {
        const nextPage = await browser.newPage()
        session.page = nextPage
        await nextPage.bringToFront()
        if (action.url) {
          await nextPage.goto(action.url, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          })
          return { summary: `Opened a new tab for ${action.url}.` }
        }
        return { summary: "Opened a new tab." }
      }
      case "switch_tab": {
        const pages = (await browser.pages()).filter((candidate) => !candidate.isClosed())
        const nextPage = pages[action.tabIndex]
        if (!nextPage) {
          throw new Error(`Tab ${action.tabIndex + 1} is not available.`)
        }
        session.page = nextPage
        await nextPage.bringToFront()
        return { summary: `Switched to tab ${action.tabIndex + 1}.` }
      }
      case "close_tab": {
        const pages = (await browser.pages()).filter((candidate) => !candidate.isClosed())
        const tabIndex =
          action.tabIndex !== undefined
            ? action.tabIndex
            : pages.findIndex((candidate) => candidate === page)
        const closingPage = pages[tabIndex]
        if (!closingPage) {
          throw new Error("The requested tab could not be closed.")
        }
        await closingPage.close()
        session.page = await this.resolveWorkingPage(browser)
        return { summary: `Closed tab ${tabIndex + 1}.` }
      }
      case "click": {
        const selector = getSelector(action.targetId)
        await page.bringToFront()
        await page.click(selector, { delay: 30 })
        await settlePage()
        return { summary: `${this.describeAction(action, snapshot)}.` }
      }
      case "type": {
        const selector = getSelector(action.targetId)
        await page.bringToFront()
        await page.click(selector, { clickCount: 3 })
        await page.keyboard.press("Backspace")
        await page.type(selector, action.text, { delay: 18 })
        if (action.submit) {
          await page.keyboard.press("Enter")
          await settlePage()
          return { summary: `${this.describeAction(action, snapshot)} and submitted.` }
        }
        return { summary: `${this.describeAction(action, snapshot)}.` }
      }
      case "press_key":
        await page.bringToFront()
        await page.keyboard.press(action.key as Parameters<typeof page.keyboard.press>[0])
        await settlePage()
        return { summary: `Pressed ${action.key}.` }
      case "scroll":
        await page.evaluate((direction, amount) => {
          window.scrollBy({
            top: direction === "up" ? -amount : amount,
            behavior: "instant",
          })
        }, action.direction, action.amount || 680)
        return { summary: `Scrolled ${action.direction}.` }
      case "select_option": {
        const selector = getSelector(action.targetId)
        await page.bringToFront()
        await page.select(selector, action.value)
        await settlePage()
        return { summary: `${this.describeAction(action, snapshot)}.` }
      }
      case "upload_file": {
        if (!fs.existsSync(action.filePath)) {
          throw new Error(`The file does not exist: ${action.filePath}`)
        }
        const selector = getSelector(action.targetId)
        const input = await page.$(selector)
        if (!input) {
          throw new Error("Upload target is no longer available.")
        }
        await (input as any).uploadFile(action.filePath)
        return { summary: `Uploaded ${path.basename(action.filePath)}.` }
      }
      case "download_file": {
        const selector = getSelector(action.targetId)
        await page.bringToFront()
        await page.click(selector, { delay: 30 })
        await settlePage()
        return { summary: "Triggered the download." }
      }
      case "wait_for": {
        if (action.targetId) {
          const selector = getSelector(action.targetId)
          await page.bringToFront()
          await page.waitForSelector(selector, {
            timeout: action.timeoutMs || 1800,
          })
          return { summary: `${this.describeAction(action, snapshot)}.` }
        }
        await wait(action.timeoutMs || 1800)
        return { summary: "Waited for the page to settle." }
      }
      case "extract": {
        let extracted = ""
        if (action.targetId) {
          const selector = getSelector(action.targetId)
          extracted = await page.$eval(
            selector,
            (element) =>
              ((element as HTMLElement).innerText ||
                element.textContent ||
                "").replace(/\s+/g, " ").trim()
          )
        } else {
          extracted = await page.evaluate(
            () => (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 500)
          )
        }

        const note = extracted.trim()
        if (!note) {
          return { summary: "Read the page, but no useful text was found." }
        }

        return {
          summary: `Read: ${note.slice(0, 240)}${note.length > 240 ? "..." : ""}`,
          extractedNote: note,
        }
      }
      case "finish":
      case "request_secret_input":
        throw new Error(`Action ${action.type} should not be executed directly.`)
    }
  }
}

export { COMPUTER_USE_STATE_EVENT }
