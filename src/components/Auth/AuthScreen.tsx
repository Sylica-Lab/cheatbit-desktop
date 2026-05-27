import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "../ui/button"
import { updateWindowToElement } from "../../utils/contentSize"
import type { AuthState } from "../../../shared/backendAuth"
import { CheatbitMark } from "../Brand/CheatbitMark"

interface AuthScreenProps {
  initialError?: string
  onAuthenticated: (state: AuthState) => void
}

export function AuthScreen({
  initialError,
  onAuthenticated,
}: AuthScreenProps) {
  const [error, setError] = useState(initialError || "")
  const [status, setStatus] = useState("Opening Sylica in your browser...")
  const [isOpening, setIsOpening] = useState(false)
  const [isChecking, setIsChecking] = useState(false)
  const didAutoOpenRef = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setError(initialError || "")
  }, [initialError])

  useEffect(() => {
    if (!containerRef.current) return

    const updateDimensions = () => {
      if (!containerRef.current) return
      updateWindowToElement(containerRef.current, { width: 24, height: 24 })
    }

    updateDimensions()

    const resizeObserver = new ResizeObserver(updateDimensions)
    resizeObserver.observe(containerRef.current)

    return () => resizeObserver.disconnect()
  }, [])

  const openWebsiteLogin = useCallback(async () => {
    setIsOpening(true)
    setError("")
    setStatus("Opening Sylica in your browser...")

    try {
      const result = await window.electronAPI.startWebLogin()
      if (!result.success) {
        setError(result.error || "Could not open Sylica in your browser.")
        setStatus("Open the website manually if the browser did not appear.")
        return
      }

      setStatus("Finish login or signup in the browser. Sylica will return here automatically.")
    } catch (openError) {
      setError(
        openError instanceof Error
          ? openError.message
          : "Could not open Sylica in your browser."
      )
      setStatus("Open the website manually if the browser did not appear.")
    } finally {
      setIsOpening(false)
    }
  }, [])

  const refreshAuthState = useCallback(async () => {
    setIsChecking(true)
    setError("")

    try {
      const nextAuthState = await window.electronAPI.getAuthState()
      if (nextAuthState.authenticated) {
        onAuthenticated(nextAuthState)
        return
      }

      setStatus("Still waiting for website login to finish.")
      if (nextAuthState.error) {
        setError(nextAuthState.error)
      }
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "Could not check login status."
      )
    } finally {
      setIsChecking(false)
    }
  }, [onAuthenticated])

  useEffect(() => {
    if (didAutoOpenRef.current) return
    didAutoOpenRef.current = true

    const timeout = window.setTimeout(() => {
      void openWebsiteLogin()
    }, 350)

    return () => window.clearTimeout(timeout)
  }, [openWebsiteLogin])

  return (
    <div
      ref={containerRef}
      data-size-root="true"
      className="inline-flex items-center justify-center bg-transparent p-4"
    >
      <div className="w-[430px] overflow-hidden rounded-[28px] border border-white/10 bg-black/[0.88] shadow-2xl shadow-black/40 backdrop-blur-xl">
        <section className="relative overflow-hidden bg-[radial-gradient(circle_at_top_left,_rgba(125,249,199,0.18),_transparent_36%),linear-gradient(180deg,_rgba(255,255,255,0.055),_rgba(255,255,255,0.015))] px-6 py-6">
          <div className="absolute inset-0 bg-[linear-gradient(135deg,transparent_0%,rgba(255,255,255,0.04)_48%,transparent_100%)]" />
          <div className="relative space-y-5">
            <div className="flex items-start gap-3">
              <CheatbitMark className="h-12 w-12 rounded-[20px]" />
              <div>
                <span className="inline-flex rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] uppercase tracking-[0.22em] text-[#7df9c7]">
                  Account Required
                </span>
                <h1 className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-white">
                  Continue with Sylica
                </h1>
                <p className="mt-2 text-sm leading-6 text-white/62">
                  Login and signup happen on sylicaai.com. After the browser
                  confirms your account, the desktop app will unlock automatically.
                </p>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-white/75">
              {status}
            </div>

            {error ? (
              <div className="rounded-2xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                {error}
              </div>
            ) : null}

            <div className="grid gap-2">
              <Button
                type="button"
                disabled={isOpening}
                onClick={() => void openWebsiteLogin()}
                className="h-11 w-full rounded-2xl bg-white text-black hover:bg-white/90"
              >
                {isOpening ? "Opening..." : "Login or sign up on website"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={isChecking}
                onClick={() => void refreshAuthState()}
                className="h-10 w-full rounded-2xl border border-white/10 bg-white/5 text-white/75 hover:bg-white/10 hover:text-white"
              >
                {isChecking ? "Checking..." : "I finished login"}
              </Button>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
