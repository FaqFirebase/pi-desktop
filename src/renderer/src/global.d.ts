import type { PiDesktopAPI } from '../../preload/index'
import type { QuickChatApi } from '../../shared/quick-chat'

declare global {
  interface Window {
    piDesktop: PiDesktopAPI
    piQuickChat: QuickChatApi
  }
  const __APP_VERSION__: string
}
