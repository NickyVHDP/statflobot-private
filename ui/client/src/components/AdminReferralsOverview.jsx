import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Check, ChevronDown, ChevronRight, CircleDollarSign,
  Gift, Loader2, RefreshCw, ShieldCheck, UserRound,
} from 'lucide-react';
import { adminReferralAction, fetchAdminReferrals } from '../lib/cloudApi.js';
import { summarizeReferrals } from '../lib/ownerAttention.js';

const money = cents => `${cents < 0 ? '-' : ''}$${(Math.abs(cents || 0) / 100).toFixed(2)}`;
const when = value => value ? new Date(value).toLocaleString() : '—';
const day = value => value ? new Date(value).toLocaleDateString() : '—';

function Stat({ label, value, hint, color = '#e2e8f0' }) {
  return (
    <div className="rounded-lg p-3" style={{ background: '#0e0e14', border: '1px solid #222233' }}>
      <div className="text-[11px]" style={{ color: '#64748b' }}>{label}</div>
      <div className="text-xl font-semibold mt-0.5" style={{ color }}>{value}</div>
      {hint && <div className="text-[10px] mt-0.5" style={{ color: '#475569' }}>{hint}</div>}
    </div>
  );
}

function Identity({ name, email, fallback }) {
  return (
    <div className="min-w-0">
      <div className="text-xs truncate" style={{ color: '#e2e8f0' }}>{name || email || fallback}</div>
      {name && email && <div className="text-[10px] truncate" style={{ color: '#64748b' }}>{email}</div>}
    </div>
  );
}

