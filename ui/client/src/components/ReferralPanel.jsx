import { useState, useEffect, useCallback } from 'react';
import { Gift, Copy, Check, Landmark, AlertTriangle } from 'lucide-react';
import {
  fetchReferralSummary,
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

export default function ReferralPanel({ isLifetime, isAdmin }) {
  const [data,     setData]     = useState(null);
  const [loading,  setLoading]  = useState(false);
  const [err,      setErr]      = useState(null);
  const [copied,   setCopied]   = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      setData(await fetchReferralSummary());
    } catch (e) {
      // A missing referral table (migration not applied) must not break the
      // Account screen — degrade to hidden rather than showing an error.
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isLifetime && !isAdmin) load();
  }, [isLifetime, isAdmin, load]);

  // Admin accounts are excluded from the program; non-lifetime users have nothing to show.
  if (!isLifetime || isAdmin) return null;
  if (err) return null;
  if (loading && !data) {
    return (
      <Card title="Referrals" icon={<Gift size={16} />}>
        <p className="text-xs" style={{ color: '#64748b' }}>Loading…</p>
      </Card>
    );
  }
  if (!data) return null;

  const {
    code, codeStatus, balance, accrualCents, holdDays, thresholdCents,
    connect, referrals, payoutsConfigured,
  } = data;

  const awaitingPayment = (referrals ?? []).filter((r) => r.status === 'code_applied').length;

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
    try { await openReferralBankOnboarding(); }
    catch (e) { setErr(e.message); }
  }

  return (
    <Card title="Referrals" icon={<Gift size={16} />}>
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

          {/* Bank connection */}
          <div className="flex items-center justify-between gap-3 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
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
                style={{ border: '1px solid rgba(255,255,255,0.09)', color: '#c4b5fd' }}
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

      {err && <p className="text-xs mt-3" style={{ color: '#f87171' }}>{err}</p>}
    </Card>
  );
}
