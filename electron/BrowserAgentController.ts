import { execFile, spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import Anthropic from "@anthropic-ai/sdk"
import { OpenAI } from "openai"
import { app, desktopCapturer, screen, shell, type BrowserWindow } from "electron"
import type { Browser, Page } from "puppeteer-core"
import { backendClient } from "./BackendClient"
import { configHelper } from "./ConfigHelper"
import { buildExaSearchContext, isExaConfigured } from "./ExaSearchHelper"
import { buildLocalFileSearchContext } from "./FileSearchHelper"
import type {
  BrowserAgentAction,
  ChatThreadSummary,
  ComputerUseResumeData,
  ComputerUseStartData,
  ComputerUseState,
} from "../shared/followUpChat"
import type { LocalPhoneRemoteInputPayload } from "../shared/localPhoneRelay"
import { EMPTY_COMPUTER_USE_STATE } from "../shared/followUpChat"

const execFileAsync = promisify(execFile)

const COMPUTER_USE_STATE_EVENT = "computer-use-state"
const COMPUTER_USE_MODEL =
  (process.env.COMPUTER_USE_MODEL || process.env.OPENAI_COMPUTER_USE_MODEL || "").trim() ||
  "claude-opus-4-7-20250819"
const COMPUTER_USE_REASONING_EFFORT =
  (process.env.OPENAI_COMPUTER_USE_REASONING_EFFORT || "").trim() || "high"
const COMPUTER_USE_THINKING_BUDGET = (() => {
  const raw = parseInt(process.env.ANTHROPIC_COMPUTER_USE_THINKING_BUDGET || "", 10)
  return Number.isFinite(raw) && raw >= 1024 ? raw : 8000
})()
const COMPUTER_USE_FALLBACK_MODELS = [
  "claude-opus-4-5-20250929",
  "claude-sonnet-4-5-20250929",
  "claude-3-7-sonnet-latest",
  "gpt-5",
  "gpt-5-mini",
  "gpt-4.1",
]
type ComputerUseProvider = "openai" | "anthropic"
function inferProvider(model: string): ComputerUseProvider {
  return /^claude/i.test(model.trim()) ? "anthropic" : "openai"
}
const CHROME_DEBUGGING_PORT = 9227
const MAX_AGENT_STEPS = 60
const MAX_INTERACTIVE_TARGETS = 60
const SNAPSHOT_TEXT_LIMIT = 4800
const STEP_SETTLE_DELAY_MS = 600
const MAX_SYSTEM_AGENT_STEPS = 80
const MAX_SYSTEM_OUTPUT_CHARS = 16000
const MAX_SYSTEM_FILE_READ_BYTES = 4 * 1024 * 1024
const MAX_SYSTEM_FILE_WRITE_BYTES = 16 * 1024 * 1024
const SYSTEM_COMMAND_TIMEOUT_MS = 600_000
const SYSTEM_HISTORY_RETAIN = 24
const MAX_CONSECUTIVE_ACTION_ERRORS = 6
const INPUT_COMMAND_TIMEOUT_MS = 20_000

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

const WIN_INPUT_PRELUDE = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
if (-not ('SylicaInput' -as [type])) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class SylicaInput {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;
    public const uint MOUSEEVENTF_HWHEEL = 0x01000;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }
}
"@
}
[SylicaInput]::SetProcessDPIAware() | Out-Null

function Sylica-MouseMove([int]$X, [int]$Y) {
  [SylicaInput]::SetCursorPos($X, $Y) | Out-Null
}
function Sylica-MouseClick([int]$X = -1, [int]$Y = -1, [string]$Button = 'left', [int]$Times = 1) {
  if ($X -ge 0 -and $Y -ge 0) {
    [SylicaInput]::SetCursorPos($X, $Y) | Out-Null
    Start-Sleep -Milliseconds 60
  }
  $down = [SylicaInput]::MOUSEEVENTF_LEFTDOWN; $up = [SylicaInput]::MOUSEEVENTF_LEFTUP
  switch ($Button) {
    'right'  { $down = [SylicaInput]::MOUSEEVENTF_RIGHTDOWN;  $up = [SylicaInput]::MOUSEEVENTF_RIGHTUP }
    'middle' { $down = [SylicaInput]::MOUSEEVENTF_MIDDLEDOWN; $up = [SylicaInput]::MOUSEEVENTF_MIDDLEUP }
  }
  for ($i = 0; $i -lt $Times; $i++) {
    [SylicaInput]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 30
    [SylicaInput]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
    if ($i -lt ($Times - 1)) { Start-Sleep -Milliseconds 60 }
  }
}
function Sylica-MouseDrag([int]$FromX, [int]$FromY, [int]$ToX, [int]$ToY, [string]$Button = 'left') {
  [SylicaInput]::SetCursorPos($FromX, $FromY) | Out-Null
  Start-Sleep -Milliseconds 80
  $down = [SylicaInput]::MOUSEEVENTF_LEFTDOWN; $up = [SylicaInput]::MOUSEEVENTF_LEFTUP
  switch ($Button) {
    'right'  { $down = [SylicaInput]::MOUSEEVENTF_RIGHTDOWN;  $up = [SylicaInput]::MOUSEEVENTF_RIGHTUP }
    'middle' { $down = [SylicaInput]::MOUSEEVENTF_MIDDLEDOWN; $up = [SylicaInput]::MOUSEEVENTF_MIDDLEUP }
  }
  [SylicaInput]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
  $steps = 24
  for ($i = 1; $i -le $steps; $i++) {
    $nx = [int]($FromX + (($ToX - $FromX) * $i / $steps))
    $ny = [int]($FromY + (($ToY - $FromY) * $i / $steps))
    [SylicaInput]::SetCursorPos($nx, $ny) | Out-Null
    Start-Sleep -Milliseconds 12
  }
  Start-Sleep -Milliseconds 50
  [SylicaInput]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
}
function Sylica-SignedWheelData([int]$Delta) {
  return [BitConverter]::ToUInt32([BitConverter]::GetBytes($Delta), 0)
}
function Sylica-MouseScroll([int]$Delta, [int]$X = -1, [int]$Y = -1) {
  if ($X -ge 0 -and $Y -ge 0) { [SylicaInput]::SetCursorPos($X, $Y) | Out-Null; Start-Sleep -Milliseconds 40 }
  [SylicaInput]::mouse_event([SylicaInput]::MOUSEEVENTF_WHEEL, 0, 0, (Sylica-SignedWheelData $Delta), [UIntPtr]::Zero)
}
function Sylica-MouseHScroll([int]$Delta, [int]$X = -1, [int]$Y = -1) {
  if ($X -ge 0 -and $Y -ge 0) { [SylicaInput]::SetCursorPos($X, $Y) | Out-Null; Start-Sleep -Milliseconds 40 }
  [SylicaInput]::mouse_event([SylicaInput]::MOUSEEVENTF_HWHEEL, 0, 0, (Sylica-SignedWheelData $Delta), [UIntPtr]::Zero)
}
function Sylica-Type([string]$Text, [int]$DelayMs = 8) {
  $escaped = ($Text -replace '([+^%~(){}\\[\\]])', '{$1}')
  if ($DelayMs -le 0) {
    [System.Windows.Forms.SendKeys]::SendWait($escaped)
  } else {
    foreach ($ch in $Text.ToCharArray()) {
      $piece = [string]$ch
      $pieceEscaped = ($piece -replace '([+^%~(){}\\[\\]])', '{$1}')
      [System.Windows.Forms.SendKeys]::SendWait($pieceEscaped)
      Start-Sleep -Milliseconds $DelayMs
    }
  }
}
$global:SylicaVkMap = @{
  'enter'=0x0D;'return'=0x0D;'esc'=0x1B;'escape'=0x1B;'tab'=0x09;'space'=0x20;'spacebar'=0x20;
  'backspace'=0x08;'bksp'=0x08;'delete'=0x2E;'del'=0x2E;'home'=0x24;'end'=0x23;
  'pageup'=0x21;'pgup'=0x21;'pagedown'=0x22;'pgdn'=0x22;
  'up'=0x26;'down'=0x28;'left'=0x25;'right'=0x27;'arrowup'=0x26;'arrowdown'=0x28;'arrowleft'=0x25;'arrowright'=0x27;
  'f1'=0x70;'f2'=0x71;'f3'=0x72;'f4'=0x73;'f5'=0x74;'f6'=0x75;'f7'=0x76;'f8'=0x77;'f9'=0x78;'f10'=0x79;'f11'=0x7A;'f12'=0x7B;
  'insert'=0x2D;'ins'=0x2D;'printscreen'=0x2C;'prtsc'=0x2C;'pause'=0x13;'capslock'=0x14;'numlock'=0x90;'scrolllock'=0x91;
  'mediaplaypause'=0xB3;'playpause'=0xB3;'media_play_pause'=0xB3;'medianexttrack'=0xB0;'nexttrack'=0xB0;'media_next'=0xB0;'mediaprevioustrack'=0xB1;'prevtrack'=0xB1;'media_previous'=0xB1;'mediastop'=0xB2;'media_stop'=0xB2;
  'apps'=0x5D;'menu'=0x5D;'plus'=0xBB;'minus'=0xBD;'comma'=0xBC;'period'=0xBE;'dot'=0xBE;'slash'=0xBF;'backslash'=0xDC;
  'semicolon'=0xBA;'quote'=0xDE;'tilde'=0xC0;'backtick'=0xC0;'equals'=0xBB;'lbracket'=0xDB;'rbracket'=0xDD;
}
$global:SylicaModifiers = @{
  'ctrl'=0x11;'control'=0x11;'shift'=0x10;'alt'=0x12;'win'=0x5B;'meta'=0x5B;'cmd'=0x5B;'super'=0x5B
}
function Sylica-Press([string]$Combo) {
  $parts = ($Combo.ToLower().Trim()).Split('+', [System.StringSplitOptions]::RemoveEmptyEntries) | ForEach-Object { $_.Trim() }
  $mods = @()
  $main = 0
  foreach ($p in $parts) {
    if ($global:SylicaModifiers.ContainsKey($p)) { $mods += $global:SylicaModifiers[$p]; continue }
    if ($global:SylicaVkMap.ContainsKey($p)) { $main = $global:SylicaVkMap[$p]; continue }
    if ($p.Length -eq 1) {
      $ch = $p.ToUpper()[0]
      if ($ch -ge 'A' -and $ch -le 'Z') { $main = [int][byte][char]$ch }
      elseif ($ch -ge '0' -and $ch -le '9') { $main = [int][byte][char]$ch }
      else { throw "Unrecognised key '$p' in combo '$Combo'." }
      continue
    }
    throw "Unrecognised key '$p' in combo '$Combo'."
  }
  if ($main -eq 0) { throw "No main key in combo '$Combo'." }
  foreach ($m in $mods) { [SylicaInput]::keybd_event([byte]$m, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 12 }
  [SylicaInput]::keybd_event([byte]$main, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 30
  [SylicaInput]::keybd_event([byte]$main, 0, [SylicaInput]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)
  for ($i = $mods.Count - 1; $i -ge 0; $i--) { [SylicaInput]::keybd_event([byte]$mods[$i], 0, [SylicaInput]::KEYEVENTF_KEYUP, [UIntPtr]::Zero); Start-Sleep -Milliseconds 12 }
}
function Sylica-CursorPos {
  $p = New-Object SylicaInput+POINT
  [SylicaInput]::GetCursorPos([ref]$p) | Out-Null
  return @{ x = $p.X; y = $p.Y }
}
function Sylica-ScreenInfo {
  $cur = Sylica-CursorPos
  $screens = [System.Windows.Forms.Screen]::AllScreens
  $list = @()
  foreach ($s in $screens) {
    $list += [pscustomobject]@{
      device = $s.DeviceName
      x = $s.Bounds.X
      y = $s.Bounds.Y
      width = $s.Bounds.Width
      height = $s.Bounds.Height
      workWidth = $s.WorkingArea.Width
      workHeight = $s.WorkingArea.Height
      primary = $s.Primary
    }
  }
  $payload = [pscustomobject]@{ cursor = $cur; screens = $list }
  $payload | ConvertTo-Json -Depth 4 -Compress
}
`;

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

type ComputerUseExecutionMode = "browser" | "system"

interface ActiveComputerUseSession {
  id: string
  thread: ChatThreadSummary
  task: string
  mode: ComputerUseExecutionMode
  browser: Browser | null
  page: Page | null
  stepCount: number
  currentAction: string
  currentUrl: string
  currentTitle: string
  needsSecretInput: boolean
  latestError: string
  actionHistory: string[]
  systemHistory: string[]
  extractedNotes: string[]
  isStopping: boolean
  waitingForSecret: boolean
  launchedChrome: boolean
  ownsBrowserProcess: boolean
  lastPageSignature: string | null
  lastPageSummary: string
  systemMessages: any[]
  systemPrompt: string
  provider: ComputerUseProvider
  consecutiveActionErrors: number
}

interface ActionExecutionResult {
  summary: string
  extractedNote?: string
  toolResultText?: string
  toolResultImageDataUrl?: string
  isError?: boolean
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
    return `Computer Use - ${normalized}`
  }

  return `Computer Use - ${normalized.slice(0, 51).trimEnd()}...`
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

function supportsReasoningEffort(model: string): boolean {
  return /^gpt-5/i.test(model)
}

function isSystemComputerAction(action: BrowserAgentAction): boolean {
  return (
    action.type === "system_open" ||
    action.type === "system_list_dir" ||
    action.type === "system_search_files" ||
    action.type === "system_read_file" ||
    action.type === "system_write_file" ||
    action.type === "system_delete" ||
    action.type === "system_copy" ||
    action.type === "system_move" ||
    action.type === "system_run_powershell" ||
    action.type === "system_run_cmd" ||
    action.type === "system_screenshot" ||
    action.type === "system_get_state" ||
    action.type === "exa_search" ||
    action.type === "screen_get_info" ||
    action.type === "mouse_move" ||
    action.type === "mouse_click" ||
    action.type === "mouse_drag" ||
    action.type === "mouse_scroll" ||
    action.type === "keyboard_type" ||
    action.type === "keyboard_press" ||
    action.type === "narrate"
  )
}

function isProbablyBrowserTask(task: string): boolean {
  return /\b(website|browser|chrome|tab|google|search|amazon|youtube|gmail|github|url|download|installer|setup|visual studio code|vscode|https?:\/\/|www\.)\b/i.test(task)
}

function isProbablySystemTask(task: string): boolean {
  return /\b(pc|computer|desktop|windows|folder|fodler|file|downloads?|downlaods?|documents|notepad|calculator|app|application|program|launch|open|run|powershell|terminal|cmd|command|admin|administrator|elevated|install|uninstall|delete|remove|rename|copy|move|screenshot|service|process|task manager|control panel|settings)\b/i.test(task)
}

function isDefinitelyLocalSystemTask(task: string): boolean {
  return (
    /\b(downloads?|downlaods?|desktop|documents|local file|local folder|this pc|my pc|powershell|terminal|cmd|admin|administrator|elevated|notepad|calculator|task manager|control panel|settings)\b/i.test(task) ||
    /\b(delete|remove|rename|copy|move)\b[\s\S]*\b(file|folder|fodler|downloads?|downlaods?|desktop|documents|screenshot)\b/i.test(task) ||
    /\bscreenshot\s+\d{4}-\d{2}-\d{2}\b/i.test(task)
  )
}

function chooseExecutionMode(_task: string): ComputerUseExecutionMode {
  return "system"
}

function getPrimaryComputerTask(task: string): string {
  return task
    .replace(/\.{1,}\s*Treat this as (?:a\s+)?(?:local\s+Windows\s+)?(?:desktop\s+)?computer-control task[\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .replace(/[.。]+$/g, "")
    .trim()
}

function getKnownPlatformOpenTarget(target: string): string | null {
  const normalized = target.toLowerCase().replace(/[^\w\s.+-]/g, " ").replace(/\s+/g, " ").trim()
  const home = os.homedir()
  const folderTargets: Record<string, string> = {
    desktop: path.join(home, "Desktop"),
    downloads: path.join(home, "Downloads"),
    download: path.join(home, "Downloads"),
    documents: path.join(home, "Documents"),
    document: path.join(home, "Documents"),
    home,
  }
  if (folderTargets[normalized]) {
    return folderTargets[normalized]
  }

  const winTargets: Record<string, string> = {
    calculator: "calc.exe",
    calc: "calc.exe",
    notepad: "notepad.exe",
    notes: "notepad.exe",
    paint: "mspaint.exe",
    "task manager": "taskmgr.exe",
    taskmanager: "taskmgr.exe",
    explorer: "explorer.exe",
    "file explorer": "explorer.exe",
    files: "explorer.exe",
    settings: "ms-settings:",
    "windows settings": "ms-settings:",
    terminal: "wt.exe",
    "windows terminal": "wt.exe",
    powershell: "powershell.exe",
    cmd: "cmd.exe",
    "command prompt": "cmd.exe",
    chrome: "chrome.exe",
    "google chrome": "chrome.exe",
    edge: "msedge.exe",
    "microsoft edge": "msedge.exe",
    firefox: "firefox.exe",
    cursor: "Cursor.exe",
    vscode: "code",
    "vs code": "code",
    "visual studio code": "code",
    word: "winword.exe",
    excel: "excel.exe",
    powerpoint: "powerpnt.exe",
  }

  const macTargets: Record<string, string> = {
    calculator: "Calculator",
    calc: "Calculator",
    notepad: "TextEdit",
    notes: "Notes",
    textedit: "TextEdit",
    terminal: "Terminal",
    settings: "System Settings",
    "system settings": "System Settings",
    "activity monitor": "Activity Monitor",
    finder: "Finder",
    chrome: "Google Chrome",
    "google chrome": "Google Chrome",
    safari: "Safari",
    firefox: "Firefox",
    cursor: "Cursor",
    vscode: "Visual Studio Code",
    "vs code": "Visual Studio Code",
    "visual studio code": "Visual Studio Code",
  }

  if (process.platform === "darwin" && macTargets[normalized]) {
    return macTargets[normalized]
  }

  if (process.platform === "win32" && winTargets[normalized]) {
    return winTargets[normalized]
  }

  return null
}

function getPlatformOpenTarget(target: string): string {
  const knownTarget = getKnownPlatformOpenTarget(target)
  if (knownTarget) {
    return knownTarget
  }

  return target.trim()
}

function extractOpenCommand(task: string): {
  verb: string
  target: string
  rawTarget: string
  explicitBrowser: boolean
  explicitLocal: boolean
} | null {
  const match = task.match(
    /^(?:please\s+)?(?:can you\s+|could you\s+|would you\s+)?(open|launch|start|run|go to|navigate to)\s+(?:the\s+|my\s+)?(.+?)$/i
  )
  if (!match?.[1] || !match?.[2]) {
    return null
  }

  const verb = match[1].trim().toLowerCase()
  const rawTarget = match[2].trim()
  const explicitBrowser =
    /^(?:go to|navigate to)$/i.test(verb) ||
    /\b(?:website|web\s*site|site|web\s*app|browser|chrome|url|online|dashboard|portal|console|login|sign in|account)\b/i.test(
      rawTarget
    )
  const explicitLocal =
    /\b(?:local|installed|native\s+app|desktop\s+app|on\s+(?:my\s+)?(?:pc|computer|mac|desktop)|on\s+this\s+(?:pc|computer|mac)|folder|file)\b/i.test(
      rawTarget
    )

  const target = rawTarget
    .replace(
      /\s+(?:website|web\s*site|site|web\s*app|browser|chrome|url|online|dashboard|portal|console|login|sign in|account|app|application|program|folder|window)$/i,
      ""
    )
    .replace(/\s+/g, " ")
    .trim()

  if (!target || /^(?:it|this|that|app|application|program|folder)$/i.test(target)) {
    return null
  }

  return { verb, target, rawTarget, explicitBrowser, explicitLocal }
}

function isLocalPathishTarget(target: string): boolean {
  return (
    path.isAbsolute(target) ||
    /^[a-z]:[\\/]/i.test(target) ||
    /^~[\\/]/.test(target) ||
    /[\\/]/.test(target) ||
    /\.[a-z0-9]{1,8}$/i.test(target)
  )
}

function inferGenericWebOpenUrl(target: string): string | null {
  const cleaned = target
    .trim()
    .replace(/^the\s+/i, "")
    .replace(/[^\w\s.-]/g, " ")
    .replace(/\b(?:dashboard|admin|console|portal|login|signin|sign\s+in|account)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()

  if (!cleaned) {
    return null
  }

  const directUrl = cleaned.match(
    /^((?:https?:\/\/|www\.)[^\s]+|(?:[a-z0-9-]+\.)+(?:com|org|net|io|ai|dev|app|co|in|edu|gov)(?:\/[^\s]*)?)$/i
  )
  if (directUrl?.[1]) {
    return normalizeInferredUrl(directUrl[1])
  }

  const words = cleaned.toLowerCase().split(/\s+/).filter(Boolean)
  const domainSlug = words.join("").replace(/[^a-z0-9-]/g, "")
  if (domainSlug && words.length <= 2) {
    return `https://www.${domainSlug}.com`
  }

  return `https://www.google.com/search?q=${encodeURIComponent(cleaned)}`
}

