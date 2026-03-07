export function measureElementContentSize(element: HTMLElement): {
  width: number
  height: number
} {
  const rect = element.getBoundingClientRect()

  return {
    width: Math.max(1, Math.ceil(Math.max(rect.width, element.scrollWidth))),
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
    width: width + (extras.width ?? 0),
    height: height + (extras.height ?? 0)
  })
}
