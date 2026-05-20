import type { CSSProperties, ReactNode } from "react"
import {
  Eye,
  Focus,
  Grid2X2,
  Laptop,
  Radio,
  ScanSearch,
  Smartphone,
} from "lucide-react"
import { CheatbitMark } from "../Brand/CheatbitMark"
import { COMMAND_KEY } from "../../utils/platform"

type SylicaDockMode = "analyze" | "solve" | "live" | "vision" | "phone" | "apps"

interface SylicaShortcutDockProps {
  activeMode?: SylicaDockMode
  analyzeLabel?: string
  solveLabel?: string
  liveLabel?: string
  showSolve?: boolean
  isVisionActive?: boolean
  className?: string
  style?: CSSProperties
  noDragStyle?: CSSProperties
  onLogoClick?: () => void
  onSelectArea?: () => void
  onAnalyze?: () => void
  onSolve?: () => void
  onLive?: () => void
  onComputer?: () => void
  onVision?: () => void
  onPhone?: () => void
  onApps?: () => void
}

function DockButton({
  children,
  title,
  ariaLabel,
  active = false,
  accent = false,
  className = "",
  style,
  onClick,
}: {
  children: ReactNode
  title: string
  ariaLabel: string
  active?: boolean
  accent?: boolean
  className?: string
  style?: CSSProperties
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel}
      onClick={onClick}
      style={style}
      className={`group relative flex shrink-0 items-center justify-center overflow-hidden rounded-full border text-[12px] font-semibold tracking-[-0.02em] transition duration-200 ${
        active
          ? "border-white/35 bg-[linear-gradient(180deg,#f4fbff_0%,#dce6ea_100%)] text-[#111820] shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_8px_18px_rgba(0,0,0,0.28)]"
          : "border-white/[0.075] bg-[linear-gradient(180deg,rgba(255,255,255,0.075),rgba(255,255,255,0.035))] text-white/78 shadow-[inset_0_1px_0_rgba(255,255,255,0.09)] hover:border-white/14 hover:bg-white/[0.075] hover:text-white"
      } ${accent ? "text-[#f1d873]" : ""} ${className}`}
    >
      {children}
    </button>
  )
}

function KeyCap({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-[9px] border border-white/12 bg-white/[0.07] px-[5px] py-[3px] text-[9px] font-bold leading-none text-white/62 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
      {children}
    </span>
  )
}

export function SylicaShortcutDock({
  activeMode = "solve",
  analyzeLabel = "Analyze",
  solveLabel = "Solve",
  liveLabel = "Live",
  showSolve = true,
  isVisionActive = true,
  className = "",
  style,
  noDragStyle,
  onLogoClick,
  onSelectArea,
  onAnalyze,
  onSolve,
  onLive,
  onComputer,
  onVision,
  onPhone,
  onApps,
}: SylicaShortcutDockProps) {
  const buttonStyle = noDragStyle

  return (
    <div
      data-sylica-size-box="true"
      style={style}
      className={`relative inline-flex h-[62px] items-center rounded-full border border-white/[0.09] bg-[linear-gradient(180deg,#202b30_0%,#11171c_52%,#0d1116_100%)] px-[10px] py-[7px] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.14),inset_0_-1px_0_rgba(0,0,0,0.5),0_10px_28px_rgba(0,0,0,0.22)] backdrop-blur-2xl ${className}`}
    >
      <div className="pointer-events-none absolute inset-[1px] rounded-full bg-[radial-gradient(ellipse_at_8%_0%,rgba(125,249,199,0.13),transparent_30%),radial-gradient(ellipse_at_82%_0%,rgba(139,231,255,0.09),transparent_32%),linear-gradient(180deg,rgba(255,255,255,0.075),transparent_44%)]" />
      <div className="relative flex h-full items-center gap-[8px]">
        <button
          type="button"
          title="Sylica"
          aria-label="Sylica"
          onClick={onLogoClick}
          style={buttonStyle}
          className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-full border border-white/[0.08] bg-[linear-gradient(180deg,rgba(255,255,255,0.07),rgba(255,255,255,0.025))] shadow-[inset_0_1px_0_rgba(255,255,255,0.09)] transition hover:bg-white/[0.08]"
        >
          <CheatbitMark
            className="h-[30px] w-[30px] rounded-full border-0 bg-transparent p-0 shadow-none"
            rotating
          />
        </button>

        <DockButton
          title="Select Area"
          ariaLabel="Select Area"
          className="h-[38px] w-[38px]"
          style={buttonStyle}
          onClick={onSelectArea}
        >
          <Focus className="h-[15px] w-[15px]" />
        </DockButton>

        <DockButton
          title={`Analyze (${COMMAND_KEY}+H)`}
          ariaLabel={`Analyze (${COMMAND_KEY}+H)`}
          active={activeMode === "analyze"}
          className="h-[38px] min-w-[106px] gap-[8px] px-[12px]"
          style={buttonStyle}
          onClick={onAnalyze}
        >
          <span>{analyzeLabel}</span>
          <span className="flex items-center gap-[3px]">
            <KeyCap>{COMMAND_KEY}</KeyCap>
            <KeyCap>H</KeyCap>
          </span>
        </DockButton>

        {showSolve && (
          <DockButton
            title="Solve"
            ariaLabel="Solve"
            active={activeMode === "solve"}
            className="h-[44px] min-w-[82px] gap-[7px] px-[13px]"
            style={buttonStyle}
            onClick={onSolve}
          >
            <ScanSearch className="h-[14px] w-[14px]" />
            <span>{solveLabel}</span>
          </DockButton>
        )}

        <DockButton
          title="Live"
          ariaLabel="Live"
          active={activeMode === "live"}
          className="h-[38px] min-w-[82px] gap-[7px] px-[13px]"
          style={buttonStyle}
          onClick={onLive}
        >
          <Radio className="h-[13px] w-[13px]" />
          <span>{liveLabel}</span>
        </DockButton>

        <DockButton
          title="Computer Use"
          ariaLabel="Computer Use"
          active={activeMode === "vision"}
          className="h-[38px] w-[38px]"
          style={buttonStyle}
          onClick={onComputer}
        >
          <Laptop className="h-[16px] w-[16px]" />
        </DockButton>

        <DockButton
          title="Vision"
          ariaLabel="Vision"
          accent={isVisionActive}
          className="h-[38px] w-[38px]"
          style={buttonStyle}
          onClick={onVision}
        >
          <Eye className="h-[16px] w-[16px]" />
        </DockButton>

        <DockButton
          title="Phone"
          ariaLabel="Phone"
          active={activeMode === "phone"}
          className="h-[38px] w-[38px]"
          style={buttonStyle}
          onClick={onPhone}
        >
          <Smartphone className="h-[16px] w-[16px]" />
        </DockButton>

        <DockButton
          title="Apps"
          ariaLabel="Apps"
          active={activeMode === "apps"}
          className="h-[38px] w-[38px]"
          style={buttonStyle}
          onClick={onApps}
        >
          <Grid2X2 className="h-[16px] w-[16px]" />
        </DockButton>
      </div>
    </div>
  )
}
