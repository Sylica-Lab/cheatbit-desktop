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
    return null
  }

  const displayScreenshots = screenshots.slice(0, 5)

  return (
    <div className="sylica-liquid-panel rounded-[24px] p-3">
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
