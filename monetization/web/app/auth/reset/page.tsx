'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { friendlyAuthError } from '@/lib/authErrors';

const MIN_CODE_LENGTH = 6;
const MAX_CODE_LENGTH = 10;

export default function ResetPage() {
  const [email,   setEmail]   = useState('');
  const [loading, setLoading] = useState(false);
  const [sent,    setSent]    = useState(false);
  const [code,    setCode]    = useState('');
  const [verifying, setVerifying] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const router = useRouter();
  const supabase = createClient();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    // Recovery links are PKCE: they must land on /auth/callback so the code is
    // exchanged for a session, and only then continue to the password form.
    // Pointing straight at /auth/update-password left the user with no session
    // (and, until now, a 404).
    const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent('/auth/update-password')}`,
    });

    setLoading(false);
    if (err) setError(friendlyAuthError(err));
    else setSent(true);
  }

  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault();
    setVerifying(true);
    setError(null);
    const { data, error: verifyErr } = await supabase.auth.verifyOtp({
      email,
      token: code.trim(),
      type: 'recovery',
    });
    setVerifying(false);
    if (verifyErr || !data.session) {
      setError(friendlyAuthError(verifyErr));
      return;
    }
    router.push('/auth/update-password');
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
            <div className="mt-4">
              <p className="text-sm text-slate-400 text-center" style={{ lineHeight: 1.6 }}>
                Check your email and click the reset link, or enter its verification code below.
              </p>
              <form onSubmit={handleVerifyCode} className="flex flex-col gap-3 mt-5">
                <input
                  type="text" inputMode="numeric" pattern="[0-9]*" maxLength={MAX_CODE_LENGTH}
                  value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="Verification code" autoComplete="one-time-code"
                  className="w-full rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 outline-none border tracking-[0.3em] font-mono"
                  style={{ background: 'var(--raised)', borderColor: 'var(--border)' }}
                />
                {error && <p className="text-sm text-red-400">{error}</p>}
                <button
                  type="submit" disabled={verifying || code.length < MIN_CODE_LENGTH}
                  className="w-full py-3 rounded-xl text-white font-semibold text-sm disabled:opacity-50"
                  style={{ background: 'var(--accent)' }}
                >
                  {verifying ? 'Verifying…' : 'Continue with code'}
                </button>
              </form>
            </div>
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
