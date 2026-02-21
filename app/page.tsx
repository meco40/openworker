import AppShell from '@/modules/app-shell/AppShell';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { isAuthRequired } from '@/server/auth/userContext';
import { View } from '@/shared/domain/types';
import { loadGatewayConfig } from '@/server/config/gatewayConfig';
import { resolveDefaultViewFromConfig } from '@/server/config/uiRuntimeConfig';

export default async function HomePage() {
  const session = await auth();
  if (isAuthRequired() && !session?.user?.id) {
    redirect('/login');
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
