export function measureElementContentSize(element: HTMLElement): {
  width: number
  height: number
} {
  const rect = element.getBoundingClientRect()
  const scrollWidth = element.scrollWidth
  const clientWidth = element.clientWidth

  return {
    width: Math.max(
      1,
      Math.ceil(Math.max(rect.width, scrollWidth, clientWidth))
    ),
    height: Math.max(1, Math.ceil(Math.max(rect.height, element.scrollHeight)))
  }
}

function resolveWindowSizeTarget(element: HTMLElement): HTMLElement {
  const appShell = document.querySelector(
    "[data-app-shell='true'][data-aux-open='true']"
  ) as HTMLElement | null

  return appShell || element
}

export function updateWindowToElement(
  element: HTMLElement,
  extras: {
    width?: number
    height?: number
  } = {}
): void {
  const target = resolveWindowSizeTarget(element)
  const { width, height } = measureElementContentSize(target)

  window.electronAPI?.updateContentDimensions({
    width: width + 4 + (extras.width ?? 0),
    height: height + 4 + (extras.height ?? 0)
  })
}
