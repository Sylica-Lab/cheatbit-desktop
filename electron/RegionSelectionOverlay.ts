import { BrowserWindow, ipcMain, screen } from "electron"

export interface ScreenRegionSelection {
  captureDisplayIndex: number
  displayBounds: {
    width: number
    height: number
  }
  displayOrigin: {
    x: number
    y: number
  }
  region: {
    x: number
    y: number
    width: number
    height: number
  }
}

function getOrderedElectronDisplays() {
  const displays = [...screen.getAllDisplays()]

  if (process.platform === "darwin") {
    const primaryDisplay = screen.getPrimaryDisplay()
    return displays.sort((left, right) => {
      const leftPrimary = left.id === primaryDisplay.id ? 0 : 1
      const rightPrimary = right.id === primaryDisplay.id ? 0 : 1

      if (leftPrimary !== rightPrimary) {
        return leftPrimary - rightPrimary
      }

      if (left.bounds.x !== right.bounds.x) {
        return left.bounds.x - right.bounds.x
      }

      return left.bounds.y - right.bounds.y
    })
  }

  return displays.sort((left, right) => {
    if (left.bounds.x !== right.bounds.x) {
      return left.bounds.x - right.bounds.x
    }

    return left.bounds.y - right.bounds.y
  })
}

function buildOverlayHtml(
  resultChannel: string,
  cancelChannel: string
): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Select Area</title>
    <style>
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: rgba(3, 5, 8, 0.22);
        cursor: crosshair;
        user-select: none;
        font-family: sans-serif;
      }

      #root {
        position: relative;
        width: 100%;
        height: 100%;
      }

      #hint {
        position: absolute;
        top: 18px;
        left: 18px;
        padding: 10px 12px;
        border-radius: 12px;
        background: rgba(5, 7, 10, 0.72);
        border: 1px solid rgba(255, 255, 255, 0.12);
        color: rgba(255, 255, 255, 0.92);
        font-size: 12px;
        line-height: 1.45;
        backdrop-filter: blur(12px);
      }

      #selection {
        position: absolute;
        display: none;
        border: 1px solid rgba(125, 249, 199, 0.95);
        background: rgba(125, 249, 199, 0.14);
        box-shadow: 0 0 0 9999px rgba(4, 6, 9, 0.38);
      }

      #size {
        position: absolute;
        top: -24px;
        right: 0;
        padding: 4px 6px;
        border-radius: 8px;
        background: rgba(5, 7, 10, 0.85);
        color: white;
        font-size: 11px;
      }
    </style>
  </head>
  <body>
    <div id="root">
      <div id="hint">Drag to select an area. Press Esc or right click to cancel.</div>
      <div id="selection">
        <div id="size"></div>
      </div>
    </div>
    <script>
      const { ipcRenderer } = require("electron");
      const selection = document.getElementById("selection");
      const sizeTag = document.getElementById("size");

      let startPoint = null;
      let latestRect = null;
      let isDragging = false;

      const normalizeRect = (firstPoint, secondPoint) => {
        const x = Math.min(firstPoint.x, secondPoint.x);
        const y = Math.min(firstPoint.y, secondPoint.y);
        const width = Math.abs(secondPoint.x - firstPoint.x);
        const height = Math.abs(secondPoint.y - firstPoint.y);
        return { x, y, width, height };
      };

      const renderRect = (rect) => {
        selection.style.display = "block";
        selection.style.left = rect.x + "px";
        selection.style.top = rect.y + "px";
        selection.style.width = rect.width + "px";
        selection.style.height = rect.height + "px";
        sizeTag.textContent = Math.round(rect.width) + " × " + Math.round(rect.height);
      };

      window.addEventListener("mousedown", (event) => {
        if (event.button !== 0) {
          return;
        }

        isDragging = true;
        startPoint = { x: event.clientX, y: event.clientY };
        latestRect = { x: event.clientX, y: event.clientY, width: 0, height: 0 };
        renderRect(latestRect);
      });

      window.addEventListener("mousemove", (event) => {
        if (!isDragging || !startPoint) {
          return;
        }

        latestRect = normalizeRect(startPoint, {
          x: event.clientX,
          y: event.clientY,
        });
        renderRect(latestRect);
      });

      window.addEventListener("mouseup", (event) => {
        if (event.button !== 0 || !isDragging || !latestRect) {
          return;
        }

        isDragging = false;

        if (latestRect.width < 10 || latestRect.height < 10) {
          ipcRenderer.send("${cancelChannel}");
          return;
        }

        ipcRenderer.send("${resultChannel}", latestRect);
      });

      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          ipcRenderer.send("${cancelChannel}");
        }
      });

      window.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        ipcRenderer.send("${cancelChannel}");
      });
    </script>
  </body>
</html>`;
}

export async function selectScreenRegion(
  sourceWindow: BrowserWindow | null
): Promise<ScreenRegionSelection | null> {
  const targetDisplay = sourceWindow
    ? screen.getDisplayMatching(sourceWindow.getBounds())
    : screen.getPrimaryDisplay()
  const orderedDisplays = getOrderedElectronDisplays()
  const captureDisplayIndex = Math.max(
    0,
    orderedDisplays.findIndex((display) => display.id === targetDisplay.id)
  )

  const resultChannel = `region-selection-result-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`
  const cancelChannel = `region-selection-cancel-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`

  const overlayWindow = new BrowserWindow({
    x: targetDisplay.bounds.x,
    y: targetDisplay.bounds.y,
    width: targetDisplay.bounds.width,
    height: targetDisplay.bounds.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: true,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  })

  overlayWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
  })
  overlayWindow.setAlwaysOnTop(true, "screen-saver", 2)

  return new Promise((resolve) => {
    let settled = false

    const cleanup = () => {
      ipcMain.removeListener(resultChannel, handleResult)
      ipcMain.removeListener(cancelChannel, handleCancel)

      if (!overlayWindow.isDestroyed()) {
        overlayWindow.close()
      }
    }

    const finish = (value: ScreenRegionSelection | null) => {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      resolve(value)
    }

    const handleResult = (
      _event: Electron.IpcMainEvent,
      payload: { x: number; y: number; width: number; height: number }
    ) => {
      finish({
        captureDisplayIndex,
        displayBounds: {
          width: targetDisplay.bounds.width,
          height: targetDisplay.bounds.height,
        },
        displayOrigin: {
          x: targetDisplay.bounds.x,
          y: targetDisplay.bounds.y,
        },
        region: {
          x: Math.max(0, Math.round(payload.x)),
          y: Math.max(0, Math.round(payload.y)),
          width: Math.max(1, Math.round(payload.width)),
          height: Math.max(1, Math.round(payload.height)),
        },
      })
    }

    const handleCancel = () => {
      finish(null)
    }

    ipcMain.on(resultChannel, handleResult)
    ipcMain.on(cancelChannel, handleCancel)

    overlayWindow.on("closed", () => {
      finish(null)
    })

    void overlayWindow
      .loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(
          buildOverlayHtml(resultChannel, cancelChannel)
        )}`
      )
      .then(() => {
        overlayWindow.show()
        overlayWindow.focus()
      })
      .catch((error) => {
        console.error("Failed to load region selection overlay:", error)
        finish(null)
      })
  })
}
