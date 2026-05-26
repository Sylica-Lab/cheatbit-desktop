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

function measureVisibleSizeBoxes(element: HTMLElement): {
  width: number
  height: number
} | null {
  const boxes = Array.from(
    element.querySelectorAll("[data-sylica-size-box='true']")
  ).filter((node): node is HTMLElement => node instanceof HTMLElement)

  if (boxes.length === 0) {
    return null
  }

  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY

  boxes.forEach((box) => {
    const rect = box.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      return
    }

    left = Math.min(left, rect.left)
    top = Math.min(top, rect.top)
    right = Math.max(right, rect.right)
    bottom = Math.max(bottom, rect.bottom)
  })

  if (
    !Number.isFinite(left) ||
    !Number.isFinite(top) ||
    !Number.isFinite(right) ||
    !Number.isFinite(bottom)
  ) {
    return null
  }

  return {
    width: Math.max(1, Math.ceil(right - left)),
    height: Math.max(1, Math.ceil(bottom - top)),
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
  const visibleSize =
    target === element ? measureVisibleSizeBoxes(target) : null
  const { width, height } = visibleSize || measureElementContentSize(target)

  window.electronAPI?.updateContentDimensions({
    width: width + 8 + (extras.width ?? 0),
    height: height + 8 + (extras.height ?? 0)
  })
}
