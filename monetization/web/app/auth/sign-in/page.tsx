'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Suspense } from 'react';

function SignInForm() {
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const router         = useRouter();
  const searchParams   = useSearchParams();
  const redirectTo     = searchParams.get('redirect') ?? '/dashboard';
  const checkoutStatus = searchParams.get('checkout');
  const isPending      = checkoutStatus === 'pending';
  const supabase       = createClient();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);

    if (signInErr) {
      setError(signInErr.message);
    } else {
      // Always land on dashboard — reconcilePendingPurchase runs there server-side
      router.push(redirectTo === '/dashboard' || checkoutStatus === 'pending' ? '/dashboard?checkout=pending' : redirectTo);
      router.refresh();
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: 'var(--bg)' }}>
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <a href="/" className="text-white font-semibold text-xl tracking-tight">
            Statflo<span style={{ color: 'var(--accent)' }}>Bot</span>
          </a>
        </div>
        <div
          className="rounded-2xl p-8 border"
          style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
        >
          <h1 className="text-xl font-bold text-white mb-6 text-center">Sign in</h1>

          {checkoutStatus === 'pending' && (
            <div
              className="mb-4 rounded-xl px-4 py-3 border text-sm"
              style={{ background: 'rgba(167,139,250,0.08)', borderColor: 'rgba(167,139,250,0.3)', color: '#c4b5fd' }}
            >
              <p className="font-semibold">Purchase received</p>
              <p className="text-xs mt-0.5 opacity-80">
                Sign in with the same email you used at checkout to activate your access.
              </p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Email</label>
              <input
                type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com" required autoComplete="email"
                className="w-full rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 outline-none border"
                style={{ background: 'var(--raised)', borderColor: 'var(--border)' }}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Password</label>
              <input
                type="password" value={password} onChange={e => setPassword(e.target.value)}
                placeholder="••••••••" required autoComplete="current-password"
                className="w-full rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 outline-none border"
                style={{ background: 'var(--raised)', borderColor: 'var(--border)' }}
              />
            </div>

            {error && <p className="text-sm text-red-400">{error}</p>}

            <button
              type="submit" disabled={loading}
              className="w-full py-3 rounded-xl text-white font-semibold text-sm transition-opacity disabled:opacity-50"
              style={{ background: 'var(--accent)' }}
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <div className="flex justify-between text-xs text-slate-500 mt-4">
            <Link
              href={isPending ? '/auth/sign-up?checkout=pending' : '/auth/sign-up'}
              className="hover:text-slate-300 transition-colors"
            >
              Create account
            </Link>
            <Link href="/auth/reset" className="hover:text-slate-300 transition-colors">
              Forgot password?
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function SignInPage() {
  return (
    <Suspense>
      <SignInForm />
    </Suspense>
  );
}
