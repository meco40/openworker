'use client';

import React, { type ReactNode } from 'react';
import ErrorBoundary from './ErrorBoundary';

interface ViewErrorBoundaryProps {
  /** Label displayed in the fallback UI (e.g. "Dashboard", "Chat"). */
  label: string;
  /** The view component tree to protect. */
  children: ReactNode;
}

/**
 * Lightweight wrapper around ErrorBoundary specifically for individual views.
 *
 * Each view in App.tsx should be wrapped with this component so that a crash
 * in one view (e.g. ModelHub) does not break the entire app – the sidebar
 * and header remain functional, and the user can switch to another view.
 *
 * Usage:
 *   <ViewErrorBoundary label="Model Hub">
 *     <ModelHub />
 *   </ViewErrorBoundary>
 */
const ViewErrorBoundary: React.FC<ViewErrorBoundaryProps> = ({ label, children }) => {
  return <ErrorBoundary label={label}>{children}</ErrorBoundary>;
};

export default ViewErrorBoundary;
