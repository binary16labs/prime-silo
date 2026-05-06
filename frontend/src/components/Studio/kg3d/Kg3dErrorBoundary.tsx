import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class Kg3dErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
  };

  public static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[UX-REC-F10] KG3D error:', error.message, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="w-full h-full flex items-center justify-center bg-[#020408]">
          <div className="h-8 bg-red-900/30 border border-red-500/40 text-red-400 text-[11px] font-mono flex items-center px-3 rounded">
            KG3D feature error — reverting to empty canvas
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default Kg3dErrorBoundary;
