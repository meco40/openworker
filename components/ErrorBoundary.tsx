'use client';

import React, { Component, type ReactNode, type ErrorInfo } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ErrorBoundaryProps {
  /** Child components to render. */
  children: ReactNode;
  /** Optional custom fallback UI. If omitted, a styled default is rendered. */
  fallback?: ReactNode;
  /** Called when an error is caught. Useful for external error reporting. */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  /** Optional label for the boundary (shown in the fallback UI). */
  label?: string;
  /** If true, renders a full-page fallback (for the global boundary). */
  fullPage?: boolean;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

// ─── ErrorBoundary Component ──────────────────────────────────────────────────

/**
 * Generic React Error Boundary.
 *
 * Catches rendering errors in its subtree and displays a graceful fallback
 * instead of a white screen. Supports reset (retry) functionality.
 *
 * Usage:
 *   <ErrorBoundary label="Dashboard">
 *     <Dashboard />
 *   </ErrorBoundary>
 */
class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo });

    // Log to console for debugging
    console.error(
      `[ErrorBoundary${this.props.label ? ` – ${this.props.label}` : ''}]`,
      error,
      errorInfo,
    );

    // Invoke external error handler if provided
    this.props.onError?.(error, errorInfo);
  }

  private handleReset = (): void => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    // If a custom fallback is provided, render it
    if (this.props.fallback) {
      return this.props.fallback;
    }

    const { error } = this.state;
    const { label, fullPage } = this.props;

    // ── Default Fallback UI ─────────────────────────────────────────
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: fullPage ? '100vh' : '300px',
          width: '100%',
          padding: '2rem',
          background: fullPage
            ? 'linear-gradient(135deg, #0a0a0a 0%, #111 50%, #0a0a0a 100%)'
            : 'transparent',
          fontFamily: "'Inter', system-ui, sans-serif",
        }}
      >
        <div
          style={{
            maxWidth: '480px',
            width: '100%',
            padding: '2rem',
            borderRadius: '16px',
            background: 'rgba(239, 68, 68, 0.04)',
            border: '1px solid rgba(239, 68, 68, 0.15)',
            backdropFilter: 'blur(12px)',
            textAlign: 'center',
          }}
        >
          {/* Icon */}
          <div
            style={{
              width: '56px',
              height: '56px',
              margin: '0 auto 1.25rem',
              borderRadius: '14px',
              background: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '24px',
            }}
          >
            ⚠️
          </div>

          {/* Headline */}
          <h2
            style={{
              margin: '0 0 0.5rem',
              fontSize: '16px',
              fontWeight: 600,
              color: '#f5f5f5',
              letterSpacing: '-0.01em',
            }}
          >
            {label ? `${label} – Fehler aufgetreten` : 'Ein Fehler ist aufgetreten'}
          </h2>

          {/* Description */}
          <p
            style={{
              margin: '0 0 1.25rem',
              fontSize: '13px',
              color: '#a1a1aa',
              lineHeight: 1.5,
            }}
          >
            {fullPage
              ? 'Die Anwendung ist auf einen unerwarteten Fehler gestoßen. Bitte versuchen Sie es erneut oder laden Sie die Seite neu.'
              : 'Diese Ansicht ist auf einen Fehler gestoßen. Die restliche Anwendung funktioniert weiterhin normal.'}
          </p>

          {/* Error details (collapsible look) */}
          {error && (
            <details
              style={{
                marginBottom: '1.25rem',
                textAlign: 'left',
                borderRadius: '8px',
                background: 'rgba(0, 0, 0, 0.3)',
                border: '1px solid rgba(255, 255, 255, 0.06)',
                overflow: 'hidden',
              }}
            >
              <summary
                style={{
                  padding: '0.6rem 0.8rem',
                  cursor: 'pointer',
                  fontSize: '11px',
                  fontWeight: 500,
                  color: '#71717a',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  userSelect: 'none',
                }}
              >
                Fehlerdetails
              </summary>
              <pre
                style={{
                  margin: 0,
                  padding: '0.8rem',
                  fontSize: '11px',
                  fontFamily: "'Fira Code', monospace",
                  color: '#ef4444',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  borderTop: '1px solid rgba(255, 255, 255, 0.04)',
                  maxHeight: '160px',
                  overflowY: 'auto',
                }}
              >
                {error.message}
                {'\n\n'}
                {error.stack?.split('\n').slice(1, 6).join('\n')}
              </pre>
            </details>
          )}

          {/* Action buttons */}
          <div
            style={{
              display: 'flex',
              gap: '0.75rem',
              justifyContent: 'center',
            }}
          >
            <button
              onClick={this.handleReset}
              style={{
                padding: '0.55rem 1.25rem',
                borderRadius: '8px',
                border: '1px solid rgba(139, 92, 246, 0.3)',
                background: 'rgba(139, 92, 246, 0.12)',
                color: '#a78bfa',
                fontSize: '13px',
                fontWeight: 500,
                cursor: 'pointer',
                transition: 'all 0.15s ease',
                fontFamily: "'Inter', system-ui, sans-serif",
              }}
              onMouseEnter={(e) => {
                (e.target as HTMLButtonElement).style.background = 'rgba(139, 92, 246, 0.22)';
                (e.target as HTMLButtonElement).style.borderColor = 'rgba(139, 92, 246, 0.5)';
              }}
              onMouseLeave={(e) => {
                (e.target as HTMLButtonElement).style.background = 'rgba(139, 92, 246, 0.12)';
                (e.target as HTMLButtonElement).style.borderColor = 'rgba(139, 92, 246, 0.3)';
              }}
            >
              ↻ Erneut versuchen
            </button>

            {fullPage && (
              <button
                onClick={() => window.location.reload()}
                style={{
                  padding: '0.55rem 1.25rem',
                  borderRadius: '8px',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  background: 'rgba(255, 255, 255, 0.04)',
                  color: '#a1a1aa',
                  fontSize: '13px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  fontFamily: "'Inter', system-ui, sans-serif",
                }}
                onMouseEnter={(e) => {
                  (e.target as HTMLButtonElement).style.background = 'rgba(255, 255, 255, 0.08)';
                }}
                onMouseLeave={(e) => {
                  (e.target as HTMLButtonElement).style.background = 'rgba(255, 255, 255, 0.04)';
                }}
              >
                Seite neu laden
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
