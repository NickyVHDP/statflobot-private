import { useState, useEffect, useCallback } from 'react';
import { Gift, Copy, Check, Landmark, AlertTriangle, Sparkles, Target } from 'lucide-react';
import ContextualGuideModal from './ContextualGuideModal.jsx';
import { REFERRAL_GUIDE, shouldShowContextualGuide } from '../lib/contextualGuides.js';
import {
  fetchReferralSummary,
  fetchAdminReferrals,
  createReferralCode,
  openReferralBankOnboarding,
} from '../lib/cloudApi';

/**
 * Referral panel for lifetime customers.
 *
 * PRIVACY: referred buyers are never identified here. The server returns only
 * purchase dates and statuses — a referrer does not need to know who bought in
 * order to trust their balance.
 */

const money = (cents) => `${cents < 0 ? '-' : ''}$${(Math.abs(cents ?? 0) / 100).toFixed(2)}`;
const tierRange = (tier) => tier.max === null ? `${tier.min}+` : `${tier.min}–${tier.max}`;

/** Keep in sync with ReferralStatus in monetization/web/lib/referrals.ts. */
const STATUS_COLORS = {
  code_applied:  '#fbbf24', // applied, nothing earned yet
  not_completed: '#64748b',
  purchased:     '#94a3b8',
  available:     '#86efac',
  paid:          '#38bdf8',
  reversed:      '#f87171',
};