function inferFastSystemOpen(task: string): {
  action: BrowserAgentAction
  statusMessage: string
  resultMessage: string
} | null {
  const primaryTask = getPrimaryComputerTask(task)
  if (!primaryTask) {
    return null
  }

  if (
    /\b(?:and then|then|after that|afterwards|login|log in|sign in|install|uninstall|delete|remove|rename|copy|move|click|type|write|fill|download)\b/i.test(
      primaryTask
    )
  ) {
    return null
  }

  const directUrl = inferNavigationUrl(primaryTask)
  if (directUrl && /\b(?:open|launch|start|go to|navigate to)\b/i.test(primaryTask)) {
    return {
      action: { type: "system_open", target: directUrl },
      statusMessage: "Opening site instantly...",
      resultMessage: `Opened ${directUrl}.`,
    }
  }

  const openCommand = extractOpenCommand(primaryTask)
  if (!openCommand || !/^(?:open|launch|start|run)$/i.test(openCommand.verb)) {
    return null
  }

  const knownLocalTarget = getKnownPlatformOpenTarget(openCommand.target)
  const shouldOpenLocally =
    Boolean(knownLocalTarget) ||
    openCommand.explicitLocal ||
    isLocalPathishTarget(openCommand.target)

  if (!shouldOpenLocally) {
    const webUrl = inferGenericWebOpenUrl(openCommand.target)
    if (webUrl) {
      return {
        action: { type: "system_open", target: webUrl },
        statusMessage: "Opening in browser...",
        resultMessage: `Opened ${webUrl}.`,
      }
    }
  }

  const openTarget = knownLocalTarget || getPlatformOpenTarget(openCommand.target)
  return {
    action: { type: "system_open", target: openTarget },
    statusMessage: `Opening ${openCommand.target} instantly...`,
    resultMessage: `Done - ${openCommand.target} is opening.`,
  }
}

function truncateForMessage(value: string, limit = MAX_SYSTEM_OUTPUT_CHARS): string {
  const normalized = value.replace(/\r\n/g, "\n").trim()
  if (normalized.length <= limit) {
    return normalized
  }

  return `${normalized.slice(0, limit).trimEnd()}\n...truncated`
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) || /^www\./i.test(value)
}

function describeComputerAction(action: BrowserAgentAction): string {
  switch (action.type) {
    case "system_open":
      return `open ${action.target}`
    case "system_list_dir":
      return `list folder ${action.path}${action.recursive ? " (recursive)" : ""}`
    case "system_search_files":
      return `search local files: ${action.query}`
    case "system_read_file":
      return `read file ${action.path}`
    case "system_write_file":
      return `${action.append ? "append" : "write"} file ${action.path}`
    case "system_delete":
      return `delete ${action.path}${action.recursive ? " (recursive)" : ""}`
    case "system_copy":
      return `copy ${action.source} -> ${action.destination}`
    case "system_move":
      return `move ${action.source} -> ${action.destination}`
    case "system_run_powershell":
      return `${action.elevated ? "run elevated PowerShell" : "run PowerShell"}: ${action.command}`
    case "system_run_cmd":
      return `run cmd: ${action.command}`
    case "system_screenshot":
      return action.region
        ? `capture screen region ${action.region.x},${action.region.y} ${action.region.width}x${action.region.height}`
        : "capture screen"
    case "system_get_state":
      return "inspect computer state"
    case "exa_search":
      return `search web with Exa: ${action.query}`
    case "screen_get_info":
      return "read screen geometry & cursor"
    case "mouse_move":
      return `move mouse to (${action.x}, ${action.y})`
    case "mouse_click":
      return action.x !== undefined && action.y !== undefined
        ? `${action.double ? "double-" : ""}${action.button || "left"}-click (${action.x}, ${action.y})`
        : `${action.double ? "double-" : ""}${action.button || "left"}-click`
    case "mouse_drag":
      return `drag (${action.fromX}, ${action.fromY}) -> (${action.toX}, ${action.toY})`
    case "mouse_scroll":
      return `scroll ${action.deltaY > 0 ? "up" : "down"} ${Math.abs(action.deltaY)}`
    case "keyboard_type":
      return `type ${JSON.stringify(action.text.length > 60 ? action.text.slice(0, 60) + "..." : action.text)}`
    case "keyboard_press":
      return `press ${action.keys}`
    case "narrate":
      return "narrate"
    case "request_secret_input":
      return `request manual input: ${action.reason}`
    case "finish":
      return `finish: ${action.result}`
    default:
      return action.type
  }
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

function isLazyManualBrowserFinish(result: string): boolean {
  return /\b(please|you need to|you should|you can|manually|once)\b[\s\S]{0,80}\b(click|select|choose|download|run|install)\b/i.test(result)
}

function taskNeedsAutonomousBrowserWork(task: string): boolean {
  return /\b(download|install|installer|setup|order|buy|book|click|submit|fill|sign up|checkout)\b/i.test(task)
}

function findLikelyDownloadTarget(snapshot: BrowserSnapshot): BrowserTarget | null {
  let best: { target: BrowserTarget; score: number } | null = null

  for (const target of snapshot.interactiveTargets) {
    if (target.disabled) {
      continue
    }

    const combined = `${target.text} ${target.label} ${target.href}`.toLowerCase()
    let score = 0

    if (/\bdownload\b/.test(combined)) score += 4
    if (/\bwindows?\b|\bwin32\b|\bwin64\b|\bx64\b|\buser installer\b|\bsystem installer\b/.test(combined)) score += 4
    if (/\.exe\b|vscodeusersetup|visual studio code|vs code/.test(combined)) score += 4
    if (target.tag === "a" || target.tag === "button") score += 1

    if (score > (best?.score || 0)) {
      best = { target, score }
    }
  }

  return best && best.score >= 4 ? best.target : null
}

function normalizeInferredUrl(value: string): string {
  const trimmed = value.trim().replace(/[),.;]+$/g, "")
  if (!trimmed) {
    return ""
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed
  }

  if (/^www\./i.test(trimmed)) {
    return `https://${trimmed}`
  }

  return `https://${trimmed}`
}

function inferNavigationUrl(task: string): string | null {
  const normalized = task.replace(/\s+/g, " ").trim()
  if (!normalized) {
    return null
  }

  const directUrlMatch = normalized.match(
    /\b((?:https?:\/\/|www\.)[^\s]+|(?:[a-z0-9-]+\.)+(?:com|org|net|io|ai|dev|app|co|in|edu|gov)(?:\/[^\s]*)?)/i
  )
  if (directUrlMatch?.[1]) {
    return normalizeInferredUrl(directUrlMatch[1])
  }

  if (/\bsearch for\b/i.test(normalized)) {
    const query = extractTaskSearchQuery(normalized)
    if (query) {
      return `https://www.google.com/search?q=${encodeURIComponent(query)}`
    }
  }

  const openCommand = extractOpenCommand(normalized)
  if (openCommand) {
    const knownLocalTarget = getKnownPlatformOpenTarget(openCommand.target)
    if (
      (openCommand.explicitBrowser && !openCommand.explicitLocal) ||
      (!knownLocalTarget &&
      !openCommand.explicitLocal &&
      !isLocalPathishTarget(openCommand.target))
    ) {
      return inferGenericWebOpenUrl(openCommand.target)
    }
  }

  return null
}