export default function AdminReferralsOverview({ onLoaded, refreshToken = 0 }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(null);
  const [showDetail, setShowDetail] = useState(true);
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchAdminReferrals();
      setData(next);
      onLoadedRef.current?.(summarizeReferrals(next));
    } catch (err) {
      setError(err.status === 403
        ? 'The full referral ledger is restricted to the verified owner account.'
        : 'Referral activity is temporarily unavailable.');
      onLoadedRef.current?.(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, refreshToken]);
  const summary = useMemo(() => summarizeReferrals(data), [data]);
  const queue = data?.queue ?? [];
  const activity = data?.referralActivity ?? [];

  async function act(action, row, attributionId, confirmation) {
    const key = `${row.referrerUserId}:${action}:${attributionId ?? ''}`;
    setBusy(key);
    setNotice(null);
    try {
      const result = await adminReferralAction({ action, referrerUserId: row.referrerUserId, attributionId, confirmation });
      setNotice(action === 'preflight'
        ? result.ok
          ? `Ready to pay ${money(result.eligibleCents)} to ${row.referrerEmail || row.code}.`
          : `Blocked: ${result.detail ?? result.reason}`
        : result.providerStatus === 'paid'
          ? `Payout posted: ${money(result.amountCents)} to ${row.referrerEmail || row.code}.`
          : `Payout submitted to Stripe: ${money(result.amountCents)}.`);
      if (action !== 'preflight') await load();
    } catch (err) {
      setNotice(`Could not complete payout: ${err.message}`);
    } finally {
      setBusy(null);
    }
  }

  function approve(row) {
    const expected = `PAY ${row.code}`;
    const typed = window.prompt(
      `Owner approval sends ${money(row.eligibleCents)} through Stripe to ${row.referrerEmail || row.code}.\n\nType exactly:\n\n${expected}`
    );
    if (typed?.trim().toUpperCase() === expected) act('approve', row, undefined, typed);
  }

  function approveEarly(row, reward) {
    const total = row.eligibleCents + reward.amountCents;
    const expected = `PAY NOW ${row.code} ${money(total)}`.toUpperCase();
    const typed = window.prompt(
      `This bypasses the remaining 30-day hold for one referral and sends the full available balance (${money(total)}).\n\nType exactly:\n\n${expected}`
    );
    if (typed?.trim().toUpperCase() === expected) act('approve-early', row, reward.attributionId, typed);
  }

  return (
    <section className="rounded-xl p-5" style={{ background: '#13131a', border: '1px solid #1e1e2e' }}>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <div className="flex items-center gap-2">
            <Gift size={16} style={{ color: '#a78bfa' }} />
            <h3 className="text-sm font-semibold text-white">Referral Rewards & Payouts</h3>
            <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ color: '#a78bfa', background: 'rgba(167,139,250,0.12)' }}>Owner only</span>
          </div>
          <p className="text-xs mt-1 max-w-xl" style={{ color: '#64748b' }}>
            See who referred each buyer, track the 30-day hold, and approve an eligible or early payout.
          </p>
        </div>
        <button onClick={load} disabled={loading} className="p-2 rounded-lg disabled:opacity-50" style={{ color: '#94a3b8', background: '#1e1e2e' }} title="Refresh referrals">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && <div className="rounded-lg px-3 py-2 text-xs mb-3" style={{ color: '#fca5a5', background: 'rgba(239,68,68,0.08)' }}>{error}</div>}
      {notice && <div className="rounded-lg px-3 py-2 text-xs mb-3" style={{ color: '#c4b5fd', background: 'rgba(124,58,237,0.10)' }}>{notice}</div>}
      {loading && !data ? (
        <div className="h-28 flex items-center justify-center gap-2 text-sm" style={{ color: '#64748b' }}><Loader2 size={15} className="animate-spin" /> Loading referral activity…</div>
      ) : data && (
        <>
          {!data.config?.payoutsEnabled && (
            <div className="rounded-lg px-3 py-2.5 text-xs mb-4 flex gap-2" style={{ color: '#fcd34d', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.18)' }}>
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <span>Payout sending is disabled in production settings. Tracking remains active, but approval cannot move money.</span>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-4 gap-2 mb-3">
            <Stat label="Outstanding liability" value={money(summary.outstandingCents)} hint="Clearing + eligible + in transit" color={summary.outstandingCents ? '#c4b5fd' : '#64748b'} />
            <Stat label="Eligible now" value={money(queue.reduce((sum, row) => sum + Math.max(0, row.eligibleCents || 0), 0))} hint="Can be owner-approved" color="#86efac" />
            <Stat label="Clearing" value={money(queue.reduce((sum, row) => sum + Math.max(0, row.pendingCents || 0), 0))} hint={`${data.config?.holdDays ?? 30}-day protection period`} color="#fbbf24" />
            <Stat label="Available funding" value={data.config?.financialAccountAvailableCents == null ? 'Unavailable' : money(data.config.financialAccountAvailableCents)} hint="Stripe payout account" color="#60a5fa" />
          </div>

          <button onClick={() => setShowDetail(open => !open)} className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg" style={{ color: '#94a3b8', background: '#1a1a27' }} aria-expanded={showDetail}>
            {showDetail ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {showDetail ? 'Hide' : 'Show'} payout controls and referral ledger
          </button>

          {showDetail && (
            <div className="space-y-3 mt-3">
              <div className="rounded-lg border overflow-hidden" style={{ borderColor: '#222233', background: '#0e0e14' }}>
                <div className="px-3 py-2.5 flex items-center gap-2" style={{ borderBottom: '1px solid #222233' }}>
                  <CircleDollarSign size={14} style={{ color: '#86efac' }} />
                  <span className="text-xs font-semibold" style={{ color: '#cbd5e1' }}>Payout controls</span>
                </div>
                {queue.length === 0 ? (
                  <div className="p-5 text-xs text-center" style={{ color: '#64748b' }}>No referral codes have been issued.</div>
                ) : (
                  <div className="divide-y" style={{ borderColor: '#1a1a27' }}>
                    {queue.map(row => {
                      const canApprove = row.meetsThreshold && row.payoutsEnabled && data.config.payoutsEnabled && !row.isNegative;
                      return (
                        <Fragment key={row.referrerUserId}>
                          <div className="p-3 flex flex-wrap items-center gap-3">
                            <UserRound size={14} style={{ color: '#64748b' }} />
                            <div className="min-w-[190px] flex-1">
                              <Identity name={row.referrerName} email={row.referrerEmail} fallback={row.code} />
                              <div className="text-[10px] font-mono mt-0.5" style={{ color: '#475569' }}>{row.code}</div>
                            </div>
                            <div className="text-right">
                              <div className="text-[10px]" style={{ color: '#64748b' }}>Clearing / eligible</div>
                              <div className="text-xs" style={{ color: '#e2e8f0' }}>{money(row.pendingCents)} / <span style={{ color: '#86efac' }}>{money(row.eligibleCents)}</span></div>
                            </div>
                            <div className="min-w-[180px] text-[10px]" style={{ color: row.payoutsEnabled ? '#94a3b8' : '#fbbf24' }}>{row.automaticNextStep}</div>
                            <button onClick={() => act('preflight', row)} disabled={busy !== null} className="text-[11px] px-2.5 py-1.5 rounded-lg disabled:opacity-40" style={{ color: '#94a3b8', border: '1px solid #2a2a3e' }}>Check</button>
                            <button onClick={() => approve(row)} disabled={busy !== null || !canApprove} className="text-[11px] px-2.5 py-1.5 rounded-lg font-semibold disabled:opacity-30" style={{ color: '#fff', background: '#7c3aed' }} title={canApprove ? 'Approve the full eligible balance' : row.automaticNextStep}>Approve payout</button>
                          </div>
                          {row.pendingRewards?.map(reward => {
                            const total = row.eligibleCents + reward.amountCents;
                            const canPayEarly = total >= (data.config.thresholdCents ?? Number.POSITIVE_INFINITY) && row.payoutsEnabled && data.config.payoutsEnabled && !row.isNegative;
                            return (
                              <div key={reward.attributionId} className="px-3 pb-3 pl-10 flex flex-wrap items-center gap-2 text-[10px]">
                                <span style={{ color: '#fbbf24' }}>{money(reward.amountCents)} clearing until {day(reward.eligibleAt)}</span>
                                <button onClick={() => approveEarly(row, reward)} disabled={busy !== null || !canPayEarly} className="px-2 py-1 rounded-md disabled:opacity-30" style={{ color: '#c4b5fd', border: '1px solid rgba(167,139,250,.3)' }}>Approve early</button>
                              </div>
                            );
                          })}
                        </Fragment>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="rounded-lg border overflow-hidden" style={{ borderColor: '#222233', background: '#0e0e14' }}>
                <div className="px-3 py-2.5 flex items-center gap-2" style={{ borderBottom: '1px solid #222233' }}>
                  <ShieldCheck size={14} style={{ color: '#60a5fa' }} />
                  <span className="text-xs font-semibold" style={{ color: '#cbd5e1' }}>Who referred whom</span>
                  <span className="text-[10px]" style={{ color: '#475569' }}>{activity.length} qualified purchase{activity.length === 1 ? '' : 's'}</span>
                </div>
                {activity.length === 0 ? (
                  <div className="p-5 text-xs text-center" style={{ color: '#64748b' }}>No completed referral purchases yet.</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs min-w-[820px]">
                      <thead><tr style={{ color: '#64748b', borderBottom: '1px solid #222233' }}>
                        <th className="text-left px-3 py-2.5">Referrer</th><th className="text-left px-3 py-2.5">Referred customer</th><th className="text-left px-3 py-2.5">Purchased</th><th className="text-right px-3 py-2.5">Reward</th><th className="text-left px-3 py-2.5">Eligible</th><th className="text-left px-3 py-2.5">Status</th>
                      </tr></thead>
                      <tbody>{activity.map(item => {
                        const statusColor = item.status === 'reversed' ? '#f87171' : item.status === 'eligible' ? '#86efac' : '#fbbf24';
                        return (
                          <tr key={item.attributionId} style={{ borderBottom: '1px solid #1a1a27' }}>
                            <td className="px-3 py-3"><Identity name={item.referrerName} email={item.referrerEmail} fallback={item.referralCode} /></td>
                            <td className="px-3 py-3" style={{ color: '#cbd5e1' }}>{item.referredEmail || item.referredUserId || 'Guest buyer'}</td>
                            <td className="px-3 py-3" style={{ color: '#94a3b8' }}>{when(item.purchasedAt)}</td>
                            <td className="text-right px-3 py-3" style={{ color: '#c4b5fd' }}>{money(item.amountCents)}</td>
                            <td className="px-3 py-3" style={{ color: '#94a3b8' }}>{day(item.eligibleAt)}</td>
                            <td className="px-3 py-3"><span className="inline-flex items-center gap-1" style={{ color: statusColor }}>{item.status === 'eligible' && <Check size={11} />}{item.earlyApproved ? 'eligible · owner released' : item.status}</span></td>
                          </tr>
                        );
                      })}</tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
          <div className="mt-3 flex items-start gap-2 text-[11px]" style={{ color: '#64748b' }}>
            <ShieldCheck size={13} className="shrink-0" /> Buyer identities and payout controls are returned only after the cloud verifies the signed-in StatfloBot owner. Every payout still requires typed confirmation.
          </div>
        </>
      )}
    </section>
  );
}
