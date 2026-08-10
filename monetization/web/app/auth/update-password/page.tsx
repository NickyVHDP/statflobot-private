'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { friendlyAuthError } from '@/lib/authErrors';

/**
 * Set a new password after a recovery link.
 *
 * The reset flow already redirected here, but the route did not exist, so every
 * password reset ended on a 404. /auth/callback establishes the recovery
 * session first, then sends the user here to choose a new password.
 */
export default function UpdatePasswordPage() {
  const [password, setPassword] = useState('');
  const [confirm,  setConfirm]  = useState('');
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [done,     setDone]     = useState(false);
  const [ready,    setReady]    = useState(false);
  const router   = useRouter();
  const supabase = createClient();

  // A recovery session must exist before a password can be set. If the link was
  // opened directly (or expired) say so rather than failing on submit.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) {
        setError('This password reset link is no longer valid. Request a new one from the sign-in page.');
      }
      setReady(true);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError('Please choose a password of at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Those passwords do not match.');
      return;
    }

    setLoading(true);
    const { error: updateErr } = await supabase.auth.updateUser({ password });
    setLoading(false);

    if (updateErr) {
      setError(friendlyAuthError(updateErr));
      return;
    }
    setDone(true);
    setTimeout(() => router.push('/dashboard'), 1500);
  }

  const inputCls = 'w-full rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 outline-none border';
  const inputStyle = { background: 'var(--raised)', borderColor: 'var(--border)' };

  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: 'var(--bg)' }}>
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <a href="/" className="text-white font-semibold text-xl tracking-tight">
            Statflo<span style={{ color: 'var(--accent)' }}>Bot</span>
          </a>
        </div>

        <div className="rounded-2xl p-8 border" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
          <h1 className="text-xl font-bold text-white mb-6 text-center">Choose a new password</h1>

          {done ? (
            <div className="text-center">
              <p className="text-sm" style={{ color: '#86efac' }}>Password updated.</p>
              <p className="text-xs text-slate-500 mt-1">Taking you to your dashboard…</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">New password</label>
                <input
                  type="password" value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="At least 8 characters" autoComplete="new-password"
                  className={inputCls} style={inputStyle}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">Confirm new password</label>
                <input
                  type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
                  placeholder="Re-enter your password" autoComplete="new-password"
                  className={inputCls} style={inputStyle}
                />
              </div>

              {error && <p className="text-sm text-red-400">{error}</p>}

              <button
                type="submit" disabled={loading || !ready}
                className="w-full py-3 rounded-xl text-white font-semibold text-sm transition-opacity disabled:opacity-50"
                style={{ background: 'var(--accent)' }}
              >
                {loading ? 'Updating…' : 'Update password'}
              </button>
            </form>
          )}

          <div className="text-center text-xs text-slate-500 mt-4">
            <Link href="/auth/sign-in" className="hover:text-slate-300 transition-colors">
              ← Back to sign in
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
