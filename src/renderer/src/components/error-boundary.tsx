import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { t } from '../../../shared/i18n'
import { reportRendererError } from '../utils/renderer-error-report'

interface ErrorBoundaryProps {
  children: ReactNode
  fallback?: ReactNode | ((error: Error, componentStack: string | null) => ReactNode)
  /** True for the root boundary: nothing above it handles the error. */
  unhandled?: boolean
}

interface ErrorBoundaryState {
  error: Error | null
  componentStack: string | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: null }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack)
    const componentStack = info.componentStack ?? null
    reportRendererError('render-error', error, { componentStack, unhandled: this.props.unhandled ?? false })
    this.setState({ componentStack })
  }

  render(): ReactNode {
    const { error, componentStack } = this.state
    if (error) {
      const { fallback } = this.props
      if (typeof fallback === 'function') return fallback(error, componentStack)
      return (
        fallback ?? (
          <div className="flex items-center gap-1.5 rounded-md border border-error-bg bg-error-bg px-2 py-1 text-xs text-error">
            <AlertTriangle size={12} className="shrink-0" />
            {t('app.errorBoundary.fallback')}
          </div>
        )
      )
    }
    return this.props.children
  }
}
