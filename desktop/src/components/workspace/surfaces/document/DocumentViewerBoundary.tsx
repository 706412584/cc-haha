import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportReactError } from '@/lib/diagnosticsCapture'

type Props = {
  /** A different value clears a failure: another document, or another try, deserves its own chance. */
  resetKey: string
  fallback: ReactNode
  children: ReactNode
}

type State = { failed: boolean; resetKey: string }

/**
 * Keeps a viewer that cannot load, or that crashes drawing, inside its panel.
 *
 * A viewer's code is a chunk fetched the first time a document of its kind is opened
 * — from a page that may be older than the server it talks to, or over a poor link —
 * and `lazy` throws when that fetch fails. Left to the application's own boundary,
 * that throw replaces the whole window because one file could not be previewed.
 */
export class DocumentViewerBoundary extends Component<Props, State> {
  state: State = { failed: false, resetKey: this.props.resetKey }

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey }
  }

  componentDidCatch(error: unknown, errorInfo: ErrorInfo): void {
    void reportReactError(error, errorInfo)
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
