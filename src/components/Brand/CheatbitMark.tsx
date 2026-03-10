import logoUrl from "../../../assets/icons/logo.svg"

interface CheatbitMarkProps {
  className?: string
  rotating?: boolean
}

export function CheatbitMark({
  className = "h-10 w-10",
  rotating = false,
}: CheatbitMarkProps) {
  return (
    <div
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-[18px] border border-white/10 bg-white/[0.04] p-1 shadow-[0_18px_40px_rgba(0,0,0,0.35)] ${className}`}
    >
      <img
        src={logoUrl}
        alt="Sylica AI"
        className={`h-full w-full object-contain ${rotating ? "sylica-logo-spin" : ""}`}
        draggable={false}
      />
    </div>
  )
}