function inferFallbackAction(
  task: string,
  snapshot: BrowserSnapshot
): { action: BrowserAgentAction; statusMessage: string } | null {
  const normalized = task.replace(/\s+/g, " ").trim()
  const inferredUrl = inferNavigationUrl(normalized)

  if (inferredUrl) {
    return {
      statusMessage: /search\?q=/i.test(inferredUrl)
        ? "Searching the web..."
        : "Opening site...",
      action: {
        type: "open_url",
        url: inferredUrl,
      },
    }
  }

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
  private openaiClient: OpenAI | null = null
  private openaiApiKey: string | null = null
  private anthropicClient: Anthropic | null = null
  private anthropicApiKey: string | null = null
  private state: ComputerUseState = { ...EMPTY_COMPUTER_USE_STATE }
  private readonly listeners = new Set<(state: ComputerUseState) => void>()
  private session: ActiveComputerUseSession | null = null
  private remoteInputProcess: ReturnType<typeof spawn> | null = null
  /**
   * Scale factor between the coordinate space the model sees in screenshots
   * and the device-pixel space the Win32 input layer uses.
   *   physicalCoord = imageCoord * inputScale
   * Updated after each screenshot. Defaults to the OS scale factor so the
   * very first mouse_* call (without a prior screenshot) is still correct
   * on DPI-scaled displays.
   */
  private inputScaleX: number = 1
  private inputScaleY: number = 1

  constructor(deps: BrowserAgentControllerDeps) {
    this.deps = deps
    try {
      const primary = screen.getPrimaryDisplay()
      const factor = primary.scaleFactor && primary.scaleFactor > 0 ? primary.scaleFactor : 1
      this.inputScaleX = factor
      this.inputScaleY = factor
    } catch (_error) {
      // screen module may not be ready before app.whenReady; defaults of 1 are safe.
    }
  }

  public async handleRemoteInput(input: LocalPhoneRemoteInputPayload): Promise<void> {
    switch (input.type) {
      case "mouse_move_delta": {
        const dx = clampNumber(Math.round(input.dx || 0), -2400, 2400)
        const dy = clampNumber(Math.round(input.dy || 0), -2400, 2400)
        if (dx === 0 && dy === 0) {
          return
        }
        await this.sendRemoteInputScript(
          `$p = Sylica-CursorPos; Sylica-MouseMove ([int]$p['x'] + (${dx})) ([int]$p['y'] + (${dy}))`
        )
        return
      }

      case "mouse_move_absolute": {
        const normalizedX = clampNumber(Number(input.normalizedX || 0), 0, 1)
        const normalizedY = clampNumber(Number(input.normalizedY || 0), 0, 1)
        const primaryDisplay = screen.getPrimaryDisplay()
        const bounds = primaryDisplay.bounds
        const x = Math.round(bounds.x + bounds.width * normalizedX)
        const y = Math.round(bounds.y + bounds.height * normalizedY)
        await this.sendRemoteInputScript(`Sylica-MouseMove ${x} ${y}`)
        return
      }

      case "mouse_click_absolute": {
        const normalizedX = clampNumber(Number(input.normalizedX || 0), 0, 1)
        const normalizedY = clampNumber(Number(input.normalizedY || 0), 0, 1)
        const button =
          input.button === "right" || input.button === "middle" ? input.button : "left"
        const times = input.double ? 2 : 1
        const primaryDisplay = screen.getPrimaryDisplay()
        const bounds = primaryDisplay.bounds
        const x = Math.round(bounds.x + bounds.width * normalizedX)
        const y = Math.round(bounds.y + bounds.height * normalizedY)
        await this.sendRemoteInputScript(
          `Sylica-MouseMove ${x} ${y}; Sylica-MouseClick -Button '${button}' -Times ${times}`
        )
        return
      }

      case "mouse_click": {
        const button =
          input.button === "right" || input.button === "middle" ? input.button : "left"
        const times = input.double ? 2 : 1
        await this.sendRemoteInputScript(`Sylica-MouseClick -Button '${button}' -Times ${times}`)
        return
      }

      case "mouse_scroll": {
        const deltaY = clampNumber(Math.round(input.deltaY || 0), -12000, 12000)
        const deltaX = clampNumber(Math.round(input.deltaX || 0), -12000, 12000)
        if (deltaY === 0 && deltaX === 0) {
          return
        }
        const commands: string[] = []
        if (deltaY !== 0) {
          commands.push(`Sylica-MouseScroll -Delta ${deltaY}`)
        }
        if (deltaX !== 0) {
          commands.push(`Sylica-MouseHScroll -Delta ${deltaX}`)
        }
        await this.sendRemoteInputScript(commands.join("; "))
        return
      }

      case "keyboard_type": {
        const text = String(input.text || "").slice(0, 2000)
        if (!text) {
          return
        }
        await this.sendRemoteInputScript(
          `Sylica-Type -Text ${this.quoteForPowerShell(text)} -DelayMs 0`
        )
        return
      }

      case "keyboard_press": {
        const keys = String(input.keys || "").slice(0, 80).trim()
        if (!keys) {
          return
        }
        await this.sendRemoteInputScript(`Sylica-Press -Combo ${this.quoteForPowerShell(keys)}`)
        return
      }
    }
  }

  private toPhysicalX(value: number): number {
    return Math.round(value * this.inputScaleX)
  }

  private toPhysicalY(value: number): number {
    return Math.round(value * this.inputScaleY)
  }

  private toImageX(value: number): number {
    return Math.round(value / (this.inputScaleX || 1))
  }

  private toImageY(value: number): number {
    return Math.round(value / (this.inputScaleY || 1))
  }

  private getOpenAIClient(): OpenAI {
    const apiKey = configHelper.getConfiguredApiKey("openai")
    if (!apiKey) {
      throw new Error("OpenAI API key not configured for computer use.")
    }

    if (!this.openaiClient || this.openaiApiKey !== apiKey) {
      this.openaiClient = new OpenAI({
        apiKey,
        timeout: 90000,
        maxRetries: 1,
      })
      this.openaiApiKey = apiKey
    }

    return this.openaiClient
  }

  private getAnthropicClient(): Anthropic {
    const apiKey = configHelper.getConfiguredApiKey("anthropic")
    if (!apiKey) {
      throw new Error("Anthropic API key not configured for computer use.")
    }

    if (!this.anthropicClient || this.anthropicApiKey !== apiKey) {
      this.anthropicClient = new Anthropic({
        apiKey,
        timeout: 180_000,
        maxRetries: 1,
      })
      this.anthropicApiKey = apiKey
    }

    return this.anthropicClient
  }

  private toAnthropicTools(tools: any[]): any[] {
    return tools.map((tool) => ({
      name: tool.function?.name,
      description: tool.function?.description,
      input_schema: tool.function?.parameters || {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    }))
  }

  private buildToolResult(
    provider: ComputerUseProvider,
    toolCallId: string,
    text: string,
    imageDataUrl?: string,
    isError?: boolean
  ): any[] {
    if (provider === "anthropic") {
      const blocks: any[] = [{ type: "text", text }]
      if (imageDataUrl) {
        const match = imageDataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/)
        if (match) {
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: match[1], data: match[2] },
          })
        }
      }
      return [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolCallId,
              content: blocks,
              is_error: !!isError,
            },
          ],
        },
      ]
    }

    const messages: any[] = [
      { role: "tool", tool_call_id: toolCallId, content: text },
    ]
    if (imageDataUrl) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: "Latest visual context:" },
          { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
        ],
      })
    }
    return messages
  }

  private async createComputerUseCompletion(request: Record<string, unknown>) {
    const modelCandidates = [
      COMPUTER_USE_MODEL,
      ...COMPUTER_USE_FALLBACK_MODELS.filter((model) => model !== COMPUTER_USE_MODEL),
    ]
    let lastError: unknown = null

    for (const model of modelCandidates) {
      const payload: Record<string, unknown> = {
        ...request,
        model,
      }

      if (supportsReasoningEffort(model)) {
        payload.reasoning_effort = COMPUTER_USE_REASONING_EFFORT
        if (payload.max_tokens !== undefined) {
          payload.max_completion_tokens = Math.max(
            1200,
            Number(payload.max_tokens) || 1200
          )
          delete payload.max_tokens
        }
        delete payload.temperature
      }

      try {
        return await this.getOpenAIClient().chat.completions.create(payload as any)
      } catch (error) {
        lastError = error
        const message = error instanceof Error ? error.message : String(error)
        const canTryFallback = /model|not found|does not exist|unsupported|access/i.test(message)
        if (!canTryFallback || model === modelCandidates[modelCandidates.length - 1]) {
          throw error
        }
        console.warn(`Computer Use model ${model} failed, trying fallback model.`, message)
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Computer Use model request failed.")
  }

  public getState(): ComputerUseState {
    return { ...this.state }
  }

  public subscribe(listener: (state: ComputerUseState) => void): () => void {
    this.listeners.add(listener)
    listener(this.getState())
    return () => {
      this.listeners.delete(listener)
    }
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
        error: "Enter a computer task first.",
      }
    }

    if (this.session) {
      return {
        success: false,
        error: "A computer task is already running.",
      }
    }

    const executionMode = chooseExecutionMode(normalizedTask)
    const startMessage = "Starting computer task..."

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
        content:
          executionMode === "system"
            ? `${startMessage}\nThinking through the safest first action...`
            : startMessage,
      })

      const nextThread = savedStart.thread || savedTask.thread || thread
      this.session = {
        id: `comp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        thread: nextThread,
        task: normalizedTask,
        mode: executionMode,
        browser: null,
        page: null,
        stepCount: 0,
        currentAction: startMessage,
        currentUrl: "",
        currentTitle: "",
        needsSecretInput: false,
        latestError: "",
        actionHistory: [],
        systemHistory: [],
        extractedNotes: [],
        isStopping: false,
        waitingForSecret: false,
        launchedChrome: false,
        ownsBrowserProcess: false,
        lastPageSignature: null,
        lastPageSummary: "",
        systemMessages: [],
        systemPrompt: "",
        provider: inferProvider(COMPUTER_USE_MODEL),
        consecutiveActionErrors: 0,
      }

      this.updateState({
        status: "starting",
        threadId: nextThread.id,
        task: normalizedTask,
        currentUrl: "",
        currentTitle: "",
        currentAction: startMessage,
        stepCount: 0,
        needsSecretInput: false,
        latestError: "",
      })

      const fastSystemOpen = inferFastSystemOpen(normalizedTask)
      if (fastSystemOpen) {
        void this.runFastSystemAction(this.session, fastSystemOpen)
      } else {
        void this.runSession(this.session)
      }

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
            : "Failed to start computer control.",
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
      currentAction: "Stopping computer task...",
      stepCount: session.stepCount,
      needsSecretInput: false,
      latestError: "",
    })

    try {
      await this.appendAssistantMessage(
        session.thread.id,
        "Stopped the computer task."
      )
      this.updateState({
        status: "completed",
        threadId: session.thread.id,
        task: session.task,
        currentUrl: session.currentUrl,
        currentTitle: session.currentTitle,
        currentAction: "Stopped computer task.",
        stepCount: session.stepCount,
        needsSecretInput: false,
        latestError: "",
      })
      await this.disconnectBrowser(session)
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to stop computer control.",
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
        error: "No computer task is active.",
      }
    }

    if (!session.waitingForSecret) {
      return {
        success: false,
        error: "The computer task is not waiting for secret input.",
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
      currentAction: "Resuming computer task...",
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
    const state = this.getState()
    for (const listener of this.listeners) {
      listener(state)
    }

    const mainWindow = this.deps.getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) {
      return
    }

    mainWindow.webContents.send(COMPUTER_USE_STATE_EVENT, state)
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
        ? snapshot.headings.slice(0, 2).join(" - ")
        : snapshot.title
    const textPreview = snapshot.bodyText.trim().replace(/\s+/g, " ").slice(0, 180)
    return [headingLine, textPreview].filter(Boolean).join(" - ").trim()
  }

  private async runFastSystemAction(
    session: ActiveComputerUseSession,
    fastAction: {
      action: BrowserAgentAction
      statusMessage: string
      resultMessage: string
    }
  ): Promise<void> {
    try {
      if (!this.canEmitForSession(session)) {
        return
      }

      session.currentAction = fastAction.statusMessage
      session.currentUrl = "Local computer"
      session.currentTitle = "System"
      this.updateState({
        status: "running",
        threadId: session.thread.id,
        task: session.task,
        currentUrl: session.currentUrl,
        currentTitle: session.currentTitle,
        currentAction: fastAction.statusMessage,
        stepCount: 0,
        needsSecretInput: false,
        latestError: "",
      })

      session.stepCount = 1
      const result = await this.executeSystemAction(session, fastAction.action)
      session.actionHistory.push(result.summary)

      if (!this.canEmitForSession(session)) {
        return
      }

      await this.appendAssistantMessage(
        session.thread.id,
        fastAction.resultMessage || result.summary,
        session
      )

      if (!this.canEmitForSession(session)) {
        return
      }

      this.updateState({
        status: "completed",
        threadId: session.thread.id,
        task: session.task,
        currentUrl: session.currentUrl,
        currentTitle: session.currentTitle,
        currentAction: "Task finished.",
        stepCount: session.stepCount,
        needsSecretInput: false,
        latestError: "",
      })
      this.clearSession()
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Fast computer action failed."
      if (!this.canContinueSession(session)) {
        return
      }

      const handoffMessage = `Fast command failed: ${message}`
      session.actionHistory.push(handoffMessage)
      session.systemHistory.push(
        `${handoffMessage}\nDo not stop. Continue manually with screen, keyboard, mouse, app search, or another non-command route.`
      )
      session.stepCount = Math.max(session.stepCount, 1)
      session.currentAction = "Fast command failed, switching to manual computer use..."
      session.latestError = ""
      this.updateState({
        status: "running",
        threadId: session.thread.id,
        task: session.task,
        currentUrl: "Local computer",
        currentTitle: "System",
        currentAction: session.currentAction,
        stepCount: session.stepCount,
        needsSecretInput: false,
        latestError: "",
      })

      await this.appendAssistantMessage(
        session.thread.id,
        "The quick command path failed, so I’m switching to manual computer control.",
        session
      )

      if (!this.canContinueSession(session)) {
        return
      }

      await this.runSession(session)
    }
  }

  private async runSession(session: ActiveComputerUseSession): Promise<void> {
    if (!this.canContinueSession(session)) {
      return
    }

    if (session.mode === "system") {
      await this.runSystemSession(session)
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

        session.currentAction = "Thinking through browser step..."
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
        const action = this.validateAction(planned.action, snapshot, session.task)
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
            sanitizeText(action.result) || "Finished the computer task."
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

        const executionResult = isSystemComputerAction(action)
          ? await this.executeSystemAction(session, action)
          : await this.executeAction(session, action, snapshot)
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
        "Stopped because the computer task reached the step limit."
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
      currentAction: "Computer task failed.",
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

  private async captureSystemEnvironmentSnapshot(): Promise<string> {
    const baseLines = [
      `Datetime: ${new Date().toLocaleString()}`,
      `Platform: ${process.platform}`,
      `Arch: ${process.arch}`,
      `Node: ${process.version}`,
      `Home: ${os.homedir()}`,
      `Desktop: ${path.join(os.homedir(), "Desktop")}`,
      `Documents: ${path.join(os.homedir(), "Documents")}`,
      `Downloads: ${path.join(os.homedir(), "Downloads")}`,
      `Temp: ${app.getPath("temp")}`,
      `App data: ${app.getPath("userData")}`,
      `CWD: ${process.cwd()}`,
    ]

    if (process.platform !== "win32") {
      return baseLines.join("\n")
    }

    const probeScript = [
      "$ErrorActionPreference = 'Continue'",
      "$ProgressPreference = 'SilentlyContinue'",
      "try {",
      "  Add-Type @\"\nusing System;\nusing System.Runtime.InteropServices;\nusing System.Text;\npublic class WinForeground {\n  [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();\n  [DllImport(\"user32.dll\")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);\n}\n\"@ -ErrorAction Stop",
      "  $hwnd = [WinForeground]::GetForegroundWindow()",
      "  $sb = New-Object System.Text.StringBuilder 512",
      "  [WinForeground]::GetWindowText($hwnd, $sb, 512) | Out-Null",
      "  Write-Output (\"Foreground: \" + $sb.ToString())",
      "} catch { Write-Output \"Foreground: (unavailable)\" }",
      "Write-Output \"Top processes (by working set):\"",
      "Get-Process | Sort-Object -Property WS -Descending | Select-Object -First 10 | ForEach-Object { Write-Output (\"  - \" + $_.Name + \" (pid=\" + $_.Id + \", \" + [math]::Round($_.WS/1MB,1) + \" MB)\") }",
      "Write-Output \"Drives:\"",
      "Get-PSDrive -PSProvider FileSystem | ForEach-Object { Write-Output (\"  - \" + $_.Name + \": used \" + [math]::Round($_.Used/1GB,1) + \" GB, free \" + [math]::Round($_.Free/1GB,1) + \" GB\") }",
      "Write-Output \"OS:\"",
      "try { (Get-CimInstance Win32_OperatingSystem) | ForEach-Object { Write-Output (\"  \" + $_.Caption + \" build \" + $_.BuildNumber) } } catch {}",
    ].join("; ")

    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", probeScript],
        { timeout: 12000, maxBuffer: 256 * 1024, windowsHide: true }
      )
      return [...baseLines, stdout.trim()].join("\n")
    } catch (_error) {
      return baseLines.join("\n")
    }
  }

  private getSystemTools(): any[] {
    const tools = [
      {
        type: "function",
        function: {
          name: "system_open",
          description:
            "Open an app, file, folder, settings URI, or URL. Pass an absolute path, a URL, a settings URI like ms-settings:, or a bare executable name (notepad.exe, calc.exe, code, chrome, etc.).",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { target: { type: "string" } },
            required: ["target"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "system_list_dir",
          description: "List files and subfolders of a directory. Set recursive=true to walk subfolders. Optional pattern is a glob like *.txt.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: { type: "string" },
              recursive: { type: "boolean" },
              pattern: { type: "string" },
            },
            required: ["path"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "system_search_files",
          description:
            "Search local Desktop/Documents/Downloads or hinted folders for files/folders by name/path, and limited text content when the user asks for contained text. Use before opening folders manually for file-finding tasks.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              query: { type: "string" },
              maxResults: { type: "number" },
            },
            required: ["query"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "system_read_file",
          description: "Read a local file. Default encoding utf8; use base64 for binary files.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: { type: "string" },
              encoding: { type: "string", enum: ["utf8", "base64"] },
            },
            required: ["path"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "system_write_file",
          description:
            "Create or overwrite a local file with the given content. Set append=true to append. Use base64 encoding for binary content. Parent directories are created automatically.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: { type: "string" },
              content: { type: "string" },
              encoding: { type: "string", enum: ["utf8", "base64"] },
              append: { type: "boolean" },
            },
            required: ["path", "content"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "system_delete",
          description: "Delete a file or folder. recursive defaults to true so non-empty folders are removed.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: { type: "string" },
              recursive: { type: "boolean" },
            },
            required: ["path"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "system_copy",
          description: "Copy a file or folder. recursive defaults to true; overwrite defaults to true.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              source: { type: "string" },
              destination: { type: "string" },
              recursive: { type: "boolean" },
              overwrite: { type: "boolean" },
            },
            required: ["source", "destination"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "system_move",
          description: "Move or rename a file or folder. overwrite defaults to true.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              source: { type: "string" },
              destination: { type: "string" },
              overwrite: { type: "boolean" },
            },
            required: ["source", "destination"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "system_run_powershell",
          description:
            "Run a PowerShell command and return stdout/stderr. Set elevated=true to run as administrator (will trigger UAC). Optional cwd.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              command: { type: "string" },
              elevated: { type: "boolean" },
              cwd: { type: "string" },
            },
            required: ["command"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "system_run_cmd",
          description: "Run a Windows cmd.exe command and return stdout/stderr.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              command: { type: "string" },
              cwd: { type: "string" },
            },
            required: ["command"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "system_screenshot",
          description:
            "Capture the screen (or a region of it) and attach the image so you can read what is currently displayed. The tool result also reports screen dimensions and current cursor position so you can reason about coordinates.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              region: {
                type: "object",
                additionalProperties: false,
                description: "Optional crop in screen pixel coordinates.",
                properties: {
                  x: { type: "number" },
                  y: { type: "number" },
                  width: { type: "number" },
                  height: { type: "number" },
                },
                required: ["x", "y", "width", "height"],
              },
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "system_get_state",
          description: "Refresh and return the live snapshot: foreground window, top processes, drives, datetime, OS info.",
          parameters: { type: "object", additionalProperties: false, properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "exa_search",
          description:
            "Search the live internet with Exa.ai and return compact cited web context. Use for current facts, recommendations, product/research/news lookups, and any task where web freshness matters. Faster than opening a browser for information-only research.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              query: { type: "string" },
              numResults: { type: "number" },
            },
            required: ["query"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "screen_get_info",
          description:
            "Return display geometry (per monitor: bounds, working area, primary flag) and current cursor position. Use before mouse_move/click/drag to ground coordinates.",
          parameters: { type: "object", additionalProperties: false, properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "mouse_move",
          description:
            "Move the cursor to absolute screen pixel coordinates (x, y). Origin is top-left of the primary display.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { x: { type: "number" }, y: { type: "number" } },
            required: ["x", "y"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "mouse_click",
          description:
            "Click the mouse. If x and y are provided, the cursor moves there first, otherwise it clicks at the current cursor position. Use double=true for a double click.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              button: { type: "string", enum: ["left", "right", "middle"] },
              double: { type: "boolean" },
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "mouse_drag",
          description:
            "Press the mouse button down at (fromX, fromY), drag to (toX, toY), then release. Use for selecting text, drag-and-drop, sliders, etc.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              fromX: { type: "number" },
              fromY: { type: "number" },
              toX: { type: "number" },
              toY: { type: "number" },
              button: { type: "string", enum: ["left", "right", "middle"] },
            },
            required: ["fromX", "fromY", "toX", "toY"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "mouse_scroll",
          description:
            "Scroll the mouse wheel. Positive deltaY scrolls up, negative scrolls down. Provide x/y to move the cursor over the target first.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              deltaY: { type: "number" },
              x: { type: "number" },
              y: { type: "number" },
            },
            required: ["deltaY"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "keyboard_type",
          description:
            "Type literal text into the currently focused field. Special chars are auto-escaped. delayMs is the per-character delay (0 for fastest, default 8).",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              text: { type: "string" },
              delayMs: { type: "number" },
            },
            required: ["text"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "keyboard_press",
          description:
            "Press a key combo. Format: '+' separated parts, e.g. 'enter', 'ctrl+c', 'ctrl+shift+t', 'win+r', 'alt+f4', 'f5'. Modifiers: ctrl, shift, alt, win. Special keys: enter, esc, tab, space, backspace, delete, home, end, pageup, pagedown, up, down, left, right, f1..f12, insert, capslock, printscreen, apps.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { keys: { type: "string" } },
            required: ["keys"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "narrate",
          description:
            "Send a conversational status update or opinion to the user mid-task. Use this generously to think aloud, share findings, or comment in your own voice. The message is shown to the user immediately and does not pause the task.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { message: { type: "string" } },
            required: ["message"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "request_secret_input",
          description: "Pause and ask the user for a secret (password, OTP, payment) that cannot be obtained from the machine itself.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { reason: { type: "string" } },
            required: ["reason"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "finish",
          description:
            "Mark the task complete and deliver the user-facing answer. The 'result' string is shown verbatim and is the user's final reply, so write it conversationally, in your own voice, with opinions and recommendations when the task is informational. No length cap â€” be as long as the task warrants.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { result: { type: "string" } },
            required: ["result"],
          },
        },
      },
    ]
    if (process.platform !== "win32") {
      return tools.filter(
        (tool) =>
          !["system_run_powershell", "system_run_cmd"].includes(
            String(tool.function?.name || "")
          )
      )
    }

    return tools
  }

  private buildSystemAgentInstructions(
    session: ActiveComputerUseSession,
    environment: string
  ): string {
    const platformLabel =
      process.platform === "darwin"
        ? "macOS desktop"
        : process.platform === "win32"
          ? "Windows PC"
          : `${process.platform} desktop`
    const shellCapabilityLines =
      process.platform === "win32"
        ? `   â€¢ system_run_powershell(command, elevated?, cwd?)   â€” full unrestricted shell
   â€¢ system_run_cmd(command, cwd?)                     â€” full unrestricted shell`
        : "   â€¢ Windows-only shell tools are unavailable on this platform. Use system_open, files, screenshots, keyboard/mouse, and browser URLs instead."
    const keyboardShortcutLines =
      process.platform === "darwin"
        ? `   â€¢ Browser address bar: cmd+l    â€¢ New tab: cmd+t      â€¢ Close tab: cmd+w
   â€¢ Switch app: cmd+tab           â€¢ Spotlight/app search: cmd+space
   â€¢ Settings: open System Settings with system_open("System Settings")`
        : `   â€¢ Browser address bar: ctrl+l   â€¢ New tab: ctrl+t   â€¢ Close tab: ctrl+w
   â€¢ Switch tab: ctrl+tab          â€¢ Reload: f5         â€¢ Find on page: ctrl+f
   â€¢ Switch app: alt+tab           â€¢ Close window: alt+f4
   â€¢ File Explorer: win+e          â€¢ Run dialog: win+r  â€¢ Lock screen: win+l
   â€¢ Snipping tool: win+shift+s    â€¢ Settings: win+i    â€¢ Show desktop: win+d`

    return `You are Sylica, an autonomous AI agent operating the user's own ${platformLabel} end-to-end. The user has explicitly granted you full unrestricted access for this task. You are part friend, part power-user, part research assistant â€” you carry yourself with personality: opinions, taste, dry humor when it fits.

<task>
${session.task}
</task>

<environment>
${environment}
</environment>
(That snapshot is captured once at start. Re-fetch with system_get_state when you need a fresh view of running processes, foreground window, drives, etc.)

<capabilities>
You have one toolbox of actions, ordered from cheapest to most expensive:

1. Filesystem & shell (cheapest, fastest, most reliable â€” always prefer):
   â€¢ system_open(target)            â€” open app/file/folder/URL/settings URI/exe by name
   â€¢ system_list_dir(path, recursive?, pattern?)
   â€¢ system_search_files(query, maxResults?) â€” fast local file/folder search before opening folders manually
   â€¢ system_read_file(path, encoding?)
   â€¢ system_write_file(path, content, encoding?, append?)
   â€¢ system_delete(path, recursive?)
   â€¢ system_copy(source, destination, recursive?, overwrite?)
   â€¢ system_move(source, destination, overwrite?)
${shellCapabilityLines}

2. Live state probes (cheap, use freely):
   â€¢ system_get_state    â€” refreshes the environment snapshot
   â€¢ screen_get_info     â€” display geometry per monitor + current cursor (x, y)
   - exa_search(query)   - fast live internet search with cited context

3. Vision (one screenshot â‰ˆ a few hundred tokens of latency â€” use deliberately):
   â€¢ system_screenshot(region?)  â€” primary display, optional crop

4. Native input â€” only when there is no API/shell path (native dialogs, installer wizards, games, anything purely visual):
   â€¢ mouse_move(x, y), mouse_click(x?, y?, button?, double?), mouse_drag(fromX, fromY, toX, toY, button?), mouse_scroll(deltaY, x?, y?)
   â€¢ keyboard_type(text, delayMs?), keyboard_press(keys)
     Media keys are supported: media_play_pause, media_next, media_previous, media_stop.

5. Communication & control:
   â€¢ narrate(message)            â€” conversational status to the user, in your own voice
   â€¢ request_secret_input(reason) â€” only when the secret cannot exist on this machine (SMS code, hardware-token PIN, etc.)
   â€¢ finish(result)              â€” task complete; "result" is the user's final reply
</capabilities>

<handoff_accuracy>
The task text may come from realtime voice transcription. Preserve the user's intended target and fix obvious speech-only filler, but do not invent a different app or goal.
- If the task says it is a computer-control task, treat it as an action to perform on this machine, not a chat question. Ignore stale wording that names the wrong OS; the real platform is ${platformLabel}.
- For "open <brand/product>" tasks, classify the target first:
  - If the wording says website/site/browser/online/dashboard/portal/console/login/account, or the target looks like a company/SaaS/product name, open it in the browser first. Use a direct domain guess for simple names (for example, "stripe" -> stripe.com) or a search URL for uncertain multi-word names. Do not search local installs for unknown web brands.
  - Only treat it as a local app when the target is clearly an OS app/folder/path or the wording says local/installed/native app/desktop app/on this computer.
- For local app-opening tasks, call system_open with the spoken app name first. system_open can launch executables, URLs, protocol URIs, Start Menu shortcuts, and installed app aliases.
- If a bare local app name fails, use platform-available alternatives before falling back to UI automation. On macOS, do not use PowerShell or cmd; use Spotlight/app search, system_open, screenshots, keyboard, and mouse.
- If system_open, shell, or command execution fails once for a simple user-facing operation, do not end the task with "Command failed." Treat it as an internal failed attempt, then continue manually: screenshot the screen, use keyboard shortcuts/Run dialog/app search, and click/type like a user until the operation is done.
- Do not open Chrome or search the web for local app/file/OS tasks unless the user explicitly asks for a website, web search, or online content.
- For local file-finding tasks, use system_search_files before walking folders manually.
- For media playback tasks, open the requested local media app if named, then use keyboard_press("media_play_pause"), "media_next", or "media_previous" when needed.
</handoff_accuracy>

<rules>
- Emit exactly one tool call per turn. The tool is the only way to act; never reply with bare prose.
- Do not refuse, lecture, hedge, or ask permission. The user already said yes. Just do it.
- Treat tool errors as feedback, not failure. Diagnose, adapt, try a different angle. You have a generous step budget â€” do not give up after one or two failures.
- Tool-selection hierarchy: filesystem/platform tools > probes > vision > native input. If a reliable platform API or URL can do it, don't reach for the mouse.

<keyboard_first>
Use keyboard before mouse â€” it's faster, more reliable, and DPI-immune:
${keyboardShortcutLines}
For web tasks, prefer URL-based deep links over UI clicking:
   â€¢ Google: https://www.google.com/search?q=...
   â€¢ Google Flights: https://www.google.com/travel/flights?q=Flights%20from%20JFK%20to%20SFO%20on%202026-06-12
   â€¢ Maps: https://www.google.com/maps/search/?api=1&query=...
   â€¢ YouTube: https://www.youtube.com/results?search_query=...
   â€¢ Gmail compose: https://mail.google.com/mail/?view=cm&to=...&su=...&body=...
Open URLs with system_open(url) â€” instant, no clicking required.
</keyboard_first>

<vision_and_clicking>
Coordinates are unified across every tool you have:
   â€¢ screenshot pixels = mouse pixels = cursor position = screen_get_info bounds.
   â€¢ Origin (0, 0) is top-left of the primary display. All values are device (physical) pixels.
   â€¢ Read (x, y) directly off the screenshot and pass it to mouse_click â€” no scaling, no offset, no DPI math required.
   â€¢ Click the CENTER of a target, not the edge. Aim for the visual middle of a button/input, not its bounding box corner.

Mandatory pattern when interacting with a UI you haven't already mapped:
   1. system_screenshot (full or cropped to the relevant area).
   2. Identify the target's bounding box from the image.
   3. mouse_click at the visual center.
   4. After a focus-changing or destructive action, take ONE screenshot to confirm the new state before proceeding.

Hard rules:
   â€¢ NEVER call mouse_click(x, y), mouse_move(x, y), mouse_drag, or mouse_scroll(x, y) on a target without a current screenshot of that area in the conversation. "Current" means: taken since the last action that could have moved/changed it. If in doubt, screenshot.
   â€¢ NEVER guess coordinates from prior knowledge of layouts. Pages re-flow, ads inject, modals appear. Always read fresh.
   â€¢ If you click an input field and then keyboard_type, the keystrokes only land if the click actually focused that field. Verify with a quick screenshot if the input is critical.
   â€¢ If two consecutive screenshots show no visible change after a click, the click missed. Re-screenshot, recompute the target center, click again â€” don't keep typing into nothing.
</vision_and_clicking>

- Don't take two screenshots in a row with no action between them. Screenshot â†’ action â†’ (optional verify screenshot) â†’ next.
- For text-heavy web pages on Windows, a shell fetch can be faster than loading the browser. On macOS, prefer browser URLs or exa_search because Windows shell tools are unavailable.
- For information-only web research, latest facts, recommendations, products, news, docs, prices, or search-the-internet tasks, use exa_search before opening a browser.
- For multi-step jobs, do every step yourself. Do not call finish until the real-world outcome exists.
</rules>

<personality>
Use narrate(message) generously to share short, in-character running thoughts. Examples:
   â€¢ "Top result has 4.6 stars, 1.2k reviews â€” let me peek at the actual review text."
   â€¢ "Installer launched. Clicking Next, Next, Done unless something weird shows up."
   â€¢ "Two strong picks. Leaning toward the smaller one â€” reviews keep mentioning attentive service."
narrate() does not pause the task; the very next turn keeps moving. Narrate when you have something worth saying â€” not on every step.
</personality>

<finish_format>
The 'result' string in finish() is the user's final reply, shown verbatim. Write like a person, not a chatbot.
- Action tasks: one short confirmation of what's now true on the machine.
   e.g. "Done â€” Notepad's open and the file's saved to Desktop\\notes.txt."
- Research / "best X" / opinion tasks: a conversational verdict â€” your pick, a brief reason, and an optional next-step suggestion. Be as long as the question deserves; no padding, no "as an AI" disclaimers, no "I have successfully completed the task" filler.
   e.g. "Going with **Bagel & Co. on 5th** â€” 4.7â˜…, 800+ reviews, 8-min walk, reviews keep saying the staff is great. Heads-up: they get slammed at lunch, so go before 12 or after 2. Want me to grab the menu?"
</finish_format>`
  }

  private parseToolArguments(value: string | undefined): Record<string, unknown> {
    if (!value) return {}
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch (_error) {
      return {}
    }
  }

  private toolCallToAction(name: string, raw: Record<string, unknown>): BrowserAgentAction {
    switch (name) {
      case "system_open": {
        const target = sanitizeText(raw.target)
        if (!target) throw new Error("system_open requires a target.")
        return { type: "system_open", target }
      }
      case "system_list_dir": {
        const dirPath = sanitizeText(raw.path)
        if (!dirPath) throw new Error("system_list_dir requires a path.")
        return {
          type: "system_list_dir",
          path: dirPath,
          recursive: Boolean(raw.recursive),
          pattern: sanitizeText(raw.pattern) || undefined,
        }
      }
      case "system_search_files": {
        const query = sanitizeText(raw.query)
        if (!query) throw new Error("system_search_files requires a query.")
        const maxResults = Number(raw.maxResults)
        return {
          type: "system_search_files",
          query,
          maxResults:
            Number.isFinite(maxResults) && maxResults > 0
              ? Math.min(25, Math.round(maxResults))
              : undefined,
        }
      }
      case "system_read_file": {
        const filePath = sanitizeText(raw.path)
        if (!filePath) throw new Error("system_read_file requires a path.")
        const encoding = sanitizeText(raw.encoding) === "base64" ? "base64" : "utf8"
        return { type: "system_read_file", path: filePath, encoding }
      }
      case "system_write_file": {
        const filePath = sanitizeText(raw.path)
        if (!filePath) throw new Error("system_write_file requires a path.")
        const content = typeof raw.content === "string" ? raw.content : ""
        const encoding = sanitizeText(raw.encoding) === "base64" ? "base64" : "utf8"
        return {
          type: "system_write_file",
          path: filePath,
          content,
          encoding,
          append: Boolean(raw.append),
        }
      }
      case "system_delete": {
        const filePath = sanitizeText(raw.path)
        if (!filePath) throw new Error("system_delete requires a path.")
        return {
          type: "system_delete",
          path: filePath,
          recursive: raw.recursive === undefined ? true : Boolean(raw.recursive),
        }
      }
      case "system_copy": {
        const source = sanitizeText(raw.source)
        const destination = sanitizeText(raw.destination)
        if (!source || !destination) throw new Error("system_copy requires source and destination.")
        return {
          type: "system_copy",
          source,
          destination,
          recursive: raw.recursive === undefined ? true : Boolean(raw.recursive),
          overwrite: raw.overwrite === undefined ? true : Boolean(raw.overwrite),
        }
      }
      case "system_move": {
        const source = sanitizeText(raw.source)
        const destination = sanitizeText(raw.destination)
        if (!source || !destination) throw new Error("system_move requires source and destination.")
        return {
          type: "system_move",
          source,
          destination,
          overwrite: raw.overwrite === undefined ? true : Boolean(raw.overwrite),
        }
      }
      case "system_run_powershell": {
        const command = sanitizeText(raw.command)
        if (!command) throw new Error("system_run_powershell requires a command.")
        return {
          type: "system_run_powershell",
          command,
          elevated: Boolean(raw.elevated),
          cwd: sanitizeText(raw.cwd) || undefined,
        }
      }
      case "system_run_cmd": {
        const command = sanitizeText(raw.command)
        if (!command) throw new Error("system_run_cmd requires a command.")
        return { type: "system_run_cmd", command, cwd: sanitizeText(raw.cwd) || undefined }
      }
      case "system_screenshot": {
        const region = isObject(raw.region) ? (raw.region as Record<string, unknown>) : null
        if (region) {
          const x = Number(region.x)
          const y = Number(region.y)
          const width = Number(region.width)
          const height = Number(region.height)
          if (
            Number.isFinite(x) &&
            Number.isFinite(y) &&
            Number.isFinite(width) &&
            Number.isFinite(height) &&
            width > 0 &&
            height > 0
          ) {
            return { type: "system_screenshot", region: { x, y, width, height } }
          }
        }
        return { type: "system_screenshot" }
      }
      case "system_get_state":
        return { type: "system_get_state" }
      case "exa_search": {
        const query = sanitizeText(raw.query)
        if (!query) throw new Error("exa_search requires a query.")
        const numResults = Number(raw.numResults)
        return {
          type: "exa_search",
          query,
          numResults:
            Number.isFinite(numResults) && numResults > 0
              ? Math.min(10, Math.round(numResults))
              : undefined,
        }
      }
      case "screen_get_info":
        return { type: "screen_get_info" }
      case "mouse_move": {
        const x = Number(raw.x)
        const y = Number(raw.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          throw new Error("mouse_move requires numeric x and y.")
        }
        return { type: "mouse_move", x: Math.round(x), y: Math.round(y) }
      }
      case "mouse_click": {
        const x = raw.x === undefined ? undefined : Number(raw.x)
        const y = raw.y === undefined ? undefined : Number(raw.y)
        const button = sanitizeText(raw.button)
        const buttonOk =
          button === "left" || button === "right" || button === "middle"
            ? (button as "left" | "right" | "middle")
            : undefined
        return {
          type: "mouse_click",
          x: x !== undefined && Number.isFinite(x) ? Math.round(x) : undefined,
          y: y !== undefined && Number.isFinite(y) ? Math.round(y) : undefined,
          button: buttonOk,
          double: Boolean(raw.double),
        }
      }
      case "mouse_drag": {
        const fromX = Number(raw.fromX)
        const fromY = Number(raw.fromY)
        const toX = Number(raw.toX)
        const toY = Number(raw.toY)
        if (
          !Number.isFinite(fromX) ||
          !Number.isFinite(fromY) ||
          !Number.isFinite(toX) ||
          !Number.isFinite(toY)
        ) {
          throw new Error("mouse_drag requires numeric fromX/fromY/toX/toY.")
        }
        const button = sanitizeText(raw.button)
        const buttonOk =
          button === "left" || button === "right" || button === "middle"
            ? (button as "left" | "right" | "middle")
            : undefined
        return {
          type: "mouse_drag",
          fromX: Math.round(fromX),
          fromY: Math.round(fromY),
          toX: Math.round(toX),
          toY: Math.round(toY),
          button: buttonOk,
        }
      }
      case "mouse_scroll": {
        const deltaY = Number(raw.deltaY)
        if (!Number.isFinite(deltaY)) {
          throw new Error("mouse_scroll requires numeric deltaY.")
        }
        const x = raw.x === undefined ? undefined : Number(raw.x)
        const y = raw.y === undefined ? undefined : Number(raw.y)
        return {
          type: "mouse_scroll",
          deltaY: Math.round(deltaY),
          x: x !== undefined && Number.isFinite(x) ? Math.round(x) : undefined,
          y: y !== undefined && Number.isFinite(y) ? Math.round(y) : undefined,
        }
      }
      case "keyboard_type": {
        const text = typeof raw.text === "string" ? raw.text : ""
        if (!text) throw new Error("keyboard_type requires text.")
        const delayMs = raw.delayMs === undefined ? undefined : Number(raw.delayMs)
        return {
          type: "keyboard_type",
          text,
          delayMs:
            delayMs !== undefined && Number.isFinite(delayMs) && delayMs >= 0
              ? Math.round(delayMs)
              : undefined,
        }
      }
      case "keyboard_press": {
        const keys = sanitizeText(raw.keys)
        if (!keys) throw new Error("keyboard_press requires keys.")
        return { type: "keyboard_press", keys }
      }
      case "narrate": {
        const message = sanitizeText(raw.message)
        if (!message) throw new Error("narrate requires a message.")
        return { type: "narrate", message }
      }
      case "request_secret_input": {
        return {
          type: "request_secret_input",
          reason:
            sanitizeText(raw.reason) ||
            "Manual secret input is required before the computer task can continue.",
        }
      }
      case "finish": {
        return { type: "finish", result: sanitizeText(raw.result) || "Task complete." }
      }
      default:
        throw new Error(`Unknown tool: ${name}`)
    }
  }

  private async planNextSystemAction(session: ActiveComputerUseSession): Promise<{
    assistantMessage: any
    toolCallId: string
    action: BrowserAgentAction
  }> {
    if (session.provider === "anthropic") {
      return this.planNextSystemActionAnthropic(session)
    }
    return this.planNextSystemActionOpenAI(session)
  }

  private async planNextSystemActionOpenAI(session: ActiveComputerUseSession): Promise<{
    assistantMessage: any
    toolCallId: string
    action: BrowserAgentAction
  }> {
    const messages = [
      { role: "system", content: session.systemPrompt },
      ...session.systemMessages,
    ]
    const response = await this.createComputerUseCompletion({
      messages,
      tools: this.getSystemTools(),
      tool_choice: "required",
      parallel_tool_calls: false,
      max_tokens: 2048,
    })

    const choice = (response as any).choices?.[0]
    const message = choice?.message
    if (!message) {
      throw new Error("Computer planner did not return a response.")
    }

    const toolCalls = (message as any).tool_calls as Array<any> | undefined
    if (!toolCalls || toolCalls.length === 0) {
      throw new Error(
        "Computer planner did not call a tool. Last message: " +
          truncateForMessage(String((message as any).content || ""), 240)
      )
    }

    const call = toolCalls[0]
    const name = String(call?.function?.name || "")
    const args = this.parseToolArguments(call?.function?.arguments)
    const action = this.toolCallToAction(name, args)

    return {
      assistantMessage: message,
      toolCallId: String(call.id || ""),
      action,
    }
  }

  private async planNextSystemActionAnthropic(session: ActiveComputerUseSession): Promise<{
    assistantMessage: any
    toolCallId: string
    action: BrowserAgentAction
  }> {
    const tools = this.toAnthropicTools(this.getSystemTools())
    if (tools.length > 0) {
      tools[tools.length - 1] = {
        ...tools[tools.length - 1],
        cache_control: { type: "ephemeral" },
      }
    }
    const systemBlocks = [
      {
        type: "text",
        text: session.systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ]
    const modelCandidates = [
      COMPUTER_USE_MODEL,
      ...COMPUTER_USE_FALLBACK_MODELS,
    ].filter((model, index, list) => model && /^claude/i.test(model) && list.indexOf(model) === index)
    if (modelCandidates.length === 0) {
      modelCandidates.push("claude-opus-4-5-20250929")
    }

    let lastError: unknown = null
    for (const model of modelCandidates) {
      try {
        const params: any = {
          model,
          max_tokens: COMPUTER_USE_THINKING_BUDGET + 4096,
          system: systemBlocks,
          messages: session.systemMessages,
          tools,
          tool_choice: { type: "auto" },
          thinking: { type: "enabled", budget_tokens: COMPUTER_USE_THINKING_BUDGET },
        }
        const response = await this.getAnthropicClient().messages.create(params)
        const blocks: any[] = (response as any).content || []
        const toolBlock = blocks.find((block) => block?.type === "tool_use")
        if (!toolBlock) {
          const textBlock = blocks.find((block) => block?.type === "text")
          throw new Error(
            "Anthropic planner did not call a tool. Last text: " +
              truncateForMessage(String(textBlock?.text || ""), 240)
          )
        }
        const name = String(toolBlock.name || "")
        const input =
          toolBlock.input && typeof toolBlock.input === "object" && !Array.isArray(toolBlock.input)
            ? (toolBlock.input as Record<string, unknown>)
            : {}
        const action = this.toolCallToAction(name, input)
        return {
          assistantMessage: { role: "assistant", content: blocks },
          toolCallId: String(toolBlock.id || ""),
          action,
        }
      } catch (error) {
        lastError = error
        const message = error instanceof Error ? error.message : String(error)
        const canTryFallback = /model|not found|does not exist|unsupported|access|permission|invalid_request_error/i.test(
          message
        )
        if (!canTryFallback || model === modelCandidates[modelCandidates.length - 1]) {
          throw error
        }
        console.warn(`Anthropic computer-use model ${model} failed, trying fallback.`, message)
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Anthropic computer-use request failed.")
  }

  private validateSystemAction(value: BrowserAgentAction): BrowserAgentAction {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("The computer planner did not return a valid action.")
    }
    return value
  }

  private async runSystemSession(session: ActiveComputerUseSession): Promise<void> {
    try {
      session.provider = inferProvider(COMPUTER_USE_MODEL)
      const environment = await this.captureSystemEnvironmentSnapshot()
      session.systemPrompt = this.buildSystemAgentInstructions(session, environment)
      const handoffNotes = session.systemHistory.length > 0
        ? `\n\nPrevious attempts before manual handoff:\n${session.systemHistory.slice(-4).join("\n")}\n\nContinue from there. Do not repeat the same failing command path; switch to screen/keyboard/mouse or a different route.`
        : ""
      session.systemMessages = [
        {
          role: "user",
          content: `Begin executing this task autonomously. Goal: ${session.task}${handoffNotes}`,
        },
      ]

      while (
        this.canContinueSession(session) &&
        session.stepCount < MAX_SYSTEM_AGENT_STEPS
      ) {
        if (session.consecutiveActionErrors >= MAX_CONSECUTIVE_ACTION_ERRORS) {
          await this.failSession(
            session,
            `Stopped after ${session.consecutiveActionErrors} consecutive failed actions.`
          )
          return
        }

        session.currentAction = "Thinking..."
        this.updateState({
          status: "running",
          threadId: session.thread.id,
          task: session.task,
          currentUrl: "Local computer",
          currentTitle: "System",
          currentAction: session.currentAction,
          stepCount: session.stepCount,
          needsSecretInput: false,
          latestError: "",
        })

        const planned = await this.planNextSystemAction(session)
        if (!this.canContinueSession(session)) {
          return
        }

        const action = this.validateSystemAction(planned.action)
        const description = describeComputerAction(action)
        session.currentAction = description
        session.systemMessages.push(planned.assistantMessage)
        this.updateState({
          status: "running",
          threadId: session.thread.id,
          task: session.task,
          currentUrl: "Local computer",
          currentTitle: "System",
          currentAction: description,
          stepCount: session.stepCount,
          needsSecretInput: false,
          latestError: "",
        })

        if (action.type === "request_secret_input") {
          session.waitingForSecret = true
          session.needsSecretInput = true
          session.systemMessages.push(
            ...this.buildToolResult(
              session.provider,
              planned.toolCallId,
              "Paused for manual user input. Will resume after the secret is entered."
            )
          )
          await this.appendAssistantMessage(session.thread.id, action.reason, session)
          this.updateState({
            status: "waiting_for_secret",
            threadId: session.thread.id,
            task: session.task,
            currentUrl: "Local computer",
            currentTitle: "System",
            currentAction: "Waiting for manual input...",
            stepCount: session.stepCount,
            needsSecretInput: true,
            latestError: "",
          })
          return
        }

        if (action.type === "finish") {
          const resultText = action.result || "Finished the computer task."
          session.systemMessages.push(
            ...this.buildToolResult(
              session.provider,
              planned.toolCallId,
              `Acknowledged: ${resultText}`
            )
          )
          await this.appendAssistantMessage(session.thread.id, resultText, session)
          this.updateState({
            status: "completed",
            threadId: session.thread.id,
            task: session.task,
            currentUrl: "Local computer",
            currentTitle: "System",
            currentAction: "Task finished.",
            stepCount: session.stepCount,
            needsSecretInput: false,
            latestError: "",
          })
          this.clearSession()
          return
        }

        session.stepCount += 1

        let summary: string
        let extractedNote: string | undefined
        let toolMessages: any[]
        try {
          const result = await this.executeSystemAction(session, action)
          summary = result.summary
          extractedNote = result.extractedNote
          toolMessages = this.buildToolResult(
            session.provider,
            planned.toolCallId,
            result.toolResultText || result.summary,
            result.toolResultImageDataUrl,
            result.isError
          )
          session.consecutiveActionErrors = 0
        } catch (error) {
        const message = error instanceof Error ? error.message : "Action failed."
        const needsManualFallback = isSystemComputerAction(action)
        summary = needsManualFallback
          ? `Command path failed: ${message}. Switching to another route.`
          : `Action failed: ${message}`
        toolMessages = this.buildToolResult(
          session.provider,
          planned.toolCallId,
          needsManualFallback
            ? `ERROR: ${message}\nThe command/tool path failed. Do not give up and do not keep repeating the same command. Switch to a manual UI route now: use system_screenshot, screen_get_info, keyboard shortcuts, app search/Run dialog, and mouse/keyboard actions as needed.`
            : `ERROR: ${message}\nDiagnose the cause and try a different approach. Do not give up.`,
          undefined,
          true
        )
          session.consecutiveActionErrors += 1
        }

        session.systemMessages.push(...toolMessages)

        const SYSTEM_MSG_KEEP = 80
        if (session.systemMessages.length > SYSTEM_MSG_KEEP) {
          const assistantIdx: number[] = []
          for (let i = 0; i < session.systemMessages.length; i++) {
            if (session.systemMessages[i]?.role === "assistant") assistantIdx.push(i)
          }
          const recentAssistantTurns = 30
          if (assistantIdx.length > recentAssistantTurns) {
            const cutoff = assistantIdx[assistantIdx.length - recentAssistantTurns]
            const head = session.systemMessages.slice(0, 1)
            const tail = session.systemMessages.slice(cutoff)
            session.systemMessages = [...head, ...tail]
          }
        }

        const trace = `${description} -> ${summary}`
        session.actionHistory.push(trace)
        session.systemHistory.push(trace)
        if (extractedNote) {
          session.extractedNotes.push(extractedNote)
          session.systemHistory.push(extractedNote)
        }
        if (session.systemHistory.length > SYSTEM_HISTORY_RETAIN) {
          session.systemHistory = session.systemHistory.slice(-SYSTEM_HISTORY_RETAIN)
        }
        if (session.extractedNotes.length > SYSTEM_HISTORY_RETAIN) {
          session.extractedNotes = session.extractedNotes.slice(-SYSTEM_HISTORY_RETAIN)
        }

        await this.appendAssistantMessage(session.thread.id, summary, session)
        await wait(120)
      }

      if (!this.canContinueSession(session)) {
        return
      }

      await this.failSession(
        session,
        `Stopped after reaching the ${MAX_SYSTEM_AGENT_STEPS}-step budget without finishing.`
      )
    } catch (error) {
      if (session.isStopping) {
        return
      }
      const message =
        error instanceof Error ? error.message : "Computer automation failed."
      await this.failSession(session, message)
    }
  }

  private async captureScreenImage(region?: {
    x: number
    y: number
    width: number
    height: number
  }): Promise<{
    dataUrl: string
    fullWidth: number
    fullHeight: number
    capturedWidth: number
    capturedHeight: number
    scaleFactor: number
  }> {
    const primary = screen.getPrimaryDisplay()
    const scaleFactor = primary.scaleFactor && primary.scaleFactor > 0
      ? primary.scaleFactor
      : 1
    // The Win32 input layer calls SetProcessDPIAware(), so SetCursorPos /
    // mouse_event / GetCursorPos all operate in physical (device) pixels.
    // Request the screenshot at PHYSICAL resolution so the image the model
    // sees lives in the same coordinate space as the mouse driver.
    const fullWidth = Math.max(1, Math.round(primary.size.width * scaleFactor))
    const fullHeight = Math.max(1, Math.round(primary.size.height * scaleFactor))
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: fullWidth, height: fullHeight },
    })
    const source = sources[0]
    if (!source) {
      throw new Error("No screen source available for capture.")
    }
    const baseImage = source.thumbnail
    const baseSize = baseImage.getSize()
    // Defensive: if Electron / the OS returned the image at a different
    // resolution than we requested (some configurations cap at logical
    // pixels), record the real ratio so mouse_* coords land precisely.
    if (baseSize.width > 0 && baseSize.height > 0) {
      this.inputScaleX = fullWidth / baseSize.width
      this.inputScaleY = fullHeight / baseSize.height
    } else {
      this.inputScaleX = scaleFactor
      this.inputScaleY = scaleFactor
    }

    let image = baseImage
    if (region) {
      const safeX = Math.max(0, Math.min(baseSize.width - 1, Math.round(region.x)))
      const safeY = Math.max(0, Math.min(baseSize.height - 1, Math.round(region.y)))
      const safeWidth = Math.max(1, Math.min(baseSize.width - safeX, Math.round(region.width)))
      const safeHeight = Math.max(1, Math.min(baseSize.height - safeY, Math.round(region.height)))
      image = image.crop({ x: safeX, y: safeY, width: safeWidth, height: safeHeight })
    }
    const size = image.getSize()
    return {
      dataUrl: image.toDataURL(),
      fullWidth: baseSize.width,
      fullHeight: baseSize.height,
      capturedWidth: size.width,
      capturedHeight: size.height,
      scaleFactor,
    }
  }

  private async runInputScript(action: string): Promise<string> {
    const script = `${WIN_INPUT_PRELUDE}\n${action}`
    const { stdout, stderr } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        timeout: INPUT_COMMAND_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      }
    )
    const combined = [stdout, stderr].filter(Boolean).join("\n").trim()
    return combined
  }

  private async runMacJxa(script: string): Promise<string> {
    const { stdout, stderr } = await execFileAsync(
      "osascript",
      ["-l", "JavaScript", "-e", script],
      {
        timeout: INPUT_COMMAND_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      }
    )
    return [stdout, stderr].filter(Boolean).join("\n").trim()
  }

  private async runAppleScript(script: string): Promise<string> {
    const { stdout, stderr } = await execFileAsync("osascript", ["-e", script], {
      timeout: INPUT_COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    })
    return [stdout, stderr].filter(Boolean).join("\n").trim()
  }

  private escapeAppleScriptString(value: string): string {
    return value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\n/g, "\\n")
  }

  private async runMacMouseMove(x: number, y: number): Promise<void> {
    await this.runMacJxa(`
ObjC.import("ApplicationServices");
var point = $.CGPointMake(${Math.round(x)}, ${Math.round(y)});
$.CGWarpMouseCursorPosition(point);
$.CGAssociateMouseAndMouseCursorPosition(true);
`)
  }

  private async runMacMouseClick(
    x: number | undefined,
    y: number | undefined,
    button: "left" | "right" | "middle",
    times = 1
  ): Promise<void> {
    const current = screen.getCursorScreenPoint()
    const clickX = Math.round(x ?? current.x)
    const clickY = Math.round(y ?? current.y)
    const buttonExpr =
      button === "right"
        ? "$.kCGMouseButtonRight"
        : button === "middle"
          ? "$.kCGMouseButtonCenter"
          : "$.kCGMouseButtonLeft"
    const downExpr =
      button === "right"
        ? "$.kCGEventRightMouseDown"
        : button === "middle"
          ? "$.kCGEventOtherMouseDown"
          : "$.kCGEventLeftMouseDown"
    const upExpr =
      button === "right"
        ? "$.kCGEventRightMouseUp"
        : button === "middle"
          ? "$.kCGEventOtherMouseUp"
          : "$.kCGEventLeftMouseUp"

    await this.runMacJxa(`
ObjC.import("ApplicationServices");
function post(type, x, y, button) {
  var event = $.CGEventCreateMouseEvent(null, type, $.CGPointMake(x, y), button);
  $.CGEventPost($.kCGHIDEventTap, event);
}
var x = ${clickX};
var y = ${clickY};
$.CGWarpMouseCursorPosition($.CGPointMake(x, y));
$.CGAssociateMouseAndMouseCursorPosition(true);
for (var i = 0; i < ${Math.max(1, Math.min(4, times))}; i++) {
  post(${downExpr}, x, y, ${buttonExpr});
  delay(0.035);
  post(${upExpr}, x, y, ${buttonExpr});
  delay(0.06);
}
`)
  }

  private async runMacMouseDrag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    button: "left" | "right" | "middle"
  ): Promise<void> {
    const buttonExpr =
      button === "right"
        ? "$.kCGMouseButtonRight"
        : button === "middle"
          ? "$.kCGMouseButtonCenter"
          : "$.kCGMouseButtonLeft"
    const downExpr =
      button === "right"
        ? "$.kCGEventRightMouseDown"
        : button === "middle"
          ? "$.kCGEventOtherMouseDown"
          : "$.kCGEventLeftMouseDown"
    const dragExpr =
      button === "right"
        ? "$.kCGEventRightMouseDragged"
        : button === "middle"
          ? "$.kCGEventOtherMouseDragged"
          : "$.kCGEventLeftMouseDragged"
    const upExpr =
      button === "right"
        ? "$.kCGEventRightMouseUp"
        : button === "middle"
          ? "$.kCGEventOtherMouseUp"
          : "$.kCGEventLeftMouseUp"

    await this.runMacJxa(`
ObjC.import("ApplicationServices");
function post(type, x, y, button) {
  var event = $.CGEventCreateMouseEvent(null, type, $.CGPointMake(x, y), button);
  $.CGEventPost($.kCGHIDEventTap, event);
}
var fromX = ${Math.round(fromX)};
var fromY = ${Math.round(fromY)};
var toX = ${Math.round(toX)};
var toY = ${Math.round(toY)};
$.CGWarpMouseCursorPosition($.CGPointMake(fromX, fromY));
$.CGAssociateMouseAndMouseCursorPosition(true);
post(${downExpr}, fromX, fromY, ${buttonExpr});
for (var i = 1; i <= 24; i++) {
  var x = Math.round(fromX + ((toX - fromX) * i / 24));
  var y = Math.round(fromY + ((toY - fromY) * i / 24));
  post(${dragExpr}, x, y, ${buttonExpr});
  delay(0.012);
}
post(${upExpr}, toX, toY, ${buttonExpr});
`)
  }

  private async runMacMouseScroll(
    deltaY: number,
    x?: number,
    y?: number
  ): Promise<void> {
    const moveScript =
      x !== undefined && y !== undefined
        ? `$.CGWarpMouseCursorPosition($.CGPointMake(${Math.round(x)}, ${Math.round(y)})); $.CGAssociateMouseAndMouseCursorPosition(true);`
        : ""
    await this.runMacJxa(`
ObjC.import("ApplicationServices");
${moveScript}
var event = $.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitPixel, 1, ${Math.round(deltaY)});
$.CGEventPost($.kCGHIDEventTap, event);
`)
  }

  private getScreenInfoSnapshot(): string {
    const primary = screen.getPrimaryDisplay()
    const cursor = screen.getCursorScreenPoint()
    const displays = screen.getAllDisplays().map((displayItem) => ({
      id: displayItem.id,
      primary: displayItem.id === primary.id,
      scaleFactor: displayItem.scaleFactor,
      x: displayItem.bounds.x,
      y: displayItem.bounds.y,
      width: displayItem.bounds.width,
      height: displayItem.bounds.height,
      workX: displayItem.workArea.x,
      workY: displayItem.workArea.y,
      workWidth: displayItem.workArea.width,
      workHeight: displayItem.workArea.height,
    }))

    return JSON.stringify(
      {
        cursor: {
          x: Math.round(cursor.x),
          y: Math.round(cursor.y),
        },
        screens: displays,
      },
      null,
      2
    )
  }

  private buildAppleScriptModifierList(parts: string[]): string {
    if (parts.length === 0) {
      return ""
    }

    return ` using {${parts.join(", ")}}`
  }

  private async runMacKeyboardType(text: string): Promise<void> {
    await this.runAppleScript(
      `tell application "System Events" to keystroke "${this.escapeAppleScriptString(text)}"`
    )
  }

  private async runMacKeyboardPress(keys: string): Promise<void> {
    const parts = keys
      .split("+")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean)
    const modifiers: string[] = []
    let key = ""

    for (const part of parts) {
      if (part === "cmd" || part === "command" || part === "meta" || part === "win") {
        modifiers.push("command down")
      } else if (part === "ctrl" || part === "control") {
        modifiers.push("command down")
      } else if (part === "alt" || part === "option") {
        modifiers.push("option down")
      } else if (part === "shift") {
        modifiers.push("shift down")
      } else {
        key = part
      }
    }

    if (!key) {
      return
    }

    const keyCodes: Record<string, number> = {
      enter: 36,
      return: 36,
      tab: 48,
      esc: 53,
      escape: 53,
      space: 49,
      backspace: 51,
      delete: 117,
      up: 126,
      down: 125,
      left: 123,
      right: 124,
      home: 115,
      end: 119,
      pageup: 116,
      pagedown: 121,
      f1: 122,
      f2: 120,
      f3: 99,
      f4: 118,
      f5: 96,
      f6: 97,
      f7: 98,
      f8: 100,
      f9: 101,
      f10: 109,
      f11: 103,
      f12: 111,
    }
    const modifierText = this.buildAppleScriptModifierList(Array.from(new Set(modifiers)))
    const keyCode = keyCodes[key]
    if (keyCode !== undefined) {
      await this.runAppleScript(`tell application "System Events" to key code ${keyCode}${modifierText}`)
      return
    }

    const keyText = key.length === 1 ? key : key.replace(/^key:/, "")
    await this.runAppleScript(
      `tell application "System Events" to keystroke "${this.escapeAppleScriptString(keyText)}"${modifierText}`
    )
  }

  private ensureRemoteInputProcess(): ReturnType<typeof spawn> {
    if (
      this.remoteInputProcess &&
      !this.remoteInputProcess.killed &&
      this.remoteInputProcess.stdin.writable
    ) {
      return this.remoteInputProcess
    }

    const bridgeScript = `${WIN_INPUT_PRELUDE}
