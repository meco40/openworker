import { Suspense } from 'react';
import LoginForm from './LoginForm';

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-[#0a0a0a] px-4 text-zinc-100">
          <div className="text-sm text-zinc-400">Lade...</div>
        </main>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
