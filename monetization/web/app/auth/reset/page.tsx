'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import Link from 'next/link';

export default function ResetPage() {
  const [email,   setEmail]   = useState('');
  const [loading, setLoading] = useState(false);
  const [sent,    setSent]    = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const supabase = createClient();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/update-password`,
    });

    setLoading(false);
    if (err) setError(err.message);
    else setSent(true);
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: 'var(--bg)' }}>
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <a href="/" className="text-white font-semibold text-xl tracking-tight">
            Statflo<span style={{ color: 'var(--accent)' }}>Bot</span>
          </a>
        </div>
        <div className="rounded-2xl p-8 border" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
          <h1 className="text-xl font-bold text-white mb-2 text-center">Reset password</h1>

          {sent ? (
            <p className="text-sm text-slate-400 text-center mt-4">
              Check your email for a reset link.
            </p>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4 mt-6">
              <input
                type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com" required
                className="w-full rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 outline-none border"
                style={{ background: 'var(--raised)', borderColor: 'var(--border)' }}
              />
              {error && <p className="text-sm text-red-400">{error}</p>}
              <button
                type="submit" disabled={loading}
                className="w-full py-3 rounded-xl text-white font-semibold text-sm disabled:opacity-50"
                style={{ background: 'var(--accent)' }}
              >
                {loading ? 'Sending…' : 'Send reset link'}
              </button>
            </form>
          )}

          <p className="text-center text-xs text-slate-500 mt-4">
            <Link href="/auth/sign-in" className="hover:text-slate-300 transition-colors">Back to sign in</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
