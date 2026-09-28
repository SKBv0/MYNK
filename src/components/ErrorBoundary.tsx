import React from 'react';
import { translations } from '../translations';
import { useAppStore } from '../store';
import { flushPersistence } from '../store/persistence';
import { Button } from './ui';

interface ErrorBoundaryState {
  error: Error | null;
}

/** Shows a recovery screen instead of a blank window when rendering throws. */
class ErrorBoundary extends React.Component<React.PropsWithChildren, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[MYNK] render error:', error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    const t = translations[useAppStore.getState().lang];
    return (
      <div role="alert" className="flex h-screen items-center justify-center bg-bg p-8 text-fg">
        <div className="max-w-md space-y-4 text-center">
          <h1 className="font-display text-xl font-bold">{t.errorBoundary.title}</h1>
          <p className="text-base text-fg-secondary">{t.errorBoundary.message}</p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-surface-2 p-3 text-left font-mono text-sm text-danger">
            {this.state.error.message}
          </pre>
          <div className="flex justify-center gap-2">
            <Button onClick={() => this.setState({ error: null })}>{t.errorBoundary.retry}</Button>
            <Button
              variant="primary"
              // A reload does not wait for `beforeunload` work, so the pending write lands first.
              onClick={() => void flushPersistence().finally(() => window.location.reload())}
            >
              {t.errorBoundary.reload}
            </Button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
