export function getProcessingToastCopy(error?: string): {
  title: string
  message: string
} {
  const normalizedError = (error || "").trim().toLowerCase()

  if (
    normalizedError.includes("failed to identify a usable question") ||
    normalizedError.includes("no clear question")
  ) {
    return {
      title: "No Clear Question",
      message:
        "No clear question was found in the screenshot. Try a clearer screenshot or include more of the prompt.",
    }
  }

  if (normalizedError.includes("failed to identify any usable content")) {
    return {
      title: "No Readable Content",
      message:
        "No readable content was found in the screenshot. Try a clearer screenshot or include more of the visible content.",
    }
  }

  return {
    title: "Processing Failed",
    message: (error || "There was an error processing your screenshots.").trim(),
  }
}
