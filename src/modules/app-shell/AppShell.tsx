'use client';

import React from 'react';
import App from '../../../App';
import ErrorBoundary from '../../../components/ErrorBoundary';
import { PersonaProvider } from '../personas/PersonaContext';

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
