import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { Zap, Eye, EyeOff } from 'lucide-react';

const TABS = ['sign-in', 'sign-up', 'reset'];

// ── Shared atom components ────────────────────────────────────────────────────

function Field({ label, type = 'text', value, onChange, placeholder, autoComplete }) {
  const [show, setShow] = useState(false);
  const isPassword = type === 'password';
  return (
    <div>
      <label className="block text-xs font-medium mb-1.5" style={{ color: '#94a3b8' }}>
        {label}
      </label>
      <div className="relative">
        <input
          type={isPassword && show ? 'text' : type}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          required
          className="w-full rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 outline-none border transition-all"
          style={{ background: '#1a1a2e', borderColor: 'rgba(255,255,255,0.08)' }}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setShow(s => !s)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
          >
            {show ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        )}
      </div>
    </div>
  );
}

function Btn({ children, loading, disabled }) {
  return (
    <button
      type="submit"
      disabled={loading || disabled}
      className="w-full py-3 rounded-xl text-white font-semibold text-sm transition-all disabled:opacity-50"
      style={{ background: 'linear-gradient(135deg, #6366f1, #818cf8)' }}
    >
      {loading ? 'Please wait…' : children}
    </button>
  );
}

// ── Sign In ───────────────────────────────────────────────────────────────────

function SignInForm({ onSwitch }) {
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true); setError(null);
    const { error: err } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (err) setError(err.message);
    // On success, useAuth in App.jsx picks up the session change automatically
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Field label="Email" type="email" value={email} onChange={setEmail} placeholder="you@example.com" autoComplete="email" />
      <Field label="Password" type="password" value={password} onChange={setPassword} placeholder="••••••••" autoComplete="current-password" />
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <Btn loading={loading}>Sign in</Btn>
      <div className="flex justify-between text-xs" style={{ color: '#64748b' }}>
        <button type="button" onClick={() => onSwitch('sign-up')} className="hover:text-slate-300 transition-colors">
          Create account
        </button>
        <button type="button" onClick={() => onSwitch('reset')} className="hover:text-slate-300 transition-colors">
          Forgot password?
        </button>
      </div>
    </form>
  );
}

// ── Sign Up ───────────────────────────────────────────────────────────────────

function SignUpForm({ onSwitch }) {
  const [name,     setName]     = useState('');
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState(null);
  const [done,     setDone]     = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true); setError(null);
    const redirectTo = `${window.location.origin}/auth/verified`;
    const { error: err } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data:          { full_name: name },
        emailRedirectTo: redirectTo,
      },
    });
    setLoading(false);
    if (err) setError(err.message);
    else setDone(true);
  }

  if (done) return (
    <div className="text-center py-4">
      <p className="text-slate-300 text-sm mb-1">Check your email</p>
      <p className="text-slate-500 text-xs">
        We sent a confirmation link to <strong className="text-slate-300">{email}</strong>.
        Click it to activate, then{' '}
        <button onClick={() => onSwitch('sign-in')} className="underline" style={{ color: '#818cf8' }}>
          sign in
        </button>.
      </p>
    </div>
  );

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Field label="Full name" value={name} onChange={setName} placeholder="Your name" autoComplete="name" />
      <Field label="Email" type="email" value={email} onChange={setEmail} placeholder="you@example.com" autoComplete="email" />
      <Field label="Password" type="password" value={password} onChange={setPassword} placeholder="Min 8 characters" autoComplete="new-password" />
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <Btn loading={loading}>Create account</Btn>
      <p className="text-center text-xs" style={{ color: '#64748b' }}>
        Already have an account?{' '}
        <button type="button" onClick={() => onSwitch('sign-in')} className="hover:text-slate-300 transition-colors underline">
          Sign in
        </button>
      </p>
    </form>
  );
}

// ── Reset Password ────────────────────────────────────────────────────────────

function ResetForm({ onSwitch }) {
  const [email,   setEmail]   = useState('');
  const [loading, setLoading] = useState(false);
  const [sent,    setSent]    = useState(false);
  const [error,   setError]   = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true); setError(null);
    const redirectUrl = `${import.meta.env.VITE_CLOUD_API_URL ?? window.location.origin}/auth/update-password`;
    const { error: err } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: redirectUrl });
    setLoading(false);
    if (err) setError(err.message);
    else setSent(true);
  }

  return sent ? (
    <div className="text-center py-4">
      <p className="text-slate-300 text-sm">Reset link sent!</p>
      <p className="text-slate-500 text-xs mt-1">Check your email and follow the link.</p>
    </div>
  ) : (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Field label="Email" type="email" value={email} onChange={setEmail} placeholder="you@example.com" autoComplete="email" />
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <Btn loading={loading}>Send reset link</Btn>
      <p className="text-center text-xs" style={{ color: '#64748b' }}>
        <button type="button" onClick={() => onSwitch('sign-in')} className="hover:text-slate-300 transition-colors">
          ← Back to sign in
        </button>
      </p>
    </form>
  );
}

// ── Main AuthScreen ───────────────────────────────────────────────────────────

const TAB_LABELS = { 'sign-in': 'Sign in', 'sign-up': 'Create account', 'reset': 'Reset password' };

export default function AuthScreen() {
  const [tab, setTab] = useState('sign-in');

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center px-4"
      style={{ background: '#0a0a0f' }}
    >
      {/* Logo + wordmark */}
      <div className="flex flex-col items-center mb-10">
        <div
          className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4"
          style={{ background: 'linear-gradient(135deg, #6366f1, #818cf8)', boxShadow: '0 0 40px rgba(99,102,241,0.35)' }}
        >
          <Zap size={28} className="text-white" />
        </div>
        <h1 className="text-2xl font-bold text-white tracking-tight">StatfloBot</h1>
        <p className="text-sm mt-1" style={{ color: '#64748b' }}>Automated outreach for Statflo reps</p>
      </div>

      {/* Card */}
      <div
        className="w-full max-w-sm rounded-2xl p-8 border"
        style={{ background: '#13131f', borderColor: 'rgba(255,255,255,0.07)' }}
      >
        <h2 className="text-base font-semibold text-white mb-6 text-center">
          {TAB_LABELS[tab]}
        </h2>

        {tab === 'sign-in' && <SignInForm onSwitch={setTab} />}
        {tab === 'sign-up' && <SignUpForm onSwitch={setTab} />}
        {tab === 'reset'   && <ResetForm  onSwitch={setTab} />}
      </div>

      <p className="text-xs mt-6" style={{ color: '#334155' }}>
        StatfloBot · Secure login powered by Supabase
      </p>
    </div>
  );
}
