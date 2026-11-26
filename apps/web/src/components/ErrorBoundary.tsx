import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  scopeLabel?: string;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, errorMessage: "" };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error?.message || "An unexpected rendering error occurred.",
    };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ErrorBoundary]", this.props.scopeLabel ?? "Workspace", error.message, info.componentStack);
  }

  private handleReset = (): void => {
    this.setState({ hasError: false, errorMessage: "" });
    this.props.onReset?.();
  };

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="error-boundary-card" role="alert">
          <h2 className="section-heading">
            {this.props.scopeLabel ? `${this.props.scopeLabel} encountered an error` : "Workspace rendering error"}
          </h2>
          <p className="muted-text">{this.state.errorMessage}</p>
          <div className="row-actions">
            <button type="button" className="btn primary" onClick={this.handleReset}>
              Try Again
            </button>
            <button type="button" className="btn" onClick={() => window.location.reload()}>
              Reload Page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
