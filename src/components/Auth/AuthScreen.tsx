import { useEffect, useRef, useState, type FormEvent } from "react"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { updateWindowToElement } from "../../utils/contentSize"
import type { AuthState } from "../../../shared/backendAuth"

interface AuthScreenProps {
  initialError?: string
  onAuthenticated: (state: AuthState) => void
}

type AuthMode = "login" | "register"

export function AuthScreen({
  initialError,
  onAuthenticated,
}: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>("login")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState(initialError || "")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setError(initialError || "")
  }, [initialError])

  useEffect(() => {
    if (!containerRef.current) return

    const updateDimensions = () => {
      if (!containerRef.current) return
      updateWindowToElement(containerRef.current, { width: 28, height: 28 })
    }

    updateDimensions()

    const resizeObserver = new ResizeObserver(updateDimensions)
    resizeObserver.observe(containerRef.current)

    return () => resizeObserver.disconnect()
  }, [])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setIsSubmitting(true)
    setError("")

    try {
      const authState =
        mode === "login"
          ? await window.electronAPI.login({ email, password })
          : await window.electronAPI.register({ name, email, password })

      onAuthenticated(authState)
    } catch (submitError) {
      const message =
        submitError instanceof Error
          ? submitError.message
          : "Authentication failed."
      setError(message)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div
      ref={containerRef}
      data-size-root="true"
      className="inline-flex items-center justify-center bg-transparent p-4"
    >
      <div className="overflow-hidden rounded-[28px] border border-white/10 bg-black/85 shadow-2xl shadow-black/40">
        <div className="grid max-w-4xl gap-0 md:grid-cols-[1.05fr_0.95fr]">
          <section className="relative overflow-hidden border-b border-white/10 bg-[radial-gradient(circle_at_top_left,_rgba(125,249,199,0.18),_transparent_34%),linear-gradient(180deg,_rgba(255,255,255,0.04),_rgba(255,255,255,0.01))] px-6 py-6 md:border-b-0 md:border-r">
            <div className="absolute inset-0 bg-[linear-gradient(135deg,transparent_0%,rgba(255,255,255,0.03)_48%,transparent_100%)]" />
            <div className="relative space-y-6">
              <div className="space-y-3">
                <span className="inline-flex rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] uppercase tracking-[0.24em] text-[#7df9c7]">
                  Account Required
                </span>
                <div>
                  <h1 className="text-3xl font-semibold tracking-[-0.04em] text-white">
                    CheatBit
                  </h1>
                  <p className="mt-2 max-w-md text-sm leading-6 text-white/65">
                    Sign in to use CheatBit. Your screenshots, solves, follow-up
                    chat, subscription, and usage history stay tied to your account.
                  </p>
                </div>
              </div>

              <div className="grid gap-3">
                <div className="rounded-2xl border border-white/10 bg-black/35 p-4">
                  <div className="text-xs uppercase tracking-[0.18em] text-white/45">
                    Your Activity
                  </div>
                  <div className="mt-2 text-sm text-white/85">
                    Screenshots, solves, debug runs, and follow-up chat are saved
                    against your account.
                  </div>
                </div>
                <div className="rounded-2xl border border-white/10 bg-black/35 p-4">
                  <div className="text-xs uppercase tracking-[0.18em] text-white/45">
                    Billing
                  </div>
                  <div className="mt-2 text-sm text-white/85">
                    View your subscription, unlimited access, renewal status, and
                    recent usage from your dashboard.
                  </div>
                </div>
                <div className="rounded-2xl border border-white/10 bg-black/35 p-4">
                  <div className="text-xs uppercase tracking-[0.18em] text-white/45">
                    Account Limits
                  </div>
                  <div className="mt-2 text-sm text-white/85">
                    Your account is checked before processing starts so access,
                    limits, and usage stay synced to you.
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="w-full max-w-[420px] px-6 py-6">
            <div className="mb-5 flex gap-2 rounded-full border border-white/10 bg-white/5 p-1">
              <button
                type="button"
                className={`flex-1 rounded-full px-3 py-2 text-sm transition-colors ${
                  mode === "login"
                    ? "bg-white text-black"
                    : "text-white/70 hover:text-white"
                }`}
                onClick={() => setMode("login")}
              >
                Login
              </button>
              <button
                type="button"
                className={`flex-1 rounded-full px-3 py-2 text-sm transition-colors ${
                  mode === "register"
                    ? "bg-white text-black"
                    : "text-white/70 hover:text-white"
                }`}
                onClick={() => setMode("register")}
              >
                Register
              </button>
            </div>

            <form className="space-y-4" onSubmit={handleSubmit}>
              <div className="space-y-1">
                <h2 className="text-xl font-semibold tracking-[-0.03em] text-white">
                  {mode === "login" ? "Sign in to continue" : "Create an account"}
                </h2>
                <p className="text-sm text-white/55">
                  {mode === "login"
                    ? "Use your CheatBit account to continue with your saved activity and subscription."
                    : "Create your CheatBit account to track usage, billing, and access in one place."}
                </p>
              </div>

              {mode === "register" && (
                <div className="space-y-2">
                  <label className="text-xs uppercase tracking-[0.18em] text-white/45">
                    Full Name
                  </label>
                  <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Ada Lovelace"
                    className="h-11 rounded-2xl border-white/10 bg-white/5 text-white placeholder:text-white/25"
                  />
                </div>
              )}

              <div className="space-y-2">
                <label className="text-xs uppercase tracking-[0.18em] text-white/45">
                  Email
                </label>
                <Input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  className="h-11 rounded-2xl border-white/10 bg-white/5 text-white placeholder:text-white/25"
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs uppercase tracking-[0.18em] text-white/45">
                  Password
                </label>
                <Input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Minimum 8 characters"
                  className="h-11 rounded-2xl border-white/10 bg-white/5 text-white placeholder:text-white/25"
                />
              </div>

              {error ? (
                <div className="rounded-2xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                  {error}
                </div>
              ) : null}

              <Button
                type="submit"
                disabled={isSubmitting}
                className="h-11 w-full rounded-2xl bg-white text-black hover:bg-white/90"
              >
                {isSubmitting
                  ? "Please wait..."
                  : mode === "login"
                  ? "Login"
                  : "Register"}
              </Button>
            </form>
          </section>
        </div>
      </div>
    </div>
  )
}
