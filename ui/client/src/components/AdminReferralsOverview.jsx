import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Gift, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { fetchAdminReferrals } from '../lib/cloudApi.js';

const money = cents => `${cents < 0 ? '-' : ''}$${(Math.abs(cents || 0) / 100).toFixed(2)}`;

function Stat({ label, value, color = '#e2e8f0' }) {
  return (
    <div className="rounded-lg p-3" style={{ background: '#0e0e14', border: '1px solid #222233' }}>
      <div className="text-[11px]" style={{ color: '#64748b' }}>{label}</div>
      <div className="text-xl font-semibold mt-0.5" style={{ color }}>{value}</div>
    </div>
  );
}

export default function AdminReferralsOverview() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchAdminReferrals());
    } catch (err) {
      setError(err.status === 403
        ? 'This referral overview is restricted to the verified owner account.'
        : 'Referral activity is temporarily unavailable.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const totals = useMemo(() => (data?.queue ?? []).reduce((sum, row) => ({
    applied: sum.applied + (row.awaitingPayment || 0),
    clearing: sum.clearing + (row.pendingCents || 0),
    eligible: sum.eligible + (row.eligibleCents || 0),
    transit: sum.transit + (row.processingCents || 0),
    paid: sum.paid + (row.paidCents || 0),
    reversed: sum.reversed + (row.reversedCents || 0),
  }), { applied: 0, clearing: 0, eligible: 0, transit: 0, paid: 0, reversed: 0 }), [data]);

  const queue = data?.queue ?? [];

  return (
    <section className="rounded-xl p-5" style={{ background: '#13131a', border: '1px solid #1e1e2e' }}>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <div className="flex items-center gap-2">
            <Gift size={16} style={{ color: '#a78bfa' }} />
            <h3 className="text-sm font-semibold text-white">Referral Program</h3>
            <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ color: '#a78bfa', background: 'rgba(167,139,250,0.12)' }}>Owner overview</span>
          </div>
          <p className="text-xs mt-1 max-w-xl" style={{ color: '#64748b' }}>
            Review pending activity and balances across lifetime members. Your owner account does not receive a referral code.
          </p>
        </div>
        <button onClick={load} disabled={loading} className="p-2 rounded-lg disabled:opacity-50" style={{ color: '#94a3b8', background: '#1e1e2e' }} title="Refresh referrals">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && <div className="rounded-lg px-3 py-2 text-xs mb-3" style={{ color: '#fca5a5', background: 'rgba(239,68,68,0.08)' }}>{error}</div>}
      {loading && !data ? (
        <div className="h-28 flex items-center justify-center gap-2 text-sm" style={{ color: '#64748b' }}><Loader2 size={15} className="animate-spin" /> Loading referral activity…</div>
      ) : data && (
        <>
          {!data.config?.payoutsEnabled && (
            <div className="rounded-lg px-3 py-2.5 text-xs mb-4 flex gap-2" style={{ color: '#fcd34d', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.18)' }}>
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <span>Reward tracking is active. Money movement remains disabled and every future payout requires your explicit approval on the secure website admin dashboard.</span>
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-4">
            <Stat label="Codes applied — not paid" value={totals.applied} color={totals.applied ? '#fbbf24' : '#64748b'} />
            <Stat label="Clearing (30-day hold)" value={money(totals.clearing)} color="#c4b5fd" />
            <Stat label="Eligible for review" value={money(totals.eligible)} color={totals.eligible < 0 ? '#f87171' : '#86efac'} />
            <Stat label="In transit" value={money(totals.transit)} color="#60a5fa" />
            <Stat label="Paid" value={money(totals.paid)} color="#86efac" />
            <Stat label="Reversed" value={money(totals.reversed)} color={totals.reversed ? '#fcd34d' : '#64748b'} />
          </div>

          <div className="rounded-lg border overflow-hidden" style={{ borderColor: '#222233', background: '#0e0e14' }}>
            {queue.length === 0 ? (
              <div className="p-5 text-xs text-center" style={{ color: '#64748b' }}>No lifetime member has created a referral code yet.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-[700px]">
                  <thead><tr style={{ color: '#64748b', borderBottom: '1px solid #222233' }}>
                    <th className="text-left px-3 py-2.5">Code</th><th className="text-right px-3 py-2.5">Applied</th><th className="text-right px-3 py-2.5">Clearing</th><th className="text-right px-3 py-2.5">Eligible</th><th className="text-right px-3 py-2.5">In transit</th><th className="text-right px-3 py-2.5">Paid</th><th className="text-right px-3 py-2.5">Reversed</th>
                  </tr></thead>
                  <tbody>{queue.map(row => (
                    <tr key={row.referrerUserId} style={{ borderBottom: '1px solid #1a1a27' }}>
                      <td className="px-3 py-3 font-mono" style={{ color: row.codeStatus === 'active' ? '#c4b5fd' : '#f87171' }}>{row.code}{row.codeStatus !== 'active' ? ' · disabled' : ''}</td>
                      <td className="text-right px-3 py-3" style={{ color: row.awaitingPayment ? '#fbbf24' : '#475569' }}>{row.awaitingPayment || '—'}</td>
                      <td className="text-right px-3 py-3" style={{ color: '#94a3b8' }}>{money(row.pendingCents)}</td>
                      <td className="text-right px-3 py-3" style={{ color: row.isNegative ? '#f87171' : '#86efac' }}>{money(row.eligibleCents)}</td>
                      <td className="text-right px-3 py-3" style={{ color: '#60a5fa' }}>{money(row.processingCents)}</td>
                      <td className="text-right px-3 py-3" style={{ color: '#94a3b8' }}>{money(row.paidCents)}</td>
                      <td className="text-right px-3 py-3" style={{ color: row.reversedCents ? '#fcd34d' : '#475569' }}>{money(row.reversedCents)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </div>
          <div className="mt-3 flex items-start gap-2 text-[11px]" style={{ color: '#64748b' }}>
            <ShieldCheck size={13} className="shrink-0" /> This app view is read-only. It never exposes referred-customer identities and cannot approve or send payouts.
          </div>
        </>
      )}
    </section>
  );
}
