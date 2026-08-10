import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Eye, EyeOff } from 'lucide-react';
import BotIcon from '../components/BotIcon.jsx';
import { friendlyAuthError, isEmailRateLimit, verifyEmailCode } from '../lib/authErrors';

const TABS = ['sign-in', 'sign-up', 'reset'];

// Verification must complete on the public site, never on the desktop app's
// own origin. In the packaged app window.location.origin is http://localhost:3001,
// which only works if that exact origin is allowlisted in Supabase and leaves
// the user on a page the desktop app cannot complete. statflobot.store hosts
// /auth/callback, which exchanges the code and confirms the account.
const PUBLIC_SITE_URL = 'https://statflobot.store';

const RESEND_COOLDOWN_SECONDS = 60;

// Supabase's code length is a project setting (mailer_otp_length), currently 8.
// Accept a range rather than hardcoding a length the dashboard can change.
const MIN_CODE_LENGTH = 6;
const MAX_CODE_LENGTH = 10;

/** Shared countdown for resend buttons — stops users burning the hourly quota. */
function useCooldown() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (seconds <= 0) return;
    const t = setTimeout(() => setSeconds(s => s - 1), 1000);
    return () => clearTimeout(t);
  }, [seconds]);
  return [seconds, setSeconds];
}

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
  const [notice,   setNotice]   = useState(null);
  const [codeMode, setCodeMode] = useState(false);
  const [code,     setCode]     = useState('');
  const [cooldown, setCooldown] = useCooldown();

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true); setError(null);
    try {
      if (!supabase) throw new Error('Auth service unavailable — please restart the app');
      const { error: err } = await Promise.race([
        supabase.auth.signInWithPassword({ email, password }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Sign-in timed out after 15 seconds')), 15_000)),
      ]);
      if (err) setError(friendlyAuthError(err));
      // On success, useAuth in App.jsx picks up the session change automatically
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  /** Email a fresh verification code — also re-sends confirmation for unverified users. */
  async function handleSendCode() {
    if (!email) { setError('Enter your email address first.'); return; }
    if (cooldown > 0) return;
    setLoading(true); setError(null); setNotice(null);
    try {
      if (!supabase) throw new Error('Auth service unavailable — please restart the app');
      const { error: err } = await supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false, emailRedirectTo: `${PUBLIC_SITE_URL}/auth/callback` },
      });
      if (err) {
        setError(friendlyAuthError(err));
        if (isEmailRateLimit(err)) setCooldown(RESEND_COOLDOWN_SECONDS * 5);
        return;
      }
      setCodeMode(true);
      setCooldown(RESEND_COOLDOWN_SECONDS);
      setNotice(`We emailed a verification code to ${email}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyCode(e) {
    e.preventDefault();
    setLoading(true); setError(null);
    try {
      const { error: err } = await verifyEmailCode(supabase, email, code.trim());
      if (err) setError(friendlyAuthError(err));
      // On success App.jsx picks up the new session automatically.
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={codeMode ? handleVerifyCode : handleSubmit} className="flex flex-col gap-4">
      <Field label="Email" type="email" value={email} onChange={setEmail} placeholder="you@example.com" autoComplete="email" />

      {codeMode ? (
        <div>
          <label className="block text-xs font-medium mb-1.5" style={{ color: '#94a3b8' }}>
            Verification code from your email
          </label>
          <input
            type="text" inputMode="numeric" maxLength={MAX_CODE_LENGTH} value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
            placeholder="12345678" autoComplete="one-time-code"
            className="w-full rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 outline-none border font-mono tracking-[0.4em]"
            style={{ background: '#1a1a2e', borderColor: 'rgba(255,255,255,0.08)' }}
          />
          <p className="text-xs mt-1.5" style={{ color: '#475569' }}>
            Enter the code from your email. Use this if the emailed link expired or was already opened.
          </p>
        </div>
      ) : (
        <Field label="Password" type="password" value={password} onChange={setPassword} placeholder="••••••••" autoComplete="current-password" />
      )}

      {notice && <p className="text-xs" style={{ color: '#86efac' }}>{notice}</p>}
      {error && <p className="text-red-400 text-xs">{error}</p>}

      <Btn loading={loading} disabled={codeMode && code.length < MIN_CODE_LENGTH}>
        {codeMode ? 'Verify code' : 'Sign in'}
      </Btn>

      <div className="flex flex-col gap-2 text-xs" style={{ color: '#64748b' }}>
        <button
          type="button" onClick={handleSendCode} disabled={loading || cooldown > 0}
          className="text-left transition-colors disabled:opacity-50"
          style={{ color: cooldown > 0 ? '#64748b' : '#818cf8' }}
        >
          {cooldown > 0
            ? `Email a code in ${cooldown}s`
            : codeMode ? 'Email me a new code' : 'Use a verification code instead'}
        </button>
        {codeMode && (
          <button
            type="button"
            onClick={() => { setCodeMode(false); setError(null); setNotice(null); }}
            className="text-left hover:text-slate-300 transition-colors"
          >
            ← Use password instead
          </button>
        )}
      </div>

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
    try {
      if (!supabase) throw new Error('Auth service unavailable — please restart the app');
      // Confirm on the public site, not this app's localhost origin.
      const redirectTo = `${PUBLIC_SITE_URL}/auth/callback`;
      const { error: err } = await Promise.race([
        supabase.auth.signUp({ email, password, options: { data: { full_name: name }, emailRedirectTo: redirectTo } }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Sign-up timed out after 15 seconds')), 15_000)),
      ]);
      if (err) setError(friendlyAuthError(err));
      else setDone(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (done) return (
    <div className="text-center py-4">
      <p className="text-slate-300 text-sm mb-1">Check your email</p>
      <p className="text-slate-500 text-xs">
        We sent a confirmation email to <strong className="text-slate-300">{email}</strong>.
        Click the link to activate, then{' '}
        <button onClick={() => onSwitch('sign-in')} className="underline" style={{ color: '#818cf8' }}>
          sign in
        </button>.
      </p>
      <p className="text-xs mt-3" style={{ color: '#475569', lineHeight: 1.6 }}>
        Link already opened or expired? That email also contains a verification code —
        go to sign in and choose <strong className="text-slate-400">Use a verification code instead</strong>.
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
  function openResetPage() {
    const url = `${PUBLIC_SITE_URL}/auth/reset`;
    if (window.electron?.openExternal) window.electron.openExternal(url);
    else window.open(url, '_blank', 'noopener,noreferrer');
  }

  return (
    <div className="flex flex-col gap-4 text-center">
      <p className="text-sm" style={{ color: '#94a3b8' }}>
        Password reset opens on the secure StatfloBot website so the email link and verification code work in the same browser session.
      </p>
      <button
        type="button" onClick={openResetPage}
        className="w-full py-3 rounded-xl text-white font-semibold text-sm"
        style={{ background: 'linear-gradient(135deg, #6366f1, #818cf8)' }}
      >
        Reset password securely
      </button>
      <p className="text-center text-xs" style={{ color: '#64748b' }}>
        <button type="button" onClick={() => onSwitch('sign-in')} className="hover:text-slate-300 transition-colors">
          ← Back to sign in
        </button>
      </p>
    </div>
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
        <BotIcon size={56} className="mb-4" />
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
