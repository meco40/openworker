'use client';

import React from 'react';
import { ConfirmDialogProvider } from '@/components/shared/ConfirmDialogProvider';

export function AppClientProviders({ children }: { children: React.ReactNode }) {
  return <ConfirmDialogProvider>{children}</ConfirmDialogProvider>;
}
