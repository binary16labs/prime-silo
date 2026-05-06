import React, { Component, ErrorInfo, ReactNode } from 'react';
import DiagnosticPanel from './DiagnosticPanel';

interface Props {
  children: ReactNode;
  uiVersion: 'v1' | 'v2';
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class RootErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[UX-REC-F3] Top-level crash:', error, errorInfo);
    
    // Emit custom event for telemetry [UX-REC-F3]
    window.dispatchEvent(new CustomEvent('benny.v2_crash', { 
      detail: { 
        name: error.name, 
        message: error.message,
        stack: errorInfo.componentStack
      } 
    }));
  }

  public render() {
    if (this.state.hasError && this.state.error) {
      return (
        <DiagnosticPanel 
          error={this.state.error} 
          version={this.props.uiVersion} 
        />
      );
    }

    return this.props.children;
  }
}

export default RootErrorBoundary;
