'use client';

import { useState } from 'react';
import {
  Copy, Check, CreditCard, Download, Laptop, LogOut, Eye, EyeOff,
  AlertTriangle, CheckCircle, Clock, XCircle, Zap, Shield, ChevronDown, ChevronUp,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';

interface Props {
  profile:       any;
  license:       any;
  subscription:  any;
  devices:       any[];  // from `devices` table: includes days_old
  swapStatus:    null;   // deprecated — always null, kept for interface compat
  justPurchased: boolean;
  buildCommit?:  string;
}

export default function DashboardClient({ profile, license, subscription, devices, justPurchased, buildCommit }: Props) {
  const router   = useRouter();
  const supabase = createClient();

  const [copied,          setCopied]          = useState(false);
  const [portalLoading,   setPortalLoading]   = useState(false);
  const [showTechDetails, setShowTechDetails] = useState(false);
  const [keyRevealed,     setKeyRevealed]     = useState(false);

  async function handleCopyKey() {
    if (!license?.license_key) return;
    await navigator.clipboard.writeText(license.license_key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleBillingPortal() {
    setPortalLoading(true);
    const res  = await fetch('/api/billing/portal', { method: 'POST' });
    const data = await res.json();
    if (data.url) window.location.href = data.url;
    else { setPortalLoading(false); alert(data.error ?? 'Could not open billing portal'); }
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push('/');
  }

  // ── Derived state ──────────────────────────────────────────────────────────
  const isAdmin    = profile?.is_admin === true;
  const hasLicense = !!license && license.status === 'active';
  const hasSub     = !!subscription && ['active', 'trialing', 'lifetime'].includes(subscription?.status);
  const hasAccess  = isAdmin || hasLicense || hasSub;

  // isLifetime: true for lifetime license OR lifetime subscription status OR admin
  const isLifetime = license?.plan === 'lifetime' || subscription?.status === 'lifetime' || isAdmin;

  const planLabel = planDisplayName(license?.plan ?? subscription?.status);
  const subStatus = subscription?.status ?? 'inactive';
  const licStatus = license?.status ?? 'inactive';
  const periodEnd = subscription?.current_period_end
    ? new Date(subscription.current_period_end).toLocaleDateString()
    : null;

  // Masked license key: STATFLO-•••••-•••••-•••••
  function maskedKey(key: string) {
    const parts = key.split('-');
    if (parts.length < 4) return '••••••••••••••••';
    return `${parts[0]}-${'•'.repeat(5)}-${'•'.repeat(5)}-${'•'.repeat(5)}`;
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>

      {/* Nav */}
      <nav className="border-b px-6 py-4 flex items-center justify-between max-w-5xl mx-auto" style={{ borderColor: 'var(--border)' }}>
        <a href="/" className="text-white font-semibold text-lg tracking-tight">
          Statflo<span style={{ color: 'var(--accent)' }}>Bot</span>
        </a>
        <button
          onClick={handleSignOut}
          className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-white transition-colors"
        >
          <LogOut size={14} /> Sign out
        </button>
      </nav>

      <main className="max-w-5xl mx-auto px-6 py-10">

        {/* Success banner */}
        {justPurchased && (
          <div
            className="mb-8 rounded-2xl p-4 flex items-center gap-3 border"
            style={{ background: 'rgba(134,239,172,0.07)', borderColor: 'rgba(134,239,172,0.25)' }}
          >
            <CheckCircle size={18} style={{ color: '#86efac' }} />
            <div>
              <p className="font-semibold text-white text-sm">Payment successful — welcome aboard!</p>
              <p className="text-slate-400 text-xs mt-0.5">Your access is now active. Open the StatfloBot desktop app to get started.</p>
            </div>
          </div>
        )}

        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white">
            Welcome back{profile?.full_name ? `, ${profile.full_name.split(' ')[0]}` : ''}
            {isAdmin && (
              <span
                className="ml-3 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium align-middle"
                style={{ background: 'rgba(167,139,250,0.15)', color: '#a78bfa' }}
              >
                <Shield size={11} /> Admin
              </span>
            )}
          </h1>
          <p className="text-slate-400 text-sm mt-1">{profile?.email}</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">

          {/* ── Access Status ─────────────────────────────────────────────── */}
          <Card title="Access Status" icon={<Zap size={16} />}>
            {hasAccess ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-400">Status</span>
                  <StatusBadge status={isAdmin ? 'lifetime' : licStatus} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-400">Plan</span>
                  <span className="text-sm font-medium text-white">{isAdmin ? 'Admin — Lifetime' : planLabel}</span>
                </div>
                {!isAdmin && (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-400">Devices</span>
                    <span className="text-sm text-white">
                      {devices.length} / {license?.max_devices ?? 2} used
                    </span>
                  </div>
                )}
                {isAdmin && (
                  <p className="text-xs" style={{ color: '#a78bfa' }}>Admin account — full access, no restrictions</p>
                )}

                {/* Technical details toggle */}
                {!isAdmin && license?.license_key && (
                  <div className="pt-1 border-t" style={{ borderColor: 'var(--border)' }}>
                    <button
                      onClick={() => setShowTechDetails(v => !v)}
                      className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 transition-colors"
                    >
                      {showTechDetails ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                      {showTechDetails ? 'Hide' : 'Show'} license details
                    </button>
                    {showTechDetails && (
                      <div className="mt-2 space-y-2">
                        <p className="text-xs text-slate-500">License key</p>
                        <div
                          className="flex items-center gap-2 rounded-xl px-3 py-2 border font-mono"
                          style={{ background: 'var(--raised)', borderColor: 'var(--border)' }}
                        >
                          <span className="flex-1 text-slate-300 text-xs tracking-wider truncate select-none">
                            {keyRevealed ? license.license_key : maskedKey(license.license_key)}
                          </span>
                          <button
                            onClick={() => setKeyRevealed(v => !v)}
                            title={keyRevealed ? 'Hide key' : 'Reveal key'}
                            className="text-slate-500 hover:text-slate-300 transition-colors shrink-0"
                          >
                            {keyRevealed ? <EyeOff size={13} /> : <Eye size={13} />}
                          </button>
                          <button
                            onClick={handleCopyKey}
                            title="Copy license key"
                            className="text-slate-400 hover:text-white transition-colors shrink-0"
                          >
                            {copied ? <Check size={13} style={{ color: '#86efac' }} /> : <Copy size={13} />}
                          </button>
                        </div>
                        <p className="text-xs text-slate-600">Copying works without revealing the key.</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              /* ── Unpaid: single CTA only ───────────────────────────────── */
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-400">Status</span>
                  <StatusBadge status="inactive" />
                </div>
                <p className="text-sm text-slate-400">No active access.</p>
                <a
                  href="/#pricing"
                  className="inline-block px-4 py-2.5 rounded-xl text-sm font-semibold text-white transition-opacity hover:opacity-90"
                  style={{ background: 'var(--accent)' }}
                >
                  Choose a plan
                </a>
              </div>
            )}
          </Card>

          {/* ── Billing ──────────────────────────────────────────────────── */}
          <Card title="Billing" icon={<CreditCard size={16} />}>
            {isAdmin ? (
              /* Admin */
              <div className="space-y-2">
                <StatusBadge status="lifetime" isSubscription />
                <p className="text-xs font-medium" style={{ color: '#a78bfa' }}>Admin account — billing not applicable</p>
              </div>

            ) : hasAccess && isLifetime ? (
              /* Lifetime — paid once, no recurring billing */
              <div className="space-y-2">
                <StatusBadge status="lifetime" isSubscription />
                <p className="text-xs font-medium text-violet-400">Lifetime access — one-time payment, no recurring charges.</p>
              </div>

            ) : hasAccess && subscription ? (
              /* Active monthly subscription */
              <div className="space-y-3">
                <StatusBadge status={subStatus} isSubscription />
                {periodEnd && (
                  <p className="text-xs text-slate-400">
                    {subscription.cancel_at_period_end ? 'Cancels on' : 'Renews on'}: {periodEnd}
                  </p>
                )}
                <button
                  onClick={handleBillingPortal}
                  disabled={portalLoading}
                  className="w-full py-2 rounded-xl text-sm font-medium transition-all disabled:opacity-50 border"
                  style={{ background: 'var(--raised)', borderColor: 'var(--border)', color: '#e2e8f0' }}
                >
                  {portalLoading ? 'Opening…' : 'Manage billing'}
                </button>
              </div>

            ) : (
              /* No access — informational only, no CTA */
              <div className="space-y-2">
                <p className="text-sm text-slate-400">No active subscription yet.</p>
                <p className="text-xs text-slate-500">Billing details will appear here once you subscribe.</p>
              </div>
            )}
          </Card>

          {/* ── Devices ──────────────────────────────────────────────────── */}
          <Card title="Registered Devices" icon={<Laptop size={16} />}>
            <div className="space-y-2">
              {devices.length === 0 ? (
                <p className="text-sm text-slate-400">
                  No devices registered yet. Sign in to the desktop app to register automatically.
                </p>
              ) : (
                devices.map((dev: any) => (
                  <div key={dev.id}
                    className="rounded-xl px-3 py-2.5 border"
                    style={{ background: 'var(--raised)', borderColor: 'var(--border)' }}
                  >
                    <p className="text-sm text-white">{dev.device_name ?? 'Unknown Device'}</p>
                    <p className="text-xs text-slate-500">
                      Last seen {new Date(dev.last_seen_at).toLocaleDateString()}
                      {dev.days_old !== undefined && ` · Added ${dev.days_old}d ago`}
                    </p>
                  </div>
                ))
              )}
              {!isAdmin && (
                <p className="text-xs text-slate-500 pt-1">
                  {devices.length} / {license?.max_devices ?? 2} devices used
                </p>
              )}
              {isAdmin && devices.length > 0 && (
                <p className="text-xs pt-1" style={{ color: '#a78bfa' }}>
                  {devices.length} device{devices.length !== 1 ? 's' : ''} registered
                </p>
              )}
            </div>
          </Card>

          {/* ── Getting Started ───────────────────────────────────────────── */}
          <Card title="Getting Started" icon={<Download size={16} />}>
            <div className="space-y-3 text-sm text-slate-400">
              <p>You&rsquo;re all set. Here&rsquo;s how to start using StatfloBot:</p>
              <ol className="space-y-2.5 list-decimal list-inside">
                <li>
                  <span className="text-slate-300 font-medium">Download the StatfloBot desktop app</span>
                  <br />
                  <span className="text-xs text-slate-500 ml-5 block mt-0.5">
                    <a href="/download" className="underline" style={{ color: 'var(--accent-light)' }}>Get the latest version →</a>
                  </span>
                </li>
                <li>
                  <span className="text-slate-300 font-medium">Install and open it</span>
                  <br />
                  <span className="text-xs text-slate-500 ml-5 block mt-0.5">Double-click the installer and follow the prompts</span>
                </li>
                <li>
                  <span className="text-slate-300 font-medium">Sign in with this account</span>
                  <br />
                  <span className="text-xs text-slate-500 ml-5 block mt-0.5">Use {profile?.email ?? 'your email'} to sign in</span>
                </li>
                <li>
                  <span className="text-slate-300 font-medium">Choose your settings and click Start</span>
                  <br />
                  <span className="text-xs text-slate-500 ml-5 block mt-0.5">Select list, mode, and run — access is verified automatically</span>
                </li>
              </ol>
              <p className="text-xs text-slate-500 pt-1 border-t" style={{ borderTopColor: 'var(--border)' }}>
                No manual setup needed — your access is tied to your account login.
              </p>
            </div>
          </Card>

        </div>

        {/* Build fingerprint — visible to admin, hidden otherwise */}
        {isAdmin && buildCommit && (
          <p className="mt-6 text-xs font-mono text-center" style={{ color: '#334155' }}>
            build {buildCommit}
          </p>
        )}
      </main>
    </div>
  );
}

// ── Shared UI pieces ──────────────────────────────────────────────────────────

function Card({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl p-6 border" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
      <div className="flex items-center gap-2 mb-4">
        <span style={{ color: 'var(--accent-light)' }}>{icon}</span>
        <h2 className="text-sm font-semibold text-white">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function StatusBadge({ status, isSubscription }: { status: string; isSubscription?: boolean }) {
  const config: Record<string, { label: string; color: string; bg: string; Icon: any }> = {
    active:   { label: 'Active',   color: '#86efac', bg: 'rgba(134,239,172,0.1)', Icon: CheckCircle },
    trialing: { label: 'Trial',    color: '#fbbf24', bg: 'rgba(251,191,36,0.1)',  Icon: Clock },
    past_due: { label: 'Past due', color: '#f87171', bg: 'rgba(248,113,113,0.1)', Icon: AlertTriangle },
    canceled: { label: 'Canceled', color: '#94a3b8', bg: 'rgba(148,163,184,0.1)', Icon: XCircle },
    inactive: { label: 'Inactive', color: '#94a3b8', bg: 'rgba(148,163,184,0.1)', Icon: XCircle },
    lifetime: { label: 'Lifetime', color: '#a78bfa', bg: 'rgba(167,139,250,0.1)', Icon: Zap },
  };

  const c = config[status] ?? config.inactive;
  const { Icon } = c;

  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium"
      style={{ background: c.bg, color: c.color }}
    >
      <Icon size={12} />
      {c.label}
    </span>
  );
}

function planDisplayName(code?: string): string {
  if (!code) return 'None';
  if (code === 'monthly')  return 'Monthly ($10/mo)';
  if (code === 'lifetime') return 'Lifetime';
  return code;
}
