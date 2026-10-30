'use client';

import { useEffect, useState } from 'react';
import AppShell from '@/modules/app-shell/AppShell';
import { View } from '@/shared/domain/types';
import { resolveDefaultViewFromConfig } from '@/shared/config/uiRuntimeConfig';

export default function HomePage() {
  const [initialView, setInitialView] = useState<View | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/config')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled) {
          setInitialView(resolveDefaultViewFromConfig(data?.config));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setInitialView(View.DASHBOARD);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (initialView === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0a0a0a] text-zinc-400">
        <div className="text-sm">Lade Konfiguration...</div>
      </div>
    );
  }

  return <AppShell initialView={initialView} />;
}
