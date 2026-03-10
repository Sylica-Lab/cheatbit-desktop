import React, { useState, useEffect, useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import ScreenshotQueue from "../components/Queue/ScreenshotQueue"
import QueueCommands from "../components/Queue/QueueCommands"
import { useToast } from "../contexts/toast"
import { GeneralChatPanel } from "../components/Chat/GeneralChatPanel"
import { Screenshot } from "../types/screenshots"
import { updateWindowToElement } from "../utils/contentSize"
import { getProcessingToastCopy } from "../utils/processingErrors"
import {
  type ComputerUseState,
  type LiveInterviewState,
  EMPTY_COMPUTER_USE_STATE,
  EMPTY_LIVE_INTERVIEW_STATE,
} from "../../shared/followUpChat"
import type { DesktopUpdateState } from "../../shared/desktopUpdates"

async function fetchScreenshots(): Promise<Screenshot[]> {
  try {
    const existing = await window.electronAPI.getScreenshots()
    return existing
  } catch (error) {
    console.error("Error loading screenshots:", error)
    throw error
  }
}

interface QueueProps {
  setView: (view: "queue" | "solutions" | "debug") => void
  credits: number
  currentLanguage: string
  setLanguage: (language: string) => void
  desktopUpdateState: DesktopUpdateState
  onDownloadUpdate: () => Promise<{ success: true } | { success: false; error: string }>
  onInstallUpdate: () => Promise<{ success: true } | { success: false; error: string }>
}

const Queue: React.FC<QueueProps> = ({
  setView,
  credits,
  desktopUpdateState,
  onDownloadUpdate,
  onInstallUpdate,
}) => {
  const { showToast } = useToast()

  const [isTooltipVisible, setIsTooltipVisible] = useState(false)
  const [tooltipHeight, setTooltipHeight] = useState(0)
  const [activeMode, setActiveMode] = useState<"analyze" | "chat">("analyze")
  const [isMinimized, setIsMinimized] = useState(false)
  const [computerUseState, setComputerUseState] = useState<ComputerUseState>(
    EMPTY_COMPUTER_USE_STATE
  )
  const [computerTaskRequest, setComputerTaskRequest] = useState<{
    id: string
    task: string
  } | null>(null)
  const [liveInterviewState, setLiveInterviewState] = useState<LiveInterviewState>(
    EMPTY_LIVE_INTERVIEW_STATE
  )
  const contentRef = useRef<HTMLDivElement>(null)

  const isComputerTaskActive =
    computerUseState.status === "starting" ||
    computerUseState.status === "running" ||
    computerUseState.status === "waiting_for_secret" ||
    computerUseState.status === "stopping"

  const {
    data: screenshots = [],
    refetch
  } = useQuery<Screenshot[]>({
    queryKey: ["screenshots"],
    queryFn: fetchScreenshots,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false
  })

  const handleDeleteScreenshot = async (index: number) => {
    const screenshotToDelete = screenshots[index]

    try {
      const response = await window.electronAPI.deleteScreenshot(
        screenshotToDelete.path
      )

      if (response.success) {
        refetch() // Refetch screenshots instead of managing state directly
      } else {
        console.error("Failed to delete screenshot:", response.error)
        showToast("Error", "Failed to delete the screenshot file", "error")
      }
    } catch (error) {
      console.error("Error deleting screenshot:", error)
    }
  }

  useEffect(() => {
    let cancelled = false

    const loadLiveInterviewState = async () => {
      const response = await window.electronAPI.getLiveInterviewState()
      if (!cancelled && response.success) {
        setLiveInterviewState(response.data.state)
      }
    }

    const loadComputerUseState = async () => {
      const response = await window.electronAPI.getComputerUseState()
      if (!cancelled && response.success) {
        setComputerUseState(response.data.state)
      }
    }

    void loadLiveInterviewState()
    void loadComputerUseState()

    const unsubscribe = window.electronAPI.onLiveInterviewState((state) => {
      setLiveInterviewState(state)
    })
    const unsubscribeComputerUse = window.electronAPI.onComputerUseState((state) => {
      setComputerUseState(state)
    })

    return () => {
      cancelled = true
      unsubscribe()
      unsubscribeComputerUse()
    }
  }, [])

  useEffect(() => {
    if (liveInterviewState.status !== "idle" && activeMode !== "chat") {
      setActiveMode("chat")
    }
  }, [activeMode, liveInterviewState.status])

  useEffect(() => {
    // Height update logic
    const updateDimensions = () => {
      if (contentRef.current) {
        updateWindowToElement(
          contentRef.current,
          { height: isTooltipVisible ? tooltipHeight : 0 }
        )
      }
    }

    // Initialize resize observer
    const resizeObserver = new ResizeObserver(updateDimensions)
    if (contentRef.current) {
      resizeObserver.observe(contentRef.current)
    }
    updateDimensions()

    // Set up event listeners
    const cleanupFunctions = [
      window.electronAPI.onScreenshotTaken(() => refetch()),
      window.electronAPI.onResetView(() => refetch()),
      window.electronAPI.onDeleteLastScreenshot(async () => {
        if (screenshots.length > 0) {
          await handleDeleteScreenshot(screenshots.length - 1);
          // Toast removed as requested
        } else {
          showToast("No Screenshots", "There are no screenshots to delete", "neutral");
        }
      }),
      window.electronAPI.onSolutionError((error: string) => {
        const toastCopy = getProcessingToastCopy(error)
        showToast(
          toastCopy.title,
          toastCopy.message,
          "error"
        )
        setView("queue") // Revert to queue if processing fails
        console.error("Processing error:", error)
      }),
      window.electronAPI.onProcessingNoScreenshots(() => {
        showToast(
          "No Screenshots",
          "There are no screenshots to process.",
          "neutral"
        )
      }),
      // Removed out of credits handler - unlimited credits in this version
    ]

    return () => {
      resizeObserver.disconnect()
      cleanupFunctions.forEach((cleanup) => cleanup())
    }
  }, [isTooltipVisible, tooltipHeight, screenshots])

  useEffect(() => {
    const updateDimensions = () => {
      if (!contentRef.current) {
        return
      }

      updateWindowToElement(contentRef.current, {
        height: isTooltipVisible ? tooltipHeight : 0,
      })
    }

    updateDimensions()
    const animationFrameId = window.requestAnimationFrame(updateDimensions)
    const delayedUpdateId = window.setTimeout(updateDimensions, 120)

    return () => {
      window.cancelAnimationFrame(animationFrameId)
      window.clearTimeout(delayedUpdateId)
    }
  }, [
    activeMode,
    isMinimized,
    isTooltipVisible,
    tooltipHeight,
    liveInterviewState.status,
  ])

  const handleTooltipVisibilityChange = (visible: boolean, height: number) => {
    setIsTooltipVisible(visible)
    setTooltipHeight(height)
  }

  const handleModeChange = (nextMode: "analyze" | "chat") => {
    if (liveInterviewState.status !== "idle" && nextMode === "analyze") {
      showToast(
        "Live Interview",
        "Stop Live Interview before leaving chat.",
        "neutral"
      )
      return
    }

    setActiveMode(nextMode)
  }

  const handleStartComputerTask = async (task: string) => {
    if (liveInterviewState.status !== "idle") {
      showToast(
        "Computer Use",
        "Stop Live Interview before starting browser control.",
        "neutral"
      )
      return
    }

    if (isComputerTaskActive) {
      showToast(
        "Computer Use",
        "A browser task is already running.",
        "neutral"
      )
      return
    }

    setActiveMode("chat")
    setComputerTaskRequest({
      id: `${Date.now()}`,
      task,
    })
  }

  const handleStopComputerTask = async () => {
    const response = await window.electronAPI.stopComputerUseTask()
    if (!response.success) {
      showToast(
        "Computer Use",
        response.error || "Failed to stop browser task.",
        "error"
      )
    }
  }

  const handleResumeComputerTask = async () => {
    const response = await window.electronAPI.resumeComputerUseAfterSecret()
    if (!response.success) {
      showToast(
        "Computer Use",
        response.error || "Failed to resume browser task.",
        "error"
      )
    }
  }

  return (
    <div
      ref={contentRef}
      className={`inline-flex flex-col items-start bg-transparent ${
        isMinimized ? "" : "min-w-[320px]"
      }`}
    >
      <div className={isMinimized ? "p-0" : "px-4 py-3"}>
        <div className={isMinimized ? "" : "space-y-3"}>
          {!isMinimized && (
            <div key={activeMode} className="sylica-panel-switch w-full">
              {activeMode === "analyze" ? (
                <ScreenshotQueue
                  isLoading={false}
                  screenshots={screenshots}
                  onDeleteScreenshot={handleDeleteScreenshot}
                />
              ) : (
                <GeneralChatPanel computerTaskRequest={computerTaskRequest} />
              )}
            </div>
          )}

          <QueueCommands
            activeMode={activeMode}
            onModeChange={handleModeChange}
            onTooltipVisibilityChange={handleTooltipVisibilityChange}
            screenshotCount={screenshots.length}
            credits={credits}
            desktopUpdateState={desktopUpdateState}
            isMinimized={isMinimized}
            computerUseState={computerUseState}
            modeSwitchLocked={
              liveInterviewState.status !== "idle" && activeMode === "chat"
            }
            onDownloadUpdate={onDownloadUpdate}
            onInstallUpdate={onInstallUpdate}
            onStartComputerTask={handleStartComputerTask}
            onStopComputerTask={handleStopComputerTask}
            onResumeComputerTask={handleResumeComputerTask}
            onToggleMinimized={() => {
              handleTooltipVisibilityChange(false, 0)
              setIsMinimized((current) => !current)
            }}
          />
        </div>
      </div>
    </div>
  )
}

export default Queue
