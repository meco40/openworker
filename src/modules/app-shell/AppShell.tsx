'use client';

import React from 'react';
import App from '../../../App';
import ErrorBoundary from '../../../components/ErrorBoundary';

const AppShell: React.FC = () => {
  return (
    <ErrorBoundary label="OpenClaw Gateway" fullPage>
      <App />
    </ErrorBoundary>
  );
};

export default AppShell;
