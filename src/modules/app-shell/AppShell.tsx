'use client';

import React from 'react';
import { View } from '@/shared/domain/types';
import App from '@/modules/app-shell/App';
import ErrorBoundary from '@/components/ErrorBoundary';
import { PersonaProvider } from '@/modules/personas/PersonaContext';

interface AppShellProps {
  initialView: View;
}

const AppShell: React.FC<AppShellProps> = ({ initialView }) => {
  return (
    <ErrorBoundary label="OpenClaw Gateway" fullPage>
      <PersonaProvider>
        <App initialView={initialView} />
      </PersonaProvider>
    </ErrorBoundary>
  );
};

export default AppShell;
