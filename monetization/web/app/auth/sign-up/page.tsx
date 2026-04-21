'use client';

import { useState, Suspense } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';

function SignUpForm() {
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [name,     setName]     = useState('');
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [success,  setSuccess]  = useState(false);

  const searchParams   = useSearchParams();
  const checkoutStatus = searchParams.get('checkout');
  const isPending      = checkoutStatus === 'pending';
  const supabase       = createClient();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error: signUpErr } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: name } },
    });

    setLoading(false);
    if (signUpErr) {
      setError(signUpErr.message);
    } else {
      setSuccess(true);
    }
  }

  // After sign-up: confirm email, then sign in.
  // Carry checkout=pending through so reconciliation fires after sign-in.
  if (success) {
    const signInHref = isPending ? '/auth/sign-in?checkout=pending' : '/auth/sign-in';
    return (
      <AuthShell title="Check your email">
        {isPending && (
          <div
            className="mb-4 rounded-xl px-4 py-3 border text-sm"
            style={{ background: 'rgba(167,139,250,0.08)', borderColor: 'rgba(167,139,250,0.3)', color: '#c4b5fd' }}
          >
            <p className="font-semibold">Purchase received</p>
            <p className="text-xs mt-0.5 opacity-80">
              Confirm your email, then sign in with <strong>{email}</strong> to activate your access.
            </p>
          </div>
        )}
        <p className="text-slate-400 text-sm text-center">
          We sent a confirmation link to <strong className="text-white">{email}</strong>.
          Click it to activate your account, then{' '}
          <Link href={signInHref} className="underline" style={{ color: 'var(--accent-light)' }}>
            sign in
          </Link>.
        </p>
      </AuthShell>
    );
  }

  const signInHref = isPending ? '/auth/sign-in?checkout=pending' : '/auth/sign-in';

  return (
    <AuthShell title="Create your account">
      {isPending && (
        <div
          className="mb-4 rounded-xl px-4 py-3 border text-sm"
          style={{ background: 'rgba(167,139,250,0.08)', borderColor: 'rgba(167,139,250,0.3)', color: '#c4b5fd' }}
        >
          <p className="font-semibold">Purchase received</p>
          <p className="text-xs mt-0.5 opacity-80">
            Create your account with the same email you used at checkout to activate access.
          </p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field label="Full name"  value={name}     onChange={setName}     placeholder="Your name"        autoComplete="name" />
        <Field label="Email"      type="email"  value={email}    onChange={setEmail}    placeholder="you@example.com" autoComplete="email" />
        <Field label="Password"   type="password" value={password} onChange={setPassword} placeholder="Min 8 characters" autoComplete="new-password" />

        {error && <p className="text-sm text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full py-3 rounded-xl text-white font-semibold text-sm transition-opacity disabled:opacity-50"
          style={{ background: 'var(--accent)' }}
        >
          {loading ? 'Creating account…' : 'Create account'}
        </button>
      </form>

      <p className="text-center text-sm text-slate-500 mt-4">
        Already have an account?{' '}
        <Link href={signInHref} className="text-slate-300 hover:text-white transition-colors">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}

export default function SignUpPage() {
  return (
    <Suspense>
      <SignUpForm />
    </Suspense>
  );
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
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
          <h1 className="text-xl font-bold text-white mb-6 text-center">{title}</h1>
          {children}
        </div>
      </div>
    </div>
  );
}

function Field({
  label, value, onChange, type = 'text', placeholder, autoComplete,
}: {
  label: string; value: string; onChange: (v: string) => void;
  type?: string; placeholder?: string; autoComplete?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-400 mb-1.5">{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required
        className="w-full rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition-all border"
        style={{ background: 'var(--raised)', borderColor: 'var(--border)' }}
      />
    </div>
  );
}
