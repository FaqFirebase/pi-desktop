import type { WebviewTag } from 'electron'

export type WebviewElement = WebviewTag

// `<webview>` (enabled via webviewTag) isn't a typed JSX intrinsic; cast the tag
// to a component so TS accepts the props we use. It renders the HTML preview in
// an isolated guest process so its JavaScript runs without touching the app CSP.
// React drops a boolean `true` on an attribute it does not know, so an
// attribute that must reach the DOM (`allowpopups`) takes a string.
export const Webview = 'webview' as unknown as React.FC<
  React.HTMLAttributes<HTMLElement> & {
    src: string
    partition?: string
    plugins?: boolean
    allowpopups?: string
    ref?: React.Ref<WebviewElement>
  }
>
