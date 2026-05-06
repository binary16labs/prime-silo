import React, { Component, ErrorInfo, ReactNode } from "react";
import { AlertTriangle, RefreshCcw } from "lucide-react";

interface Props {
  children?: ReactNode;
  fallback?: ReactNode;
  name?: string;
}

interface State {
  hasError: boolean;
  error?: Error;
}

class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false
  };

  public static getDerivedStateFromError(error: Error): State {
    // Update state so the next render will show the fallback UI.
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`Uncaught error in ${this.props.name || 'Component'}:`, error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div style={{
          padding: '20px',
          background: 'rgba(239, 68, 68, 0.05)',
          border: '1px solid rgba(239, 68, 68, 0.2)',
          borderRadius: '12px',
          color: '#ef4444',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '12px',
          textAlign: 'center',
          margin: '10px'
        }}>
          <AlertTriangle size={32} />
          <div style={{ fontWeight: 600, fontSize: '14px' }}>
            {this.props.name || 'Component'} Failed to Load
          </div>
          <div style={{ fontSize: '12px', opacity: 0.8, maxWidth: '200px' }}>
            {this.state.error?.message || 'An unexpected error occurred in this section.'}
          </div>
          <button 
            onClick={() => this.setState({ hasError: false })}
            style={{
              padding: '6px 12px',
              borderRadius: '6px',
              background: '#ef4444',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '12px'
            }}
          >
            <RefreshCcw size={14} /> Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;

export function withErrorBoundary<P extends object>(
  Component: React.ComponentType<P>,
  name?: string
) {
  return (props: P) => (
    <ErrorBoundary name={name}>
      <Component {...props} />
    </ErrorBoundary>
  );
}
