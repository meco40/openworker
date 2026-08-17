import AppShell from '@/modules/app-shell/AppShell';
import { redirect } from 'next/navigation';
import { isAuthRequired } from '@/server/auth/userContext';
import { View } from '@/shared/domain/types';
import { loadGatewayConfig } from '@/server/config/gateway/gatewayConfig';
import { resolveDefaultViewFromConfig } from '@/server/config/uiRuntimeConfig';

export default async function HomePage() {
  if (isAuthRequired()) {
    const { auth } = await import('@/auth');
    const session = await auth();
    if (!session?.user?.id) {
      redirect('/login');
    }
  }

  let initialView = View.DASHBOARD;
  try {
    const loadedConfig = await loadGatewayConfig();
    initialView = resolveDefaultViewFromConfig(loadedConfig.config);
  } catch {
    initialView = View.DASHBOARD;
  }

  return <AppShell initialView={initialView} />;
}