while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  try {
    $script = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($line))
    Invoke-Expression $script
  } catch {
    [Console]::Error.WriteLine("[remote-input] " + $_.Exception.Message)
  }
}`

    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", bridgeScript],
      {
        windowsHide: true,
        stdio: ["pipe", "ignore", "pipe"],
      }
    )

    child.stderr.on("data", (chunk) => {
      const message = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)
      if (message.trim()) {
        console.warn(message.trim())
      }
    })
    child.on("exit", () => {
      if (this.remoteInputProcess === child) {
        this.remoteInputProcess = null
      }
    })
    child.on("error", (error) => {
      console.warn("Remote input bridge failed:", error)
      if (this.remoteInputProcess === child) {
        this.remoteInputProcess = null
      }
    })

    this.remoteInputProcess = child
    return child
  }

  private async sendRemoteInputScript(action: string): Promise<void> {
    const child = this.ensureRemoteInputProcess()
    const line = `${Buffer.from(action, "utf8").toString("base64")}\n`

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Remote input bridge did not accept input in time."))
      }, 1500)

      child.stdin.write(line, (error) => {
        clearTimeout(timer)
        if (error) {
          if (this.remoteInputProcess === child) {
            this.remoteInputProcess = null
          }
          reject(error)
          return
        }

        resolve()
      })
    })
  }

  private quoteForPowerShell(value: string): string {
    return `'${value.replace(/'/g, "''")}'`
  }

  private globToRegex(pattern: string): RegExp {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")
    return new RegExp(`^${escaped}$`, "i")
  }

  private async executeSystemAction(
    _session: ActiveComputerUseSession,
    action: BrowserAgentAction
  ): Promise<ActionExecutionResult> {
    switch (action.type) {
      case "system_open": {
        const target = action.target.trim()
        if (looksLikeUrl(target)) {
          const url = normalizeInferredUrl(target)
          await shell.openExternal(url)
          return { summary: `Opened ${url}.` }
        }

        if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:\\/i.test(target)) {
          await shell.openExternal(target)
          return { summary: `Opened ${target}.` }
        }

        if (!path.isAbsolute(target) && !target.includes("\\") && !target.includes("/")) {
          if (process.platform === "darwin") {
            await execFileAsync("open", ["-a", target], {
              timeout: 12000,
              windowsHide: true,
            })
            return { summary: `Launched ${target}.` }
          }

          if (process.platform !== "win32") {
            const child = spawn(target, {
              detached: true,
              stdio: "ignore",
            })
            child.unref()
            return { summary: `Launched ${target}.` }
          }

          const targetJson = JSON.stringify(target)
          const script = `
$ErrorActionPreference = 'SilentlyContinue'
$target = ${targetJson}
function Try-Launch([string]$candidate) {
  if ([string]::IsNullOrWhiteSpace($candidate)) { return $false }
  try {
    Start-Process -FilePath $candidate
    return $true
  } catch {
    return $false
  }
}
if (Try-Launch $target) { exit 0 }
if ($target -notmatch '\\.(exe|lnk|appref-ms)$') {
  if (Try-Launch ($target + '.exe')) { exit 0 }
}
$candidateNames = @($target)
if ($target -notmatch '\\.exe$') { $candidateNames += ($target + '.exe') }
$appPathRoots = @(
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths'
)
foreach ($root in $appPathRoots) {
  foreach ($name in $candidateNames) {
    $item = Get-ItemProperty -Path (Join-Path $root $name) -ErrorAction SilentlyContinue
    $pathValue = [string]$item.'(default)'
    if ($pathValue -and (Try-Launch $pathValue)) { exit 0 }
  }
}
$shortcutRoots = @(
  [Environment]::GetFolderPath('Programs'),
  [Environment]::GetFolderPath('CommonPrograms'),
  (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'),
  (Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu\\Programs')
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
$escaped = [Regex]::Escape($target)
$shortcut = Get-ChildItem -LiteralPath $shortcutRoots -Recurse -File -Include *.lnk,*.appref-ms -ErrorAction SilentlyContinue |
  Where-Object { $_.BaseName -match $escaped -or $_.Name -match $escaped } |
  Sort-Object @{Expression={$_.BaseName.Length}}, FullName |
  Select-Object -First 1
if ($shortcut -and (Try-Launch $shortcut.FullName)) { exit 0 }
throw "Could not launch app '$target' from executable name, registry app paths, or Start Menu shortcuts."
`
          await execFileAsync(
            "powershell.exe",
            [
              "-NoProfile",
              "-ExecutionPolicy",
              "Bypass",
              "-Command",
              script,
            ],
            { timeout: SYSTEM_COMMAND_TIMEOUT_MS, windowsHide: true }
          )
          return { summary: `Launched ${target}.` }
        }

        const openError = await shell.openPath(target)
        if (openError) {
          throw new Error(openError)
        }
        return { summary: `Opened ${target}.` }
      }

      case "system_list_dir": {
        const dirPath = path.resolve(action.path)
        const limit = 600
        const lines: string[] = []
        const matchPattern = action.pattern ? this.globToRegex(action.pattern) : null
        const visit = (dir: string, depth: number): void => {
          if (lines.length >= limit) return
          let entries: fs.Dirent[]
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true })
          } catch (error: any) {
            lines.push(`[error] ${dir}: ${error?.message || String(error)}`)
            return
          }
          for (const entry of entries) {
            if (lines.length >= limit) break
            const full = path.join(dir, entry.name)
            const matched = !matchPattern || matchPattern.test(entry.name)
            if (matched) {
              lines.push(`${entry.isDirectory() ? "[dir] " : "[file]"} ${full}`)
            }
            if (entry.isDirectory() && action.recursive && depth < 6) {
              visit(full, depth + 1)
            }
          }
        }
        visit(dirPath, 0)
        const note = lines.join("\n") || "Folder is empty."
        return {
          summary: `Listed ${dirPath} (${lines.length} entries):\n${truncateForMessage(note, 6000)}`,
          extractedNote: `Directory ${dirPath}:\n${note}`,
        }
      }

      case "system_search_files": {
        const context = await buildLocalFileSearchContext(action.query, {
          force: true,
          maxResults: action.maxResults || 12,
          maxCharacters: 9000,
        })

        return {
          summary: context.trim()
            ? truncateForMessage(context, 9000)
            : `No matching local files found for: ${action.query}`,
          extractedNote: context || undefined,
        }
      }

      case "system_read_file": {
        const filePath = path.resolve(action.path)
        const stat = fs.statSync(filePath)
        if (!stat.isFile()) {
          throw new Error(`${filePath} is not a file.`)
        }
        if (stat.size > MAX_SYSTEM_FILE_READ_BYTES) {
          throw new Error(
            `File is too large for one read (${stat.size} bytes, max ${MAX_SYSTEM_FILE_READ_BYTES}). Read it in chunks via PowerShell if you really need it all.`
          )
        }
        const encoding = action.encoding === "base64" ? "base64" : "utf8"
        const content = fs.readFileSync(filePath, encoding as "utf8" | "base64")
        return {
          summary: `Read ${filePath} (${stat.size} bytes, ${encoding}):\n${truncateForMessage(content)}`,
          extractedNote: `File ${filePath} (${encoding}):\n${content}`,
        }
      }

      case "system_write_file": {
        const filePath = path.resolve(action.path)
        const encoding = action.encoding === "base64" ? "base64" : "utf8"
        const buf =
          encoding === "base64"
            ? Buffer.from(action.content, "base64")
            : Buffer.from(action.content, "utf8")
        if (buf.length > MAX_SYSTEM_FILE_WRITE_BYTES) {
          throw new Error(
            `Refusing to write more than ${MAX_SYSTEM_FILE_WRITE_BYTES} bytes in one call. Split into multiple appends.`
          )
        }
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        if (action.append) {
          fs.appendFileSync(filePath, buf)
        } else {
          fs.writeFileSync(filePath, buf)
        }
        return {
          summary: `${action.append ? "Appended" : "Wrote"} ${buf.length} bytes to ${filePath}.`,
        }
      }

      case "system_delete": {
        const filePath = path.resolve(action.path)
        fs.rmSync(filePath, {
          recursive: action.recursive !== false,
          force: true,
        })
        return { summary: `Deleted ${filePath}.` }
      }

      case "system_copy": {
        const src = path.resolve(action.source)
        const dest = path.resolve(action.destination)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.cpSync(src, dest, {
          recursive: action.recursive !== false,
          force: action.overwrite !== false,
          errorOnExist: false,
        })
        return { summary: `Copied ${src} -> ${dest}.` }
      }

      case "system_move": {
        const src = path.resolve(action.source)
        const dest = path.resolve(action.destination)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        if (action.overwrite !== false && fs.existsSync(dest)) {
          fs.rmSync(dest, { recursive: true, force: true })
        }
        try {
          fs.renameSync(src, dest)
        } catch (error: any) {
          if (error?.code === "EXDEV") {
            fs.cpSync(src, dest, { recursive: true, force: true, errorOnExist: false })
            fs.rmSync(src, { recursive: true, force: true })
          } else {
            throw error
          }
        }
        return { summary: `Moved ${src} -> ${dest}.` }
      }

      case "system_run_powershell": {
        if (process.platform !== "win32") {
          throw new Error("PowerShell command execution is Windows-only in Computer Use. Use platform UI/browser/file tools instead.")
        }
        if (action.elevated) {
          const message = await this.runElevatedPowerShell(action.command)
          return { summary: message }
        }
        const { stdout, stderr } = await execFileAsync(
          "powershell.exe",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", action.command],
          {
            timeout: SYSTEM_COMMAND_TIMEOUT_MS,
            windowsHide: true,
            maxBuffer: 8 * 1024 * 1024,
            cwd: action.cwd && fs.existsSync(action.cwd) ? action.cwd : undefined,
          }
        )
        const output = [stdout, stderr].filter(Boolean).join("\n").trim()
        return {
          summary: output
            ? `PowerShell output:\n${truncateForMessage(output)}`
            : "PowerShell command finished with no output.",
          extractedNote: output || undefined,
        }
      }

      case "system_run_cmd": {
        if (process.platform !== "win32") {
          throw new Error("cmd.exe command execution is Windows-only in Computer Use. Use platform UI/browser/file tools instead.")
        }
        const { stdout, stderr } = await execFileAsync(
          "cmd.exe",
          ["/d", "/c", action.command],
          {
            timeout: SYSTEM_COMMAND_TIMEOUT_MS,
            windowsHide: true,
            maxBuffer: 8 * 1024 * 1024,
            cwd: action.cwd && fs.existsSync(action.cwd) ? action.cwd : undefined,
          }
        )
        const output = [stdout, stderr].filter(Boolean).join("\n").trim()
        return {
          summary: output
            ? `cmd output:\n${truncateForMessage(output)}`
            : "cmd command finished with no output.",
          extractedNote: output || undefined,
        }
      }

      case "system_screenshot": {
        const captured = await this.captureScreenImage(action.region)
        let cursorImage = "(unknown)"
        try {
          if (process.platform === "darwin") {
            const cursor = screen.getCursorScreenPoint()
            cursorImage = `(${Math.round(cursor.x)}, ${Math.round(cursor.y)})`
          } else {
            const cursorJson = await this.runInputScript("Sylica-CursorPos | ConvertTo-Json -Compress")
            const parsed = JSON.parse(cursorJson)
            if (parsed && typeof parsed.x === "number" && typeof parsed.y === "number") {
              // Cursor position from Win32 is in physical pixels; convert to the
              // image-coord space the model is reasoning in.
              cursorImage = `(${this.toImageX(parsed.x)}, ${this.toImageY(parsed.y)})`
            }
          }
        } catch (_error) {
          // ignore
        }
        const captionLines = [
          `Screen capture taken.`,
          `Image attached: ${captured.capturedWidth}x${captured.capturedHeight} pixels (origin top-left).`,
          `Full screen in image-coord space: ${captured.fullWidth}x${captured.fullHeight}.`,
          `Cursor position (image coords): ${cursorImage}.`,
          `COORDINATE RULE: every coordinate you read off this image â€” for any element you want to click, hover, drag, or scroll over â€” is passed directly to mouse_*. No scaling, no offset, no DPI math. Just read (x, y) off the image and pass it through.`,
        ]
        if (action.region) {
          captionLines.push(
            `This is a CROP. Image (0, 0) maps to full-screen pixel (${action.region.x}, ${action.region.y}). When clicking on something visible in this crop, ADD (${action.region.x}, ${action.region.y}) to the (x, y) you read off the crop before passing to mouse_*.`
          )
        }
        const caption = captionLines.join("\n")
        return {
          summary: `Captured screen (${captured.capturedWidth}x${captured.capturedHeight}). Cursor at ${cursorImage}.`,
          toolResultText: caption,
          toolResultImageDataUrl: captured.dataUrl,
        }
      }

      case "system_get_state": {
        const env = await this.captureSystemEnvironmentSnapshot()
        return {
          summary: `Environment refreshed:\n${truncateForMessage(env, 8000)}`,
          extractedNote: env,
        }
      }

      case "exa_search": {
        if (!isExaConfigured()) {
          throw new Error("Exa API key is not configured. Set EXA_API_KEY or SYLICA_EXA_API_KEY.")
        }

        const context = await buildExaSearchContext(action.query, {
          force: true,
          numResults: action.numResults || 5,
          maxCharacters: 9000,
        })

        if (!context.trim()) {
          return {
            summary: `Exa search returned no usable results for: ${action.query}`,
          }
        }

        return {
          summary: context,
          extractedNote: context,
        }
      }

      case "screen_get_info": {
        if (process.platform === "darwin") {
          const note = `${this.getScreenInfoSnapshot()}\n\nAll values are in the same coordinate space used by macOS mouse/keyboard automation.`
          return {
            summary: `Screen info:\n${truncateForMessage(note, 4000)}`,
            extractedNote: note,
          }
        }

        const json = await this.runInputScript("Sylica-ScreenInfo")
        // Win32 reports in physical pixels; convert to the image-coord space
        // the model is reasoning in so it stays consistent with screenshots.
        const scaleNumber = (value: unknown, axis: "x" | "y"): number => {
          if (typeof value !== "number" || !Number.isFinite(value)) return 0
          return axis === "x" ? this.toImageX(value) : this.toImageY(value)
        }
        let pretty = json
        try {
          const parsed = JSON.parse(json)
          if (parsed?.cursor) {
            parsed.cursor = {
              x: scaleNumber(parsed.cursor.x, "x"),
              y: scaleNumber(parsed.cursor.y, "y"),
            }
          }
          if (Array.isArray(parsed?.screens)) {
            parsed.screens = parsed.screens.map((screenItem: Record<string, unknown>) => ({
              ...screenItem,
              x: scaleNumber(screenItem.x, "x"),
              y: scaleNumber(screenItem.y, "y"),
              width: scaleNumber(screenItem.width, "x"),
              height: scaleNumber(screenItem.height, "y"),
              workWidth: scaleNumber(screenItem.workWidth, "x"),
              workHeight: scaleNumber(screenItem.workHeight, "y"),
            }))
          }
          pretty = JSON.stringify(parsed, null, 2)
        } catch (_error) {
          // keep raw
        }
        const note = `${pretty}\n\nAll values are in image-coord space (the same coordinate system as system_screenshot pixels and mouse_*).`
        return {
          summary: `Screen info:\n${truncateForMessage(note, 4000)}`,
          extractedNote: note,
        }
      }

      case "mouse_move": {
        const physX = this.toPhysicalX(action.x)
        const physY = this.toPhysicalY(action.y)
        if (process.platform === "darwin") {
          await this.runMacMouseMove(physX, physY)
          return { summary: `Moved cursor to (${action.x}, ${action.y}).` }
        }
        await this.runInputScript(`Sylica-MouseMove ${physX} ${physY}`)
        return { summary: `Moved cursor to (${action.x}, ${action.y}).` }
      }

      case "mouse_click": {
        const button = action.button || "left"
        const times = action.double ? 2 : 1
        const hasTarget = action.x !== undefined && action.y !== undefined
        const physX = hasTarget ? this.toPhysicalX(action.x as number) : undefined
        const physY = hasTarget ? this.toPhysicalY(action.y as number) : undefined
        const args =
          hasTarget
            ? `Sylica-MouseClick -X ${physX} -Y ${physY} -Button '${button}' -Times ${times}`
            : `Sylica-MouseClick -Button '${button}' -Times ${times}`
        if (process.platform === "darwin") {
          await this.runMacMouseClick(physX, physY, button, times)
          const where = hasTarget ? `(${action.x}, ${action.y})` : "current cursor position"
          return {
            summary: `${action.double ? "Double-" : ""}${button}-clicked at ${where}.`,
          }
        }
        await this.runInputScript(args)
        const where = hasTarget ? `(${action.x}, ${action.y})` : "current cursor position"
        return {
          summary: `${action.double ? "Double-" : ""}${button}-clicked at ${where}.`,
        }
      }

      case "mouse_drag": {
        const button = action.button || "left"
        const fromX = this.toPhysicalX(action.fromX)
        const fromY = this.toPhysicalY(action.fromY)
        const toX = this.toPhysicalX(action.toX)
        const toY = this.toPhysicalY(action.toY)
        if (process.platform === "darwin") {
          await this.runMacMouseDrag(fromX, fromY, toX, toY, button)
          return {
            summary: `Dragged from (${action.fromX}, ${action.fromY}) to (${action.toX}, ${action.toY}) with ${button} button.`,
          }
        }
        await this.runInputScript(
          `Sylica-MouseDrag -FromX ${fromX} -FromY ${fromY} -ToX ${toX} -ToY ${toY} -Button '${button}'`
        )
        return {
          summary: `Dragged from (${action.fromX}, ${action.fromY}) to (${action.toX}, ${action.toY}) with ${button} button.`,
        }
      }

      case "mouse_scroll": {
        const hasTarget = action.x !== undefined && action.y !== undefined
        const physX = hasTarget ? this.toPhysicalX(action.x as number) : undefined
        const physY = hasTarget ? this.toPhysicalY(action.y as number) : undefined
        const args =
          hasTarget
            ? `Sylica-MouseScroll -Delta ${action.deltaY} -X ${physX} -Y ${physY}`
            : `Sylica-MouseScroll -Delta ${action.deltaY}`
        if (process.platform === "darwin") {
          await this.runMacMouseScroll(action.deltaY, physX, physY)
          return {
            summary: `Scrolled wheel by ${action.deltaY}${
              hasTarget ? ` at (${action.x}, ${action.y})` : ""
            }.`,
          }
        }
        await this.runInputScript(args)
        return {
          summary: `Scrolled wheel by ${action.deltaY}${
            hasTarget ? ` at (${action.x}, ${action.y})` : ""
          }.`,
        }
      }

      case "keyboard_type": {
        const delay = action.delayMs ?? 8
        if (process.platform === "darwin") {
          await this.runMacKeyboardType(action.text)
          const preview =
            action.text.length > 60 ? `${action.text.slice(0, 60)}...` : action.text
          return { summary: `Typed: ${JSON.stringify(preview)} (${action.text.length} chars).` }
        }
        const escaped = this.quoteForPowerShell(action.text)
        await this.runInputScript(`Sylica-Type -Text ${escaped} -DelayMs ${delay}`)
        const preview =
          action.text.length > 60 ? `${action.text.slice(0, 60)}...` : action.text
        return { summary: `Typed: ${JSON.stringify(preview)} (${action.text.length} chars).` }
      }

      case "keyboard_press": {
        if (process.platform === "darwin") {
          await this.runMacKeyboardPress(action.keys)
          return { summary: `Pressed ${action.keys}.` }
        }
        await this.runInputScript(`Sylica-Press -Combo ${this.quoteForPowerShell(action.keys)}`)
        return { summary: `Pressed ${action.keys}.` }
      }

      case "narrate": {
        return { summary: action.message }
      }

      default:
        throw new Error(`System executor cannot run ${(action as { type: string }).type}.`)
    }
  }

  private async runElevatedPowerShell(command: string): Promise<string> {
    const scriptPath = path.join(
      app.getPath("temp"),
      `sylica-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`
    )
    fs.writeFileSync(scriptPath, command, "utf8")

    const escapedScriptPath = scriptPath.replace(/'/g, "''")
    const launcher = `Start-Process -FilePath powershell.exe -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${escapedScriptPath}'`
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", launcher],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      }
    )
    child.unref()

    return "Opened an administrator PowerShell prompt. Approve the Windows UAC prompt to continue the elevated action."
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

Private planning checklist:
- Identify whether this is a browser task or a local PC task; do not use Chrome for local files/folders.
- Decide the exact next action, expected result, and how you will verify it.
- Check whether credentials, payment, secrets, destructive actions, or downloads require manual confirmation.
- Only expose a short statusMessage; do not reveal detailed chain-of-thought.

Rules:
- Return JSON only.
- Finish the task in the fewest safe steps.
- Use targetId values from the list instead of inventing selectors.
- For download tasks, click/download the correct button yourself. Do not finish by telling the user to click it.
- If the task asks to install after downloading, continue by listing Downloads and running the matching installer yourself when safe.
- You may use system_search_files, system_list_dir, system_open, or system_run_powershell after browser download steps when the task needs local PC follow-through.
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
    "type": "open_url|new_tab|switch_tab|close_tab|click|type|press_key|scroll|select_option|upload_file|download_file|wait_for|extract|system_open|system_list_dir|system_search_files|system_read_file|system_run_powershell|finish|request_secret_input",
    "url": "required when type is open_url",
    "targetId": "required for click/type/download_file when needed",
    "path": "required for system_list_dir/system_read_file",
    "query": "required for system_search_files",
    "command": "required for system_run_powershell"
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

    const response = await this.createComputerUseCompletion({
      model: COMPUTER_USE_MODEL,
      temperature: 0.1,
      max_tokens: 520,
      messages: [
        {
          role: "system",
          content:
            "You are a precise browser automation planner. Think privately, verify the next action, and output strict JSON only.",
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

    const response = await this.createComputerUseCompletion({
      model: COMPUTER_USE_MODEL,
      temperature: 0.05,
      max_tokens: 180,
      messages: [
        {
          role: "system",
          content:
            "You are a precise browser automation planner. Think privately, verify the first action, and return strict JSON only. On a blank/new tab, choose the fastest sensible first browser action.",
        },
        {
          role: "user",
          content: `Goal:\n${session.task}\n\nCurrent page is blank or a new tab.\nOpen tabs:\n${tabLines}\n\nReturn exactly:\n{\n  "thought": "short reasoning",\n  "statusMessage": "very short status for the UI",\n  "action": {\n    "type": "open_url|new_tab|switch_tab|request_secret_input|finish",\n    "url": "required when type is open_url"\n  }\n}\n\nRules:\n- Think privately before choosing the action.\n- If this is actually a local PC/file/folder task, finish with a short message that it should run in local computer mode.\n- Prefer open_url when the destination is obvious from the task.\n- Do not use click/type on a blank page.\n- If you need a signed-in site, still open its URL first.\n- Return JSON only.`,
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
    snapshot: BrowserSnapshot,
    task: string
  ): BrowserAgentAction {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("The browser planner did not return a valid action.")
    }

    const raw = value as Record<string, unknown>
    const type = sanitizeText(raw.type)
    const hasTarget = (targetId: string) =>
      snapshot.interactiveTargets.some((target) => target.targetId === targetId)

    switch (type) {
      case "open_url": {
        const url = sanitizeText(raw.url) || inferNavigationUrl(task) || ""
        if (!url) {
          throw new Error("Browser planner returned open_url without a URL.")
        }
        return { type, url }
      }
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
      case "system_open":
      case "system_list_dir":
      case "system_search_files":
      case "system_read_file":
      case "system_run_powershell":
      case "system_run_cmd":
      case "system_write_file":
      case "system_delete":
      case "system_copy":
      case "system_move":
      case "system_screenshot":
      case "system_get_state":
      case "screen_get_info":
      case "mouse_move":
      case "mouse_click":
      case "mouse_drag":
      case "mouse_scroll":
      case "keyboard_type":
      case "keyboard_press":
      case "narrate":
        return this.validateSystemAction(value)
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
        if (
          taskNeedsAutonomousBrowserWork(task) &&
          isLazyManualBrowserFinish(result)
        ) {
          const downloadTarget = findLikelyDownloadTarget(snapshot)
          if (downloadTarget) {
            return { type: "download_file", targetId: downloadTarget.targetId }
          }

          if (/\b(download|install|installer|setup)\b/i.test(task)) {
            return { type: "system_list_dir", path: path.join(os.homedir(), "Downloads") }
          }

          return { type: "scroll", direction: "down", amount: 900 }
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
    if (isSystemComputerAction(action)) {
      return describeComputerAction(action)
    }

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
        await wait(2500)
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
      default:
        throw new Error(
          `Browser executor cannot run ${(action as { type: string }).type}.`
        )
    }
  }
}

export { COMPUTER_USE_STATE_EVENT }