function Card({ title, icon, children }) {
  return (
    <div className="rounded-2xl p-6 border" style={{ background: '#13131f', borderColor: 'rgba(255,255,255,0.07)' }}>
      <div className="flex items-center gap-2 mb-5">
        <span style={{ color: '#818cf8' }}>{icon}</span>
        <h2 className="text-sm font-semibold text-white">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function OwnerRewardsPreview({ data, onRefresh, loading }) {
  const queue = data?.queue ?? [];
  const config = data?.config ?? {};
  const total = (field) => queue.reduce((sum, row) => sum + (Number(row?.[field]) || 0), 0);
  const awaitingPayment = queue.reduce((sum, row) => sum + (Number(row?.awaitingPayment) || 0), 0);
  const activeTiers = config.tiers ?? [];
  const standardTiers = config.standardTiers ?? [];

  return (
    <Card title="Referral Rewards" icon={<Gift size={16} />}>
      <div className="rounded-xl px-4 py-3 mb-4" style={{ background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(129,140,248,0.2)' }}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold mb-1" style={{ color: '#c4b5fd' }}>Owner preview</p>
            <p className="text-xs leading-relaxed" style={{ color: '#94a3b8' }}>
              This is the customer Rewards Hub layout filled with real, program-wide totals.
              These amounts are not your personal earnings, and owner accounts never receive a referral code.
            </p>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="px-3 py-1.5 rounded-lg text-[11px] font-medium disabled:opacity-50"
            style={{ border: '1px solid rgba(255,255,255,0.09)', color: '#c4b5fd' }}
          >
            {loading ? 'Refreshing…' : 'Refresh totals'}
          </button>
        </div>
      </div>

      <div className="rounded-xl p-4 mb-4" style={{ background: 'rgba(14,165,233,0.06)', border: '1px solid rgba(56,189,248,0.18)' }}>
        <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
          <div>
            <p className="text-[10px] uppercase tracking-widest" style={{ color: '#38bdf8' }}>
              {config.earlyPricing?.active ? 'Early-adopter program' : 'Standard program'}
            </p>
            <p className="text-sm font-semibold text-white mt-1">
              Lifetime is currently {money(config.lifetimePriceCents ?? 0)}
            </p>
          </div>
          {config.earlyPricing?.active && (
            <p className="text-[11px] text-right" style={{ color: '#94a3b8' }}>
              {config.earlyPricing.remaining} of {config.earlyPricing.cap} early spots remain
              {config.earlyPricing.daysRemaining !== null && <> · up to {config.earlyPricing.daysRemaining} days</>}
            </p>
          )}
        </div>

        <p className="text-[11px] mb-2" style={{ color: '#94a3b8' }}>What members currently earn per qualified purchase</p>
        <div className="grid grid-cols-3 gap-2">
          {activeTiers.map((tier) => (
            <div key={`${tier.min}-${tier.max}`} className="rounded-lg p-2 text-center" style={{ background: 'rgba(0,0,0,0.2)' }}>
              <p className="text-[10px]" style={{ color: '#64748b' }}>{tierRange(tier)} qualified</p>
              <p className="text-sm font-semibold" style={{ color: '#c4b5fd' }}>{money(tier.cents)} each</p>
            </div>
          ))}
        </div>

        {config.earlyPricing?.active && standardTiers.length > 0 && (
          <div className="mt-3 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
            <p className="text-[11px] leading-relaxed" style={{ color: '#94a3b8' }}>
              When Lifetime returns to <strong className="text-white">{money(config.standardLifetimePriceCents)}</strong>, new qualifying purchases use the higher schedule:
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px]" style={{ color: '#86efac' }}>
              {standardTiers.map((tier) => (
                <span key={`${tier.min}-${tier.max}`}>{tierRange(tier)}: {money(tier.cents)} each</span>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        {[
          { label: 'Total paid to referrers', value: money(total('paidCents')), color: '#38bdf8' },
          { label: 'In transit', value: money(total('processingCents')), color: '#fbbf24' },
          { label: 'Ready to pay', value: money(total('eligibleCents')), color: total('eligibleCents') < 0 ? '#f87171' : '#86efac' },
          { label: `Clearing (${config.holdDays ?? 30}d)`, value: money(total('pendingCents')), color: '#94a3b8' },
        ].map(({ label, value, color }) => (
          <div key={label} className="rounded-xl p-3" style={{ background: 'rgba(0,0,0,0.2)' }}>
            <p className="text-[10px] mb-1" style={{ color: '#475569' }}>{label}</p>
            <p className="text-base font-bold" style={{ color }}>{value}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl p-4" style={{ background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-center gap-1.5 mb-3">
          <Target size={13} style={{ color: '#a78bfa' }} />
          <p className="text-[10px] uppercase tracking-widest" style={{ color: '#818cf8' }}>Program snapshot</p>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
          <div><p className="text-lg font-bold text-white">{queue.length}</p><p className="text-[10px]" style={{ color: '#64748b' }}>member codes</p></div>
          <div><p className="text-lg font-bold" style={{ color: '#fbbf24' }}>{awaitingPayment}</p><p className="text-[10px]" style={{ color: '#64748b' }}>awaiting purchase</p></div>
          <div><p className="text-lg font-bold" style={{ color: '#f87171' }}>{money(total('reversedCents'))}</p><p className="text-[10px]" style={{ color: '#64748b' }}>reversed</p></div>
          <div><p className="text-lg font-bold" style={{ color: '#c4b5fd' }}>{config.thresholdCents === null ? 'Not set' : money(config.thresholdCents ?? 0)}</p><p className="text-[10px]" style={{ color: '#64748b' }}>payout threshold</p></div>
        </div>
        <p className="text-[10px] leading-relaxed mt-3" style={{ color: '#475569' }}>
          Member and buyer identities stay private in this Account preview. Payout controls remain in the guarded web owner dashboard.
        </p>
      </div>
    </Card>
  );
}

export default function ReferralPanel({ isLifetime, isAdmin }) {
  const [data,     setData]     = useState(null);
  const [loading,  setLoading]  = useState(false);
  const [err,      setErr]      = useState(null);
  const [copied,     setCopied]     = useState(false);
  const [creating,   setCreating]   = useState(false);
  const [unlocked,   setUnlocked]   = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [showGuide,  setShowGuide]  = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      setData(await (isAdmin ? fetchAdminReferrals() : fetchReferralSummary()));
    } catch (e) {
      // A missing referral table (migration not applied) must not break the
      // Account screen — degrade to hidden rather than showing an error.
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    if (isLifetime || isAdmin) load();
  }, [isLifetime, isAdmin, load]);

  // Bank setup happens in the system browser, not this window, so the app has
  // no return URL to read. Refreshing on focus is how it picks up the new
  // status when the customer switches back after finishing (or abandoning)
  // Stripe-hosted enrollment.
  useEffect(() => {
    if (!isLifetime && !isAdmin) return;
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
    const prior = Number(localStorage.getItem(key) ?? 0);
    if (prior > 0 && rate > prior) setUnlocked(true);
    localStorage.setItem(key, String(rate));
  }, [data?.rewards?.currentRateCents]);

  useEffect(() => {
    if (!isAdmin && data && shouldShowContextualGuide(REFERRAL_GUIDE.id)) setShowGuide(true);
  }, [data, isAdmin]);

  // Admin accounts cannot earn rewards, but may inspect a privacy-safe owner preview.
  if (!isLifetime && !isAdmin) return null;
  if (err && !isAdmin) return null;
  if (loading && !data) {
    return (
      <Card title="Referral Rewards" icon={<Gift size={16} />}>
        <p className="text-xs" style={{ color: '#64748b' }}>{isAdmin ? 'Loading owner preview…' : 'Loading…'}</p>
      </Card>
    );
  }
  if (isAdmin && err) {
    return (
      <Card title="Referral Rewards" icon={<Gift size={16} />}>
        <p className="text-xs mb-3" style={{ color: '#f87171' }}>Owner totals could not be loaded: {err}</p>
        <button type="button" onClick={load} className="px-3 py-1.5 rounded-lg text-xs" style={{ border: '1px solid rgba(255,255,255,0.09)', color: '#c4b5fd' }}>
          Try again
        </button>
      </Card>
    );
  }
  if (!data) return null;
  if (isAdmin) return <OwnerRewardsPreview data={data} onRefresh={load} loading={loading} />;

  const {
    code, codeStatus, balance, accrualCents, holdDays, thresholdCents,
    referrals, payoutsConfigured, automaticPayoutsEnabled, rewards,
  } = data;
  const payoutAccount = data.payoutAccount ?? data.connect;
  const bankReady      = !!payoutAccount.payoutsEnabled;
  const bankNotStarted = !bankReady && (payoutAccount.status ?? 'none') === 'none';
  const bankIncomplete = !bankReady && !bankNotStarted;
  const canConnectBank = !bankReady && payoutsConfigured !== false;

  const awaitingPayment = (referrals ?? []).filter((r) => r.status === 'code_applied').length;
  const unlockTarget = rewards?.nextUnlockAt ? rewards.nextUnlockAt - 1 : null;
  const nextPosition = (rewards?.netQualifiedCount ?? 0) + 1;
  const currentTier = rewards?.tiers?.find((tier) =>
    nextPosition >= tier.min && (tier.max === null || nextPosition <= tier.max)
  );
  const priorTarget = Math.max(0, (currentTier?.min ?? 1) - 1);
  const progress = unlockTarget
    ? Math.min(100, Math.max(0, ((rewards.netQualifiedCount - priorTarget) / (unlockTarget - priorTarget)) * 100))
    : 100;
  const activeTiers = rewards?.tiers ?? [];
  const standardTiers = rewards?.standardTiers ?? [];

  async function handleCreate() {
    setCreating(true); setErr(null);
    try {
      await createReferralCode();
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setCreating(false);
    }
  }

  function handleCopy() {
    const link = `https://statflobot.store/?ref=${code}`;
    navigator.clipboard?.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  async function handleConnect() {
    setErr(null);
    setConnecting(true);
    // A fresh, single-use Stripe link is minted on every click, so a link
    // that already expired or was used never needs to be reused or retried
    // — the next click always gets a brand-new one.
    try { await openReferralBankOnboarding(); }
    catch (e) { setErr(e.message); }
    finally { setConnecting(false); }
  }

  return (
    <>
    <Card title="Referral Rewards" icon={<Gift size={16} />}>
      <div className="rounded-xl px-4 py-3 mb-4" style={{ background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(129,140,248,0.2)' }}>
        <p className="text-xs font-semibold mb-1" style={{ color: '#c4b5fd' }}>Completely optional</p>
        <p className="text-xs leading-relaxed" style={{ color: '#94a3b8' }}>
          If StatfloBot could help another rep, you can share it and may earn a reward.
          You never need to refer anyone to keep your Lifetime access or features.
        </p>
        <button type="button" onClick={() => setShowGuide(true)} className="text-[11px] font-medium mt-2" style={{ color: '#818cf8' }}>
          How Referral Rewards works
        </button>
      </div>
      <p className="text-xs mb-4" style={{ color: '#64748b' }}>
        Share StatfloBot with a new customer who buys Lifetime using your code.
        Your current reward is <strong style={{ color: '#c4b5fd' }}>{money(rewards?.currentRateCents ?? accrualCents)}</strong> per qualified purchase.
        You will see a referral here as soon as someone applies your code at checkout —
        it earns nothing until they pay. Rewards are then held for {holdDays} days before
        becoming payable.
      </p>

      <div className="rounded-xl p-4 mb-4" style={{ background: 'rgba(14,165,233,0.06)', border: '1px solid rgba(56,189,248,0.18)' }}>
        <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
          <div>
            <p className="text-[10px] uppercase tracking-widest" style={{ color: '#38bdf8' }}>
              {rewards?.earlyPricing?.active ? 'Early-adopter program' : 'Standard program'}
            </p>
            <p className="text-sm font-semibold text-white mt-1">
              Lifetime is currently {money(rewards?.lifetimePriceCents ?? 0)}
            </p>
          </div>
          {rewards?.earlyPricing?.active && (
            <p className="text-[11px] text-right" style={{ color: '#94a3b8' }}>
              {rewards.earlyPricing.remaining} of {rewards.earlyPricing.cap} early spots remain
              {rewards.earlyPricing.daysRemaining !== null && <> · up to {rewards.earlyPricing.daysRemaining} days</>}
            </p>
          )}
        </div>

        <p className="text-[11px] mb-2" style={{ color: '#94a3b8' }}>Current reward schedule</p>
        <div className="grid grid-cols-3 gap-2">
          {activeTiers.map((tier) => (
            <div key={`${tier.min}-${tier.max}`} className="rounded-lg p-2 text-center" style={{ background: 'rgba(0,0,0,0.2)' }}>
              <p className="text-[10px]" style={{ color: '#64748b' }}>{tierRange(tier)} qualified</p>
              <p className="text-sm font-semibold" style={{ color: '#c4b5fd' }}>{money(tier.cents)} each</p>
            </div>
          ))}
        </div>

        {rewards?.earlyPricing?.active && (
          <div className="mt-3 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
            <p className="text-[11px] leading-relaxed" style={{ color: '#94a3b8' }}>
              Early pricing ends when the time window closes or the remaining spots are claimed, whichever happens first.
              Lifetime then returns to <strong className="text-white">{money(rewards.standardLifetimePriceCents)}</strong>, and new qualifying purchases use:
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px]" style={{ color: '#86efac' }}>
              {standardTiers.map((tier) => (
                <span key={`${tier.min}-${tier.max}`}>{tierRange(tier)}: {money(tier.cents)} each</span>
              ))}
            </div>
          </div>
        )}

        <p className="text-[10px] leading-relaxed mt-3" style={{ color: '#64748b' }}>
          Each reward locks to the rate in effect when that referred Lifetime purchase qualifies. Rewards already earned are never repriced.
        </p>
      </div>

      {!code ? (
        <button
          onClick={handleCreate}
          disabled={creating}
          className="px-4 py-2 rounded-xl text-sm font-medium transition-all disabled:opacity-50"
          style={{ background: '#7c3aed', color: '#fff' }}
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
              style={{ background: 'rgba(0,0,0,0.3)', color: '#a78bfa', border: '1px solid rgba(255,255,255,0.07)' }}
            >
              {code}
            </code>
            <button
              onClick={handleCopy}
              title="Copy your share link"
              className="px-3 py-2 rounded-lg text-xs transition-colors"
              style={{ border: '1px solid rgba(255,255,255,0.09)', color: '#94a3b8' }}
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
              {activeTiers.map((tier) => <span key={`${tier.min}-${tier.max}`}>{money(tier.cents)}</span>)}
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

          {/* Bank deposit — Stripe-hosted enrollment. Automatic sending remains
              subject to the server-side hold, funding, bank-readiness and
              safety controls shown below. */}
          <div className="pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
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
                  style={{ border: '1px solid rgba(255,255,255,0.09)', color: '#c4b5fd' }}
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
                {' '}Stripe opens in your browser — come back to this app afterward to see your status.
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
            <div className="mt-4 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              <p className="text-[10px] mb-2" style={{ color: '#475569' }}>
                {referrals.length} referral{referrals.length === 1 ? '' : 's'}
                {awaitingPayment > 0 && ` · ${awaitingPayment} awaiting payment`}
              </p>
              <div className="flex flex-col gap-1">
                {referrals.slice(0, 8).map((r, i) => (
                  <div key={i} className="flex justify-between gap-3 text-[11px]">
                    <span style={{ color: '#64748b' }}>
                      {new Date(r.at).toLocaleDateString()}
                    </span>
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

      {err && <p className="text-xs mt-3" style={{ color: '#f87171' }}>{err}</p>}
    </Card>
    {showGuide && (
      <ContextualGuideModal
        guide={REFERRAL_GUIDE}
        onClose={() => setShowGuide(false)}
        onConfirm={() => setShowGuide(false)}
      />
    )}
    </>
  );
}
