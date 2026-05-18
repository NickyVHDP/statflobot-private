'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';

export default function SupportFormGate({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    createClient().auth.getUser().then(({ data }) => setAuthed(!!data.user));
  }, []);

  if (authed === null || authed) return <>{children}</>;

  return (
    <div className="relative">
      <div className="pointer-events-none select-none" style={{ filter: 'blur(5px)', opacity: 0.35 }}>
        {children}
      </div>
      <div className="absolute inset-0 flex items-center justify-center p-4">
        <div
          className="rounded-2xl border p-6 text-center w-full max-w-xs"
          style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
        >
          <p className="text-white font-semibold text-sm mb-1">Sign in to contact support</p>
          <p className="text-slate-400 text-xs mb-5">Your account helps us respond faster.</p>
          <div className="flex flex-col gap-2">
            <Link
              href="/auth/sign-in?redirect=/support"
              className="block w-full py-2.5 rounded-xl font-semibold text-sm text-white text-center transition-opacity hover:opacity-90"
              style={{ background: 'var(--accent)' }}
            >
              Sign In
            </Link>
            <Link
              href="/auth/sign-up?redirect=/support"
              className="block w-full py-2.5 rounded-xl text-sm text-slate-300 text-center border transition-colors hover:border-violet-500/50 hover:text-white"
              style={{ borderColor: 'var(--border)' }}
            >
              Create Account
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
