import React from "react"
import ScreenshotItem from "./ScreenshotItem"

interface Screenshot {
  path: string
  preview: string
}

interface ScreenshotQueueProps {
  isLoading: boolean
  screenshots: Screenshot[]
  onDeleteScreenshot: (index: number) => void
}
const ScreenshotQueue: React.FC<ScreenshotQueueProps> = ({
  isLoading,
  screenshots,
  onDeleteScreenshot
}) => {
  if (screenshots.length === 0) {
    return <></>
  }

  const displayScreenshots = screenshots.slice(0, 5)

  return (
    <div className="rounded-[18px] border border-white/10 bg-black/[0.82] p-3 shadow-[0_18px_38px_rgba(0,0,0,0.24)] backdrop-blur-md">
      <div className="flex gap-3">
        {displayScreenshots.map((screenshot, index) => (
          <ScreenshotItem
            key={screenshot.path}
            isLoading={isLoading}
            screenshot={screenshot}
            index={index}
            onDelete={onDeleteScreenshot}
          />
        ))}
      </div>
    </div>
  )
}

export default ScreenshotQueue
