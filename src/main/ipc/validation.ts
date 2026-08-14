import type { IpcMainInvokeEvent } from 'electron'
import { isTrustedRendererUrl, RENDERER_INDEX_PATH } from '../renderer-origin'

// Reject privileged IPC calls whose sender frame is not the app's own renderer.
// A belt-and-suspenders check: navigation is already pinned (see index.ts) and
// preview <webview> guests have no preload, so nothing else should be able to
// reach these channels — this makes that guarantee explicit at the boundary.
export function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url
  if (
    !url ||
    !isTrustedRendererUrl(url, {
      devServerUrl: process.env.ELECTRON_RENDERER_URL,
      rendererIndexPath: RENDERER_INDEX_PATH,
    })
  ) {
    throw new Error('Unauthorized IPC sender')
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
