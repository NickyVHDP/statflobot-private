'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';

/**
 * Top nav for the marketing site.
 * Detects auth state client-side and shows appropriate links.
 *
 * Signed out: Download · Sign in · Get started
 * Signed in:  Download · Dashboard · [email] · Sign out
 */
export default function SiteNav() {
  const [email,    setEmail]    = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);
  const router  = useRouter();
  const supabase = createClient();

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null);
      setResolved(true);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setEmail(session?.user?.email ?? null);
    });
    return () => subscription.unsubscribe();
  }, []);

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.refresh();
    setEmail(null);
  }

  return (
    <nav className="border-b border-white/5 px-6 py-4 flex items-center justify-between max-w-6xl mx-auto">
      <a href="/" className="text-white font-semibold text-lg tracking-tight" style={{ textDecoration: 'none' }}>
        Statflo<span style={{ color: 'var(--accent)' }}>Bot</span>
      </a>

      {/* Reserve space so nav doesn't shift on resolve */}
      <div className="flex items-center gap-4" style={{ minHeight: '36px' }}>
        <a href="/download" className="text-sm text-slate-400 hover:text-white transition-colors">
          Download
        </a>

        {!resolved ? null : email ? (
          /* Signed in */
          <>
            <a href="/dashboard" className="text-sm text-slate-400 hover:text-white transition-colors">
              Dashboard
            </a>
            <span className="text-xs text-slate-500 hidden sm:inline max-w-[160px] truncate">
              {email}
            </span>
            <button
              onClick={handleSignOut}
              className="text-sm text-slate-400 hover:text-white transition-colors"
            >
              Sign out
            </button>
          </>
        ) : (
          /* Signed out */
          <>
            <a href="/auth/sign-in" className="text-sm text-slate-400 hover:text-white transition-colors">
              Sign in
            </a>
            <a
              href="/auth/sign-up"
              className="text-sm px-4 py-2 rounded-lg text-white font-medium transition-all"
              style={{ background: 'var(--accent)' }}
            >
              Get started
            </a>
          </>
        )}
      </div>
    </nav>
  );
}
