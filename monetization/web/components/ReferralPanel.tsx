'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy, Gift, Info, Landmark, Sparkles, Target } from 'lucide-react';

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
  const [copied,     setCopied]     = useState(false);
  const [creating,   setCreating]   = useState(false);
  const [unlocked,   setUnlocked]   = useState(false);
  const [connecting, setConnecting] = useState(false);
  /** Set from ?referralPayout=complete|refresh on the way back from Stripe. */
  const [returnState, setReturnState] = useState<'complete' | 'refresh' | null>(null);

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

  // Stripe returns here as ?referralPayout=complete|refresh. Capture it once,
  // then strip it from the URL so it can't reappear on refresh or back-nav.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const status = params.get('referralPayout');
    if (status !== 'complete' && status !== 'refresh') return;
    setReturnState(status);
    params.delete('referralPayout');
    const query = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (query ? `?${query}` : ''));
  }, []);

  // Catches coming back from the Stripe tab after bank setup finished.
  useEffect(() => {
    if (!isLifetime || isAdmin) return;
    const onFocus = () => load();
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [isLifetime, isAdmin, load]);

  useEffect(() => {
    const rate = data?.rewards?.currentRateCents;
    if (!rate) return;
    const key = 'statflobot-referral-reward-rate';
    const prior = Number(window.localStorage.getItem(key) ?? 0);
    if (prior > 0 && rate > prior) setUnlocked(true);
    window.localStorage.setItem(key, String(rate));
  }, [data?.rewards?.currentRateCents]);

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
    referrals, payoutsConfigured, automaticPayoutsEnabled, rewards,
  } = data;
  const payoutAccount = data.payoutAccount ?? data.connect;
  const bankReady      = !!payoutAccount.payoutsEnabled;
  const bankNotStarted = !bankReady && (payoutAccount.status ?? 'none') === 'none';
  const bankIncomplete = !bankReady && !bankNotStarted;
  const canConnectBank = !bankReady && payoutsConfigured !== false;

  const awaitingPayment = (referrals ?? []).filter((r: any) => r.status === 'code_applied').length;
  const unlockTarget = rewards?.nextUnlockAt ? rewards.nextUnlockAt - 1 : null;
  const nextPosition = (rewards?.netQualifiedCount ?? 0) + 1;
  const currentTier = rewards?.tiers?.find((tier: any) =>
    nextPosition >= tier.min && (tier.max === null || nextPosition <= tier.max)
  );
  const priorTarget = Math.max(0, (currentTier?.min ?? 1) - 1);
  const progress = unlockTarget
    ? Math.min(100, Math.max(0, ((rewards.netQualifiedCount - priorTarget) / (unlockTarget - priorTarget)) * 100))
    : 100;

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
    setConnecting(true);
    try {
      // A fresh, single-use Stripe link is minted on every click, so a link
      // that already expired or was used never needs to be reused or retried
      // — the next click always gets a brand-new one.
      const res = await fetch('/api/referrals/connect/onboard', { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not start bank setup. Please try again.');
      window.location.href = body.url;
    } catch (err: any) {
      setError(err.message);
      setConnecting(false);
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
        <h2 className="text-sm font-semibold text-white">Referral Rewards</h2>
      </div>

      <p className="text-xs mb-4" style={{ color: '#64748b' }}>
        Share StatfloBot with a new customer who buys Lifetime using your code.
        Your current reward is <strong style={{ color: '#c4b5fd' }}>{money(rewards?.currentRateCents ?? accrualCents)}</strong> per qualified purchase.
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

          <div
            className="rounded-xl p-4 mb-4"
            style={{ background: 'linear-gradient(135deg, rgba(99,102,241,0.16), rgba(139,92,246,0.08))', border: '1px solid rgba(129,140,248,0.2)' }}
          >
            <div className="flex items-start justify-between gap-4 mb-3">
              <div>
                <div className="flex items-center gap-1.5 mb-1">
                  <Target size={13} style={{ color: '#a78bfa' }} />
                  <p className="text-[10px] uppercase tracking-widest" style={{ color: '#818cf8' }}>Reward level</p>
                </div>
                <p className="text-xl font-bold text-white">{money(rewards?.currentRateCents ?? accrualCents)} each</p>
                <p className="text-[11px] mt-1" style={{ color: '#94a3b8' }}>
                  {rewards?.nextRateCents
                    ? `${rewards.referralsToUnlock} more qualified referral${rewards.referralsToUnlock === 1 ? '' : 's'} unlocks ${money(rewards.nextRateCents)} each.`
                    : 'Top reward level unlocked — every future qualified referral earns the maximum rate.'}
                </p>
              </div>
              <div className="text-right">
                <p className="text-2xl font-bold" style={{ color: '#c4b5fd' }}>{rewards?.netQualifiedCount ?? 0}</p>
                <p className="text-[10px]" style={{ color: '#64748b' }}>qualified</p>
              </div>
            </div>
            <div className="h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.07)' }}>
              <div className="h-full rounded-full transition-all duration-700" style={{ width: `${progress}%`, background: 'linear-gradient(90deg,#6366f1,#a78bfa)' }} />
            </div>
            <div className="flex justify-between mt-2 text-[9px]" style={{ color: '#64748b' }}>
              {['$10', '$15', '$20', '$25 max'].map((label) => <span key={label}>{label}</span>)}
            </div>
            {unlocked && (
              <div className="flex items-center gap-2 mt-3 text-xs" style={{ color: '#86efac' }}>
                <Sparkles size={13} /> New reward level unlocked. Thank you for helping StatfloBot grow.
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            {[
              // "Clearing", not "Pending" — pending was ambiguous between
              // "someone applied my code" and "paid, inside the hold".
              { label: `Clearing (${holdDays}d)`, value: money(balance.pendingCents),  color: '#94a3b8' },
              { label: 'Available',               value: money(balance.eligibleCents), color: balance.isNegative ? '#f87171' : '#86efac' },
              { label: 'In transit',              value: money(balance.processingCents ?? 0), color: '#fbbf24' },
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

          {/* Bank deposit — Stripe-hosted enrollment. One button; the owner
              approves every reward by hand, so nothing here implies an
              automatic transfer. */}
          <div className="pt-3" style={{ borderTop: '1px solid var(--border)' }}>
            {returnState && (
              <div
                className="flex gap-2 rounded-xl px-3 py-2.5 mb-3 text-xs leading-relaxed"
                style={{ background: 'rgba(129,140,248,0.1)', border: '1px solid rgba(129,140,248,0.25)', color: '#c4b5fd' }}
              >
                <Info size={13} className="flex-shrink-0 mt-0.5" />
                <span>
                  {returnState === 'complete'
                    ? bankReady
                      ? "You're back from Stripe — bank deposit ready."
                      : "You're back from Stripe. We're confirming your bank setup — this can take a minute. If it still shows incomplete below, click Finish bank setup to continue."
                    : "Bank setup wasn't finished. No problem — click the button below whenever you're ready to pick it back up."}
                </span>
              </div>
            )}

            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Landmark size={14} style={{ color: bankReady ? '#86efac' : '#64748b' }} />
                <span className="text-xs" style={{ color: '#94a3b8' }}>
                  {bankReady
                    ? 'Bank deposit ready'
                    : bankIncomplete
                      ? 'Bank setup incomplete'
                      : 'Bank deposit not connected'}
                </span>
              </div>
              {canConnectBank && (
                <button
                  onClick={handleConnect}
                  disabled={connecting}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                  style={{ border: '1px solid var(--border)', color: '#c4b5fd' }}
                >
                  {connecting ? 'Opening Stripe…' : bankIncomplete ? 'Finish bank setup' : 'Connect bank securely'}
                </button>
              )}
            </div>

            {canConnectBank && (
              <p className="text-[11px] mt-2 leading-relaxed" style={{ color: '#64748b' }}>
                Stripe securely collects your bank details for direct deposit — StatfloBot never
                sees or stores your bank account or routing numbers. Setup is normally one-time.
                {automaticPayoutsEnabled
                  ? ' Eligible rewards are checked for automatic bank deposit each day after the 30-day hold.'
                  : ' Every reward remains tracked until payout sending is available.'}
              </p>
            )}
          </div>

          <p className="text-[11px] mt-3" style={{ color: '#475569' }}>
            {payoutsConfigured === false
              ? 'Rewards are tracked safely while payout enrollment is being prepared. No action is needed yet.'
              : automaticPayoutsEnabled
                ? `After the 30-day hold, eligible rewards of ${thresholdCents === null ? '$10.00' : money(thresholdCents)} or more are scheduled for automatic bank deposit when your bank is ready and program funds are available.`
                : 'Your eligible rewards remain visible here while automatic bank deposits are disabled.'}
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
                      {r.amountCents ? `${money(r.amountCents)} · ` : ''}{r.label ?? r.status}
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
