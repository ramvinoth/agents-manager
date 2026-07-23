import { Component, type ReactNode } from "react"
import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"

interface Props {
  children: ReactNode
  label?: string
}
interface State {
  error: Error | null
}

// Contains a render fault to its region instead of white-screening the whole
// app. Give it a `key` (e.g. the session path) to auto-reset on navigation.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: unknown) {
    // eslint-disable-next-line no-console
    console.error("UI error boundary caught:", error, info)
  }

  reset = () => this.setState({ error: null })

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full min-h-40 flex-col items-center justify-center gap-3 p-6 text-center">
          <AlertTriangle className="size-6 text-destructive" />
          <div className="text-sm font-medium">{this.props.label || "Something went wrong here"}</div>
          <div className="max-w-md break-words text-xs text-muted-foreground">
            {this.state.error.message}
          </div>
          <Button size="sm" variant="outline" onClick={this.reset}>
            Try again
          </Button>
        </div>
      )
    }
    return this.props.children
  }
}
