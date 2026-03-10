export type DesktopUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "error"

export interface DesktopUpdateState {
  status: DesktopUpdateStatus
  version: string | null
  downloadPercent: number | null
  releaseName?: string | null
  releaseNotes?: string | null
  error?: string | null
}

export const EMPTY_DESKTOP_UPDATE_STATE: DesktopUpdateState = {
  status: "idle",
  version: null,
  downloadPercent: null,
  releaseName: null,
  releaseNotes: null,
  error: null,
}
