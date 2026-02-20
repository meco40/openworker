'use client';

import React from 'react';
import App from '@/modules/app-shell/App';
import ErrorBoundary from '@/components/ErrorBoundary';
import { PersonaProvider } from '@/modules/personas/PersonaContext';

const AppShell: React.FC = () => {
  return (
    <ErrorBoundary label="OpenClaw Gateway" fullPage>
      <PersonaProvider>
        <App />
      </PersonaProvider>
    </ErrorBoundary>
  );
};

export default AppShell;
