import AppShell from '@/modules/app-shell/AppShell';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { isAuthRequired } from '@/server/auth/userContext';

export default async function HomePage() {
  const session = await auth();
  if (isAuthRequired() && !session?.user?.id) {
    redirect('/login');
  }

  return <AppShell />;
}
