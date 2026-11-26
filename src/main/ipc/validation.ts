import type { IpcMainInvokeEvent } from 'electron'
import { isTrustedRendererUrl, RENDERER_INDEX_PATH } from '../renderer-origin'
import { UNAUTHORIZED_IPC_SENDER_MESSAGE } from '../ipc-sender-guard'

// Reject privileged IPC calls whose sender frame is not the app's own renderer.
// A second check on top of the pinned navigation (see index.ts) and the app
// window rule every channel already applies (ipc-sender-guard.ts).
export function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url
  if (
    !url ||
    !isTrustedRendererUrl(url, {
      devServerUrl: process.env.ELECTRON_RENDERER_URL,
      rendererIndexPath: RENDERER_INDEX_PATH,
    })
  ) {
    throw new Error(UNAUTHORIZED_IPC_SENDER_MESSAGE)
  }
}

// Type guard helpers
export function isString(value: unknown): value is string {
  return typeof value === 'string'
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

export function parseStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map(String)
}

export function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean'
}

export function isOptionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every(isString))
}
