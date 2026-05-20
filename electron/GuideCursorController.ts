import { BrowserWindow, app, desktopCapturer, screen } from "electron"
import { execFile } from "child_process"
import fs from "fs"
import path from "path"
import { OpenAI } from "openai"
import { configHelper } from "./ConfigHelper"

const GUIDE_WIDTH = 340
const GUIDE_HEIGHT = 180
const CURSOR_OFFSET_X = 16
const CURSOR_OFFSET_Y = 12
const FOLLOW_INTERVAL_MS = 24
const SELECTION_POLL_INTERVAL_MS = 900
const SELECTION_STABLE_MS = 650
const MIN_AUTO_SELECTION_LENGTH = 2
const MAX_AUTO_SELECTION_LENGTH = 1800
const GUIDE_SHORTCUT_LONG_PRESS_MS = 560
const RESULT_VISIBLE_MS = 14000
const GUIDE_MODEL = process.env.OPENAI_GUIDE_MODEL?.trim() || "gpt-4o-mini"
const isDev = process.env.NODE_ENV === "development"
const WINDOWS_SELECTION_SCRIPT = `
$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
$focused = [System.Windows.Automation.AutomationElement]::FocusedElement
if ($null -eq $focused) { exit 0 }
$pattern = $null
try {
  $pattern = $focused.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
} catch {
  exit 0
}
if ($null -eq $pattern) { exit 0 }
$ranges = $pattern.GetSelection()
if ($null -eq $ranges -or $ranges.Length -eq 0) { exit 0 }
$parts = @()
foreach ($range in $ranges) {
  $value = $range.GetText(4096)
  if ($value) { $parts += $value }
}
($parts -join [Environment]::NewLine).Trim()
`
const WINDOWS_CTRL_SPACE_DOWN_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class SylicaKeys {
  [DllImport("user32.dll")]
  public static extern short GetAsyncKeyState(int vKey);
}
"@
$ctrl = ([SylicaKeys]::GetAsyncKeyState(0x11) -band 0x8000) -ne 0
$space = ([SylicaKeys]::GetAsyncKeyState(0x20) -band 0x8000) -ne 0
if ($ctrl -and $space) { "1" } else { "0" }
`

type GuideStatus = "idle" | "thinking" | "answer" | "error"

interface GuideState {
  status: GuideStatus
  text: string
  label?: string
}

export class GuideCursorController {
  private window: BrowserWindow | null = null
  private followTimer: ReturnType<typeof setInterval> | null = null
  private selectionTimer: ReturnType<typeof setInterval> | null = null
  private hideResultTimer: ReturnType<typeof setTimeout> | null = null
  private isExplaining = false
  private isReadingSelection = false
  private shortcutTimer: ReturnType<typeof setTimeout> | null = null
  private lastShortcutActionAt = 0
  private isGuideVoiceActive = false
  private isReady = false
  private enabled = true
  private pendingState: GuideState | null = null
  private lastObservedSelection = ""
  private lastObservedSelectionAt = 0
  private lastExplainedSelection = ""

  public start(): void {
    if (!this.enabled) {
      return
    }

    if (this.window && !this.window.isDestroyed()) {
      return
    }

    this.isReady = false
    this.pendingState = null

    this.window = new BrowserWindow({
      width: GUIDE_WIDTH,
      height: GUIDE_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      hasShadow: false,
      backgroundColor: "#00000000",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
        preload: isDev
          ? path.join(__dirname, "../dist-electron/preload.js")
          : path.join(__dirname, "preload.js"),
      },
    })

    this.window.setIgnoreMouseEvents(true, { forward: true })
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    this.applyScreenRecordingVisibility()
    this.configureMediaPermissions(this.window)
    this.window.loadFile(this.writeGuideHtml())
    this.window.once("ready-to-show", () => {
      this.isReady = true
      this.updateState(this.pendingState || { status: "idle", text: "" })
      this.pendingState = null
      this.startFollowingCursor()
      this.startSelectionWatcher()
    })

    this.window.on("closed", () => {
      this.isReady = false
      this.pendingState = null
      this.stopFollowingCursor()
      this.window = null
    })
  }

  public applyScreenRecordingVisibility(): void {
    if (!this.window || this.window.isDestroyed()) return
    const visible = configHelper.isScreenRecordingVisible()
    try {
      this.window.setContentProtection(!visible)
    } catch (error) {
      console.warn("cursor setContentProtection failed:", error)
    }
    this.window.setAlwaysOnTop(true, visible ? "floating" : "screen-saver", 1)
  }

  public stop(): void {
    this.clearShortcutTimer()
    this.stopGuideVoice()
    this.stopFollowingCursor()
    this.stopSelectionWatcher()
    if (this.window && !this.window.isDestroyed()) {
      this.window.close()
    }
    this.window = null
  }

  public isEnabled(): boolean {
    return this.enabled
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (enabled) {
      this.start()
      return
    }

    this.resetSelectionTracking()
    this.stop()
  }

  public async explainHoveredText(): Promise<void> {
    if (!this.enabled) {
      return
    }

    if (this.isExplaining) {
      return
    }

    this.start()
    this.isExplaining = true
    this.clearResultTimer()

    try {
      const apiKey = configHelper.getConfiguredApiKey("openai")
      if (!apiKey) {
        throw new Error("OpenAI API key is not configured.")
      }

      // Keep the guide bubble/dot out of the captured crop so it does not explain itself.
      this.updateState({ status: "idle", text: "", label: "__hidden" })
      await new Promise((resolve) => setTimeout(resolve, 70))
      const imageUrl = await this.captureCursorContext()
      this.updateState({ status: "thinking", text: "Reading what you are hovering..." })
      const openai = new OpenAI({ apiKey })
      const response = await openai.chat.completions.create({
        model: GUIDE_MODEL,
        max_completion_tokens: 180,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You are Sylica Guide, a tiny always-on cursor assistant. Explain only the text, UI label, error, or concept near the cursor. Be direct, useful, and compact. If the crop contains no readable text, say what is visible and what it likely means. Never mention screenshots.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "Explain the hovered content in 1-3 short sentences. If it looks like a button, error, form field, code, math, or setting, explain what the user should understand or do next.",
              },
              {
                type: "image_url",
                image_url: {
                  url: imageUrl,
                  detail: "high",
                },
              },
            ],
          },
        ],
      })

      const text =
        response.choices[0]?.message?.content?.trim() ||
        "I could not read enough content there. Hover over the text and press Ctrl+Space again."

      this.updateState({ status: "answer", text })
      this.hideResultTimer = setTimeout(() => {
        this.updateState({ status: "idle", text: "" })
      }, RESULT_VISIBLE_MS)
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not explain the hovered content."
      this.updateState({ status: "error", text: message })
      this.hideResultTimer = setTimeout(() => {
        this.updateState({ status: "idle", text: "" })
      }, 7000)
    } finally {
      this.isExplaining = false
    }
  }

  public async handleGuideShortcutPress(): Promise<void> {
    if (!this.enabled) {
      return
    }

    if (this.shortcutTimer || Date.now() - this.lastShortcutActionAt < 900) {
      return
    }

    await new Promise<void>((resolve) => {
      this.shortcutTimer = setTimeout(async () => {
        this.shortcutTimer = null
        this.lastShortcutActionAt = Date.now()

        try {
          const isLongPress = await this.isCtrlSpaceStillPressed()
          if (isLongPress) {
            // Long press → explain hovered text
            await this.explainHoveredText()
            resolve()
            return
          }
        } catch (_error) {
          // If key-state probing fails, fall through to voice toggle.
        }

        // Short press → toggle voice on/off
        if (this.isGuideVoiceActive) {
          this.stopGuideVoice()
          this.updateState({
            status: "answer",
            label: "Cursor Voice",
            text: "Cursor voice stopped.",
          })
          this.hideResultTimer = setTimeout(() => {
            this.updateState({ status: "idle", text: "" })
          }, 3000)
        } else {
          await this.toggleGuideVoice()
        }
        resolve()
      }, GUIDE_SHORTCUT_LONG_PRESS_MS)
    })
  }

  private async explainSelectedText(selectedText: string): Promise<void> {
    if (!this.enabled || this.isExplaining) {
      return
    }

    this.start()
    this.isExplaining = true
    this.clearResultTimer()

    try {
      const apiKey = configHelper.getConfiguredApiKey("openai")
      if (!apiKey) {
        throw new Error("OpenAI API key is not configured.")
      }

      this.updateState({ status: "idle", text: "", label: "__hidden" })
      await new Promise((resolve) => setTimeout(resolve, 70))
      const screenContextUrl = await this.captureDisplayContext()
      this.updateState({ status: "thinking", text: "Explaining selected text..." })

      const openai = new OpenAI({ apiKey })
      const response = await openai.chat.completions.create({
        model: GUIDE_MODEL,
        max_completion_tokens: 220,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You are Sylica Guide, a tiny always-on cursor assistant. The user has highlighted text. Use the full-screen image only as context, but explain only the highlighted/selected text. Be direct, compact, and useful. Do not describe unrelated screen content unless it changes the meaning of the selected text.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Explain only this selected text in 1-3 short sentences:\n\n${selectedText}`,
              },
              {
                type: "image_url",
                image_url: {
                  url: screenContextUrl,
                  detail: "high",
                },
              },
            ],
          },
        ],
      })

      const text =
        response.choices[0]?.message?.content?.trim() ||
        "I could not explain that selection."

      this.updateState({ status: "answer", text })
      this.hideResultTimer = setTimeout(() => {
        this.updateState({ status: "idle", text: "" })
      }, RESULT_VISIBLE_MS)
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not explain the selected text."
      this.updateState({ status: "error", text: message })
      this.hideResultTimer = setTimeout(() => {
        this.updateState({ status: "idle", text: "" })
      }, 7000)
    } finally {
      this.isExplaining = false
    }
  }

  private startFollowingCursor(): void {
    this.stopFollowingCursor()
    this.followTimer = setInterval(() => this.positionNearCursor(), FOLLOW_INTERVAL_MS)
    this.positionNearCursor()
  }

  private stopFollowingCursor(): void {
    if (this.followTimer) {
      clearInterval(this.followTimer)
      this.followTimer = null
    }
    this.clearResultTimer()
  }

  private startSelectionWatcher(): void {
    if (process.platform !== "win32" || this.selectionTimer) {
      return
    }

    this.selectionTimer = setInterval(() => {
      void this.checkHighlightedText()
    }, SELECTION_POLL_INTERVAL_MS)
  }

  private stopSelectionWatcher(): void {
    if (this.selectionTimer) {
      clearInterval(this.selectionTimer)
      this.selectionTimer = null
    }
    this.resetSelectionTracking()
  }

  private clearShortcutTimer(): void {
    if (this.shortcutTimer) {
      clearTimeout(this.shortcutTimer)
      this.shortcutTimer = null
    }
  }

  private resetSelectionTracking(): void {
    this.lastObservedSelection = ""
    this.lastObservedSelectionAt = 0
    this.lastExplainedSelection = ""
  }

  private async checkHighlightedText(): Promise<void> {
    if (!this.enabled || this.isReadingSelection || this.isExplaining) {
      return
    }

    this.isReadingSelection = true
    try {
      const selection = this.normalizeSelectionText(
        await this.readWindowsSelectedText()
      )

      if (selection.length < MIN_AUTO_SELECTION_LENGTH) {
        this.lastObservedSelection = ""
        this.lastObservedSelectionAt = 0
        return
      }

      if (selection !== this.lastObservedSelection) {
        this.lastObservedSelection = selection
        this.lastObservedSelectionAt = Date.now()
        return
      }

      if (
        Date.now() - this.lastObservedSelectionAt < SELECTION_STABLE_MS ||
        selection === this.lastExplainedSelection
      ) {
        return
      }

      this.lastExplainedSelection = selection
      await this.explainSelectedText(selection)
    } catch (_error) {
      // Some apps do not expose selected text through Windows UI Automation.
      // Ignore unsupported focus targets and keep watching.
    } finally {
      this.isReadingSelection = false
    }
  }

  private normalizeSelectionText(value: string): string {
    return value
      .replace(/\u0000/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+/g, " ")
      .trim()
      .slice(0, MAX_AUTO_SELECTION_LENGTH)
  }

  private readWindowsSelectedText(): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          WINDOWS_SELECTION_SCRIPT,
        ],
        {
          windowsHide: true,
          timeout: 2200,
          maxBuffer: 64 * 1024,
        },
        (error, stdout) => {
          if (error) {
            reject(error)
            return
          }

          resolve(stdout || "")
        }
      )
    })
  }

  private isCtrlSpaceStillPressed(): Promise<boolean> {
    if (process.platform !== "win32") {
      return Promise.resolve(false)
    }

    return new Promise((resolve) => {
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          WINDOWS_CTRL_SPACE_DOWN_SCRIPT,
        ],
        {
          windowsHide: true,
          timeout: 1400,
          maxBuffer: 8 * 1024,
        },
        (_error, stdout) => {
          resolve(String(stdout || "").trim() === "1")
        }
      )
    })
  }

  private async toggleGuideVoice(): Promise<void> {
    this.start()

    if (!this.window || this.window.isDestroyed()) {
      return
    }

    this.updateState({
      status: "thinking",
      label: "Cursor Voice",
      text: this.isGuideVoiceActive
        ? "Stopping cursor voice..."
        : "Starting cursor voice...",
    })

    try {
      const result = await this.window.webContents.executeJavaScript(
        "window.__toggleGuideVoice && window.__toggleGuideVoice()"
      )
      this.isGuideVoiceActive = Boolean(result?.active)
    } catch (error) {
      this.isGuideVoiceActive = false
      this.updateState({
        status: "error",
        label: "Cursor Voice",
        text:
          error instanceof Error
            ? error.message
            : "Could not start cursor voice.",
      })
    }
  }

  private stopGuideVoice(): void {
    this.isGuideVoiceActive = false

    if (!this.window || this.window.isDestroyed()) {
      return
    }

    this.window.webContents
      .executeJavaScript("window.__stopGuideVoice && window.__stopGuideVoice(false)")
      .catch(() => undefined)
  }

  private configureMediaPermissions(windowRef: BrowserWindow): void {
    const windowSession = windowRef.webContents.session

    windowSession.setPermissionCheckHandler((_webContents, permission) => {
      const requestedPermission = String(permission)
      return requestedPermission === "media" || requestedPermission === "display-capture"
    })

    windowSession.setPermissionRequestHandler(
      (_webContents, permission, callback) => {
        const requestedPermission = String(permission)
        callback(requestedPermission === "media" || requestedPermission === "display-capture")
      }
    )
  }

  private writeGuideHtml(): string {
    const guideDir = path.join(app.getPath("userData"), "guide-cursor")
    const guideHtmlPath = path.join(guideDir, "index.html")

    fs.mkdirSync(guideDir, { recursive: true })
    fs.writeFileSync(guideHtmlPath, this.renderHtml(), "utf8")

    return guideHtmlPath
  }

  private clearResultTimer(): void {
    if (this.hideResultTimer) {
      clearTimeout(this.hideResultTimer)
      this.hideResultTimer = null
    }
  }

  private positionNearCursor(): void {
    if (!this.window || this.window.isDestroyed()) {
      return
    }

    const point = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(point)
    const bounds = display.bounds
    const x = Math.min(
      bounds.x + bounds.width - GUIDE_WIDTH,
      Math.max(bounds.x, point.x + CURSOR_OFFSET_X)
    )
    const y = Math.min(
      bounds.y + bounds.height - GUIDE_HEIGHT,
      Math.max(bounds.y, point.y + CURSOR_OFFSET_Y)
    )

    this.window.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: GUIDE_WIDTH,
      height: GUIDE_HEIGHT,
    })
  }

  private updateState(state: GuideState): void {
    if (!this.window || this.window.isDestroyed()) {
      return
    }

    if (!this.isReady) {
      this.pendingState = state
      return
    }

    this.updateGuideWindowVisibility(state)
    this.window.webContents.executeJavaScript(
      `window.__setGuideState(${JSON.stringify(state)})`
    ).catch(() => undefined)
  }

  private updateGuideWindowVisibility(state: GuideState): void {
    if (!this.window || this.window.isDestroyed()) {
      return
    }

    const shouldShow =
      state.label !== "__hidden" &&
      (state.status === "idle" ||
      state.status === "thinking" ||
      state.status === "answer" ||
      state.status === "error" ||
      this.isGuideVoiceActive)

    if (shouldShow) {
      this.positionNearCursor()
      if (!this.window.isVisible()) {
        this.window.showInactive()
      }
      return
    }

    if (this.window.isVisible()) {
      this.window.hide()
    }
  }

  private async captureCursorContext(): Promise<string> {
    const point = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(point)
    const scaleFactor = display.scaleFactor || 1
    const thumbnailSize = {
      width: Math.round(display.bounds.width * scaleFactor),
      height: Math.round(display.bounds.height * scaleFactor),
    }
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize,
    })
    const source =
      sources.find((candidate) => candidate.display_id === String(display.id)) ||
      sources[0]

    if (!source || source.thumbnail.isEmpty()) {
      throw new Error("Could not capture the screen near the cursor.")
    }

    const relativeX = (point.x - display.bounds.x) * scaleFactor
    const relativeY = (point.y - display.bounds.y) * scaleFactor
    const cropWidth = Math.min(thumbnailSize.width, Math.round(760 * scaleFactor))
    const cropHeight = Math.min(thumbnailSize.height, Math.round(420 * scaleFactor))
    const cropX = Math.max(0, Math.min(thumbnailSize.width - cropWidth, relativeX - cropWidth * 0.38))
    const cropY = Math.max(0, Math.min(thumbnailSize.height - cropHeight, relativeY - cropHeight * 0.42))
    const cropped = source.thumbnail.crop({
      x: Math.round(cropX),
      y: Math.round(cropY),
      width: cropWidth,
      height: cropHeight,
    })

    return `data:image/png;base64,${cropped.toPNG().toString("base64")}`
  }

  private async captureDisplayContext(): Promise<string> {
    const point = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(point)
    const scaleFactor = display.scaleFactor || 1
    const maxWidth = 1600
    const width = Math.min(
      Math.round(display.bounds.width * scaleFactor),
      maxWidth
    )
    const height = Math.round(width * (display.bounds.height / display.bounds.width))
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width,
        height,
      },
    })
    const source =
      sources.find((candidate) => candidate.display_id === String(display.id)) ||
      sources[0]

    if (!source || source.thumbnail.isEmpty()) {
      throw new Error("Could not capture the screen context.")
    }

    return `data:image/png;base64,${source.thumbnail.toPNG().toString("base64")}`
  }

  private renderHtml(): string {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html, body {
      margin: 0;
      width: 100%;
      height: 100%;
      background: transparent;
      overflow: hidden;
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: white;
      user-select: none;
    }
    .wrap {
      position: relative;
      width: 100%;
      height: 100%;
      pointer-events: none;
    }
    .cursor {
      position: absolute;
      left: 7px;
      top: 7px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: radial-gradient(circle at 35% 35%, #ffffff 0 18%, #8fffe0 19% 48%, #6d58ff 49% 100%);
      border: 1px solid rgba(255, 255, 255, 0.78);
      box-shadow:
        0 0 0 1px rgba(5, 8, 16, 0.65),
        0 0 14px rgba(110, 94, 255, 0.7),
        0 0 5px rgba(125, 249, 199, 0.62);
      opacity: 0.92;
      transform: scale(1);
      transition: opacity 200ms ease, transform 200ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    .cursor.thinking {
      animation: cursor-pulse 1.5s ease-in-out infinite;
    }
    .cursor::after {
      content: "";
      position: absolute;
      inset: -4px;
      border: 1px solid rgba(125, 249, 199, 0.24);
      border-radius: inherit;
      opacity: 0.95;
    }
    @keyframes cursor-pulse {
      0%, 100% { transform: scale(1); opacity: 0.9; }
      50% { transform: scale(1.15); opacity: 0.6; }
    }
    .bubble {
      position: absolute;
      left: 32px;
      top: 0;
      max-width: 280px;
      min-width: 160px;
      border: 1px solid rgba(255,255,255,.06);
      border-radius: 12px;
      padding: 10px 12px;
      background: rgba(12, 14, 18, .92);
      box-shadow: 0 8px 32px rgba(0,0,0,.35);
      backdrop-filter: blur(20px);
      opacity: 0;
      transform: translateX(-8px) scale(0.96);
      transition: opacity 250ms cubic-bezier(0.22, 1, 0.36, 1), 
                  transform 250ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    .bubble.show {
      opacity: 1;
      transform: translateX(0) scale(1);
    }
    .label {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 6px;
      font-size: 10px;
      font-weight: 500;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: rgba(255,255,255,.45);
    }
    .dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.7);
    }
    .thinking .dot {
      animation: dot-pulse 1.2s ease-in-out infinite;
    }
    .text {
      font-size: 12px;
      line-height: 1.5;
      color: rgba(255,255,255,.9);
      white-space: pre-wrap;
      max-height: 120px;
      overflow-y: auto;
      scrollbar-width: none;
      -ms-overflow-style: none;
    }
    .text::-webkit-scrollbar {
      display: none;
    }
    .error .text {
      color: #ff9a9a;
    }
    @keyframes dot-pulse {
      0%, 100% { opacity: 0.4; transform: scale(0.8); }
      50% { opacity: 1; transform: scale(1.2); }
    }
    .voice-hint {
      display: none;
      margin-top: 8px;
      font-size: 9px;
      color: rgba(255, 255, 255, 0.38);
      pointer-events: none;
    }
    .voice-hint.show {
      display: block;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div id="cursor" class="cursor"></div>
    <div id="bubble" class="bubble">
      <div id="label" class="label"><span class="dot"></span><span id="labelText">Guide</span></div>
      <div id="text" class="text"></div>
      <div id="voiceHint" class="voice-hint">ctrl + space to stop voice</div>
    </div>
  </div>
  <script>
    const bubble = document.getElementById("bubble");
    const label = document.getElementById("label");
    const labelText = document.getElementById("labelText");
    const text = document.getElementById("text");
    const VOICE_AUDIO_SAMPLE_RATE = 24000;
    const VOICE_INSTRUCTIONS = [
      "You are Sylica Cursor Voice, a fast realtime AI companion attached to the user's cursor.",
      "Talk naturally and answer directly. Be concise unless the user asks for depth.",
      "You can use the current screen context when relevant, but do not mention screenshots.",
      "If the user asks about something on screen, inspect the screen context and explain the most likely target.",
      "Be helpful, calm, and practical."
    ].join(" ");
    let voiceState = {
      active: false,
      starting: false,
      stream: null,
      audioContext: null,
      sourceNode: null,
      processorNode: null,
      sinkNode: null,
      playbackContext: null,
      playbackTime: 0,
      playbackSources: [],
      unsubscribe: null,
      assistantText: "",
      userText: ""
    };

    const cursor = document.getElementById("cursor");
    const voiceHint = document.getElementById("voiceHint");

    function setVoiceHintVisible(visible) {
      if (voiceHint) {
        voiceHint.classList.toggle("show", visible);
      }
    }

    window.__setGuideState = (state) => {
      const status = state?.status || "idle";
      bubble.className = "bubble";
      label.className = "label";
      cursor.className = "cursor";
      labelText.textContent = state?.label || "Guide";

      if (status !== "idle") {
        bubble.classList.add("show", status);
      }
      if (status === "thinking") {
        label.classList.add("thinking");
        cursor.classList.add("thinking");
      }
      text.textContent = state?.text || "";
      // Auto-scroll to bottom so newest text is always visible
      text.scrollTop = text.scrollHeight;
    };

    function setGuideVoiceState(status, message) {
      window.__setGuideState({
        status,
        label: "Cursor Voice",
        text: message
      });
    }

    function float32ToInt16(samples) {
      const pcm = new Int16Array(samples.length);
      for (let index = 0; index < samples.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, samples[index]));
        pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      return pcm;
    }

    function resampleAudio(samples, sourceRate) {
      if (sourceRate === VOICE_AUDIO_SAMPLE_RATE) {
        return samples;
      }

      const ratio = sourceRate / VOICE_AUDIO_SAMPLE_RATE;
      const nextLength = Math.max(1, Math.round(samples.length / ratio));
      const result = new Float32Array(nextLength);
      let sourceIndex = 0;

      for (let index = 0; index < nextLength; index += 1) {
        const nextSourceIndex = Math.min(
          samples.length,
          Math.round((index + 1) * ratio)
        );
        let accumulator = 0;
        let count = 0;

        while (sourceIndex < nextSourceIndex) {
          accumulator += samples[sourceIndex];
          sourceIndex += 1;
          count += 1;
        }

        result[index] = count > 0 ? accumulator / count : 0;
      }

      return result;
    }

    function arrayBufferToBase64(buffer) {
      return new Promise((resolve) => {
        const blob = new Blob([buffer], { type: "application/octet-stream" });
        const reader = new FileReader();
        reader.onloadend = () => {
          const value = String(reader.result || "");
          resolve(value.includes(",") ? value.split(",")[1] : value);
        };
        reader.readAsDataURL(blob);
      });
    }

    function base64ToBytes(base64) {
      const binary = window.atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return bytes;
    }

    function clearVoicePlayback() {
      voiceState.playbackSources.forEach((source) => {
        try {
          source.stop();
        } catch (_error) {
          // Source may already be stopped.
        }
      });
      voiceState.playbackSources = [];
      voiceState.playbackTime = voiceState.playbackContext
        ? voiceState.playbackContext.currentTime
        : 0;
    }

    function closeVoicePlayback() {
      clearVoicePlayback();
      if (voiceState.playbackContext) {
        voiceState.playbackContext.close().catch(() => undefined);
        voiceState.playbackContext = null;
      }
      voiceState.playbackTime = 0;
    }

    async function playVoiceAudioDelta(audioBase64) {
      const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextConstructor) {
        return;
      }

      if (!voiceState.playbackContext) {
        voiceState.playbackContext = new AudioContextConstructor({
          sampleRate: VOICE_AUDIO_SAMPLE_RATE
        });
      }

      const audioContext = voiceState.playbackContext;
      await audioContext.resume();
      const bytes = base64ToBytes(audioBase64);
      const pcm = new Int16Array(
        bytes.buffer,
        bytes.byteOffset,
        Math.floor(bytes.byteLength / 2)
      );
      const audioBuffer = audioContext.createBuffer(
        1,
        pcm.length,
        VOICE_AUDIO_SAMPLE_RATE
      );
      const channelData = audioBuffer.getChannelData(0);
      for (let index = 0; index < pcm.length; index += 1) {
        channelData[index] = Math.max(-1, Math.min(1, pcm[index] / 32768));
      }

      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContext.destination);
      voiceState.playbackSources.push(source);
      const now = audioContext.currentTime;
      const startAt = Math.max(now, voiceState.playbackTime || now);
      voiceState.playbackTime = startAt + audioBuffer.duration;
      source.onended = () => {
        voiceState.playbackSources = voiceState.playbackSources.filter(
          (candidate) => candidate !== source
        );
      };
      source.start(startAt);
    }

    function cleanupGuideVoice(showMessage) {
      setVoiceHintVisible(false);
      if (voiceState.unsubscribe) {
        voiceState.unsubscribe();
      }
      if (voiceState.processorNode) {
        voiceState.processorNode.onaudioprocess = null;
        try { voiceState.processorNode.disconnect(); } catch (_error) {}
      }
      if (voiceState.sourceNode) {
        try { voiceState.sourceNode.disconnect(); } catch (_error) {}
      }
      if (voiceState.sinkNode) {
        try { voiceState.sinkNode.disconnect(); } catch (_error) {}
      }
      if (voiceState.audioContext) {
        voiceState.audioContext.close().catch(() => undefined);
      }
      if (voiceState.stream) {
        voiceState.stream.getTracks().forEach((track) => track.stop());
      }
      closeVoicePlayback();
      voiceState = {
        active: false,
        starting: false,
        stream: null,
        audioContext: null,
        sourceNode: null,
        processorNode: null,
        sinkNode: null,
        playbackContext: null,
        playbackTime: 0,
        playbackSources: [],
        unsubscribe: null,
        assistantText: "",
        userText: ""
      };
      if (showMessage) {
        setGuideVoiceState("answer", "Cursor voice stopped.");
      }
    }

    function handleGuideVoiceEvent(event) {
      if (!voiceState.active && event.type !== "error") {
        return;
      }

      if (event.type === "ready") {
        setGuideVoiceState("answer", "Listening. Talk to the cursor.");
        return;
      }

      if (event.type === "speech_started") {
        clearVoicePlayback();
        voiceState.userText = "";
        voiceState.assistantText = "";
        setGuideVoiceState("thinking", "Listening...");
        return;
      }

      if (event.type === "speech_stopped") {
        setGuideVoiceState("thinking", "Thinking...");
        return;
      }

      if (event.type === "input_transcript_delta") {
        voiceState.userText += event.delta || "";
        setGuideVoiceState("thinking", "You: " + voiceState.userText);
        return;
      }

      if (event.type === "input_transcript") {
        voiceState.userText = event.transcript || voiceState.userText;
        setGuideVoiceState("thinking", "You: " + voiceState.userText);
        return;
      }

      if (event.type === "text_delta") {
        voiceState.assistantText += event.text || "";
        setGuideVoiceState("answer", voiceState.assistantText || "Speaking...");
        return;
      }

      if (event.type === "audio_delta") {
        playVoiceAudioDelta(event.audio).catch(() => undefined);
        return;
      }

      if (event.type === "response_done") {
        setGuideVoiceState(
          "answer",
          voiceState.assistantText || "Listening. Talk to the cursor."
        );
        return;
      }

      if (event.type === "error") {
        cleanupGuideVoice(false);
        setGuideVoiceState("error", event.error || "Cursor voice failed.");
      }
    }

    async function startGuideVoice() {
      if (voiceState.active || voiceState.starting) {
        return { active: true };
      }

      if (!window.electronAPI?.startVoiceRealtime) {
        throw new Error("Realtime voice is not available in this window.");
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone capture is not available here.");
      }

      const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextConstructor) {
        throw new Error("Voice audio processing is not supported here.");
      }

      voiceState.starting = true;
      setGuideVoiceState("thinking", "Opening microphone...");

      try {
        voiceState.unsubscribe = window.electronAPI.onVoiceRealtimeEvent(
          handleGuideVoiceEvent
        );
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
        const startResponse = await window.electronAPI.startVoiceRealtime({
          instructions: VOICE_INSTRUCTIONS,
          voice: "marin"
        });

        if (!startResponse.success) {
          throw new Error(startResponse.error || "Failed to start cursor voice.");
        }

        const audioContext = new AudioContextConstructor({
          sampleRate: VOICE_AUDIO_SAMPLE_RATE
        });
        const sourceNode = audioContext.createMediaStreamSource(stream);
        const processorNode = audioContext.createScriptProcessor(4096, 1, 1);
        const sinkNode = audioContext.createGain();
        sinkNode.gain.value = 0;

        processorNode.onaudioprocess = (event) => {
          if (!voiceState.active) {
            return;
          }

          const inputBuffer = event.inputBuffer;
          const frameCount = inputBuffer.length;
          const monoSamples = new Float32Array(frameCount);
          const channelCount = inputBuffer.numberOfChannels;
          if (channelCount === 0) {
            return;
          }

          for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
            const channelData = inputBuffer.getChannelData(channelIndex);
            for (let sampleIndex = 0; sampleIndex < frameCount; sampleIndex += 1) {
              monoSamples[sampleIndex] += channelData[sampleIndex] / channelCount;
            }
          }

          const resampledSamples = resampleAudio(
            monoSamples,
            audioContext.sampleRate
          );
          const pcmChunk = float32ToInt16(resampledSamples);
          const pcmBuffer = pcmChunk.buffer.slice(
            pcmChunk.byteOffset,
            pcmChunk.byteOffset + pcmChunk.byteLength
          );

          arrayBufferToBase64(pcmBuffer).then((audioBase64) => {
            if (!voiceState.active) {
              return;
            }
            window.electronAPI
              .appendVoiceRealtimeAudio({ audioBase64 })
              .catch(() => undefined);
          });
        };

        sourceNode.connect(processorNode);
        processorNode.connect(sinkNode);
        sinkNode.connect(audioContext.destination);
        await audioContext.resume();

        voiceState.active = true;
        voiceState.starting = false;
        voiceState.stream = stream;
        voiceState.audioContext = audioContext;
        voiceState.sourceNode = sourceNode;
        voiceState.processorNode = processorNode;
        voiceState.sinkNode = sinkNode;
        setVoiceHintVisible(true);
        setGuideVoiceState(
          "answer",
          "Cursor voice is live. Talk naturally."
        );
        return { active: true };
      } catch (error) {
        cleanupGuideVoice(false);
        setGuideVoiceState(
          "error",
          error instanceof Error ? error.message : "Could not start cursor voice."
        );
        return { active: false };
      }
    }

    window.__stopGuideVoice = async (showMessage = true) => {
      const wasActive = voiceState.active || voiceState.starting;
      cleanupGuideVoice(showMessage && wasActive);
      if (window.electronAPI?.stopVoiceRealtime) {
        await window.electronAPI.stopVoiceRealtime().catch(() => undefined);
      }
      return { active: false };
    };

    window.__toggleGuideVoice = async () => {
      if (voiceState.active || voiceState.starting) {
        return window.__stopGuideVoice(true);
      }
      return startGuideVoice();
    };

    window.addEventListener("beforeunload", () => {
      window.__stopGuideVoice(false);
    });
  </script>
</body>
</html>`
  }
}
