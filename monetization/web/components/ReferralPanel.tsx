'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy, Gift, Landmark } from 'lucide-react';

/**
 * Referral panel for the web dashboard.
 *
 * Mirrors ui/client/src/components/ReferralPanel.jsx so the site and desktop
 * app present the same program state.
 *
 * PRIVACY: referred buyers are never identified. The summary endpoint returns
 * only purchase dates and statuses — the referrer does not need to know who
 * bought in order to trust their balance.
 */

interface Props {
  /** Only lifetime customers see the panel; admins are excluded from the program. */
  isLifetime: boolean;
  isAdmin:    boolean;
}

const money = (cents: number) => `${cents < 0 ? '-' : ''}$${(Math.abs(cents ?? 0) / 100).toFixed(2)}`;

/** Keep in sync with ReferralStatus in monetization/web/lib/referrals.ts. */
const STATUS_COLORS: Record<string, string> = {
  code_applied:  '#fbbf24', // applied, nothing earned yet
  not_completed: '#64748b',
  purchased:     '#94a3b8',
  available:     '#86efac',
  paid:          '#38bdf8',
  reversed:      '#f87171',
};

export default function ReferralPanel({ isLifetime, isAdmin }: Props) {
  const [data,     setData]     = useState<any>(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [copied,   setCopied]   = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/referrals/summary');
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      setData(await res.json());
      setError(null);
    } catch (err: any) {
      // A missing referral table (migration not applied) must not break the
      // dashboard — degrade to hidden rather than showing a scary error.
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isLifetime && !isAdmin) load();
  }, [isLifetime, isAdmin, load]);

  if (!isLifetime || isAdmin) return null;
  if (error) return null;
  if (!data) {
    return loading ? (
      <div className="mt-6 rounded-2xl p-6 border" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
        <p className="text-xs text-slate-500">Loading referrals…</p>
      </div>
    ) : null;
  }

  const {
    code, codeStatus, balance, accrualCents, holdDays, thresholdCents,
    connect, referrals, payoutsConfigured,
  } = data;

  const awaitingPayment = (referrals ?? []).filter((r: any) => r.status === 'code_applied').length;

  async function handleCreate() {
    setCreating(true);
    try {
      const res = await fetch('/api/referrals/code', { method: 'POST' });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Could not create a code');
      await load();
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function handleConnect() {
    try {
      const res = await fetch('/api/referrals/connect/onboard', { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not start bank onboarding');
      window.location.href = body.url;
    } catch (err: any) {
      setError(err.message);
    }
  }

  function handleCopy() {
    navigator.clipboard.writeText(`${window.location.origin}/?ref=${code}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="mt-6 rounded-2xl p-6 border" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
      <div className="flex items-center gap-2 mb-4">
        <Gift size={16} style={{ color: '#818cf8' }} />
        <h2 className="text-sm font-semibold text-white">Referrals</h2>
      </div>

      <p className="text-xs mb-4" style={{ color: '#64748b' }}>
        Earn {money(accrualCents)} for each new customer who buys Lifetime with your code.
        You will see a referral here as soon as someone applies your code at checkout —
        it earns nothing until they pay. Rewards are then held for {holdDays} days before
        becoming payable.
      </p>

      {!code ? (
        <button
          onClick={handleCreate}
          disabled={creating}
          className="px-4 py-2 rounded-xl text-sm font-medium transition-all disabled:opacity-50"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          {creating ? 'Creating…' : 'Get my referral code'}
        </button>
      ) : (
        <>
          <p className="text-[10px] uppercase tracking-widest mb-1.5" style={{ color: '#475569' }}>
            Your referral code
          </p>
          <div className="flex items-center gap-2 mb-4">
            <code
              className="flex-1 px-3 py-2 rounded-lg text-sm font-mono tracking-widest"
              style={{ background: 'rgba(0,0,0,0.25)', color: '#a78bfa', border: '1px solid var(--border)' }}
            >
              {code}
            </code>
            <button
              onClick={handleCopy}
              className="px-3 py-2 rounded-lg text-xs transition-colors"
              style={{ border: '1px solid var(--border)', color: '#94a3b8' }}
              title="Copy your share link"
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </div>

          {codeStatus !== 'active' && (
            <p className="text-xs mb-3" style={{ color: '#f87171' }}>
              This code is currently disabled. Contact support if you think that is a mistake.
            </p>
          )}

          <div className="grid grid-cols-3 gap-3 mb-4">
            {[
              // "Clearing", not "Pending" — pending was ambiguous between
              // "someone applied my code" and "paid, inside the hold".
              { label: `Clearing (${holdDays}d)`, value: money(balance.pendingCents),  color: '#94a3b8' },
              { label: 'Available',               value: money(balance.eligibleCents), color: balance.isNegative ? '#f87171' : '#86efac' },
              { label: 'Paid out',                value: money(balance.paidCents),     color: '#94a3b8' },
            ].map(({ label, value, color }) => (
              <div key={label} className="rounded-xl p-3" style={{ background: 'rgba(0,0,0,0.2)' }}>
                <p className="text-[10px] mb-1" style={{ color: '#475569' }}>{label}</p>
                <p className="text-base font-bold" style={{ color }}>{value}</p>
              </div>
            ))}
          </div>

          {balance.isNegative && (
            <div
              className="flex gap-2 rounded-xl px-3 py-2.5 mb-4 text-xs leading-relaxed"
              style={{ background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.25)', color: '#fca5a5' }}
            >
              <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
              <span>
                A referred purchase was refunded or charged back after its reward was paid.
                The balance above will be offset against future rewards.
              </span>
            </div>
          )}

          <div className="flex items-center justify-between gap-3 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
            <div className="flex items-center gap-2">
              <Landmark size={14} style={{ color: connect.payoutsEnabled ? '#86efac' : '#64748b' }} />
              <span className="text-xs" style={{ color: '#94a3b8' }}>
                {connect.payoutsEnabled
                  ? 'Bank account connected'
                  : connect.status === 'pending'
                    ? 'Bank setup incomplete'
                    : 'No bank account connected'}
              </span>
            </div>
            {!connect.payoutsEnabled && (
              <button
                onClick={handleConnect}
                className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                style={{ border: '1px solid var(--border)', color: '#c4b5fd' }}
              >
                {connect.status === 'pending' ? 'Finish setup' : 'Connect bank'}
              </button>
            )}
          </div>

          {/* Payout wording states exactly what happens: a person reviews and
              approves each one. Nothing here promises an automatic transfer,
              because there is no automatic transfer. */}
          <p className="text-[11px] mt-3" style={{ color: '#475569' }}>
            {payoutsConfigured === false
              ? 'Payouts are sent manually after review. Connecting a bank account now means you are ready when yours is approved.'
              : thresholdCents === null
                ? 'Every payout is reviewed and approved by hand before it is sent.'
                : `Every payout is reviewed and approved by hand once your available balance reaches ${money(thresholdCents)}.`}
          </p>

          {referrals?.length > 0 && (
            <div className="mt-4 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
              <p className="text-[10px] mb-2" style={{ color: '#475569' }}>
                {referrals.length} referral{referrals.length === 1 ? '' : 's'}
                {awaitingPayment > 0 && ` · ${awaitingPayment} awaiting payment`}
              </p>
              <div className="flex flex-col gap-1">
                {referrals.slice(0, 8).map((r: any, i: number) => (
                  <div key={i} className="flex justify-between gap-3 text-[11px]">
                    <span style={{ color: '#64748b' }}>{new Date(r.at).toLocaleDateString()}</span>
                    <span className="text-right" style={{ color: STATUS_COLORS[r.status] ?? '#94a3b8' }}>
                      {r.label ?? r.status}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-[10px] mt-2 leading-relaxed" style={{ color: '#475569' }}>
                Referred customers are never identified here. A code applied at
                checkout earns nothing until that purchase is paid for.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
