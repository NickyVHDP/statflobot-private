'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Ban, Check, RefreshCw } from 'lucide-react';

/**
 * Admin referral audit + payout queue.
 *
 * Every action here is explicit and admin-initiated. There is no bulk approve
 * and no "pay everyone" control on purpose: each transfer is a separate,
 * deliberate decision against a visible balance.
 */

interface QueueRow {
  referrerUserId: string;
  code:           string;
  codeStatus:     string;
  /** Live "code applied, not paid yet" checkouts. Non-monetary; abuse signal. */
  awaitingPayment: number;
  pendingCents:   number;
  eligibleCents:  number;
  processingCents: number;
  paidCents:      number;
  reversedCents:  number;
  isNegative:     boolean;
  connectStatus:  string;
  payoutsEnabled: boolean;
  meetsThreshold: boolean;
}

interface AdminData {
  config: {
    accrualCents: number;
    lifetimePriceCents: number;
    pricePhase: string;
    rewardMinCents: number;
    rewardMaxCents: number;
    thresholdCents: number | null;
    payoutsEnabled: boolean;
  };
  queue:  QueueRow[];
  ledger: any[];
  attributions: any[];
  payouts: Array<{
    id: string;
    referrer_user_id: string;
    amount_cents: number;
    status: string;
    approved_by_email: string;
    created_at: string;
    completed_at?: string | null;
    failure_reason?: string | null;
  }>;
}

const money = (cents: number) =>
  `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;

/** Plain-English readiness for the raw onboarding_status values on referral_payout_accounts. */
const BANK_STATUS_LABELS: Record<string, string> = {
  none:     'not connected',
  created:  'bank setup incomplete',
  pending:  'bank setup incomplete',
  complete: 'ready',
};
const bankStatusLabel = (status: string) => BANK_STATUS_LABELS[status] ?? 'bank setup incomplete';

/** One human-readable owner action, ordered by the first blocking condition. */
function nextPayoutAction(row: QueueRow, config: AdminData['config']): string {
  if (row.isNegative) return 'Review reversed balance';
  if (!row.payoutsEnabled) {
    return row.connectStatus === 'none' ? 'Waiting for bank connection' : 'Waiting for bank setup';
  }
  if (config.thresholdCents === null) return 'Set payout threshold';
  if (!config.payoutsEnabled) return 'Payout sending disabled';
  if (!row.meetsThreshold) return `Waiting for ${money(config.thresholdCents)}`;
  return 'Ready for owner review';
}

export default function AdminReferrals() {
  const [data,    setData]    = useState<AdminData | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [busy,    setBusy]    = useState<string | null>(null);
  const [notice,  setNotice]  = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const res = await fetch('/api/admin/referrals');
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      setData(await res.json());
    } catch (err: any) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  async function act(action: string, referrerUserId: string, reason?: string, confirmation?: string) {
    setBusy(referrerUserId + action);
    setNotice(null);
    try {
      const res = await fetch('/api/admin/referrals/payout', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action, referrerUserId, reason, confirmation }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);

      setNotice(
        action === 'approve'
          ? body.providerStatus === 'paid'
            ? `Payout posted: ${money(body.amountCents)}`
            : `Payout submitted to Stripe: ${money(body.amountCents)} — awaiting confirmation`
          : action === 'preflight'
            ? body.ok
              ? `Ready — ${money(body.eligibleCents)} payable`
              : `Blocked: ${body.detail ?? body.reason}`
            : 'Done'
      );
      if (action !== 'preflight') await load();
    } catch (err: any) {
      setNotice(`Failed: ${err.message}`);
    } finally {
      setBusy(null);
    }
  }

  if (error) {
    return (
      <section>
        <h2 className="text-lg font-bold text-white mb-4">Referrals</h2>
        <p className="text-sm" style={{ color: '#f87171' }}>
          Could not load referral data: {error}
        </p>
        <p className="text-xs text-slate-600 mt-1">
          If this says a relation does not exist, the <code>add_referrals.sql</code> migration has not been applied yet.
        </p>
      </section>
    );
  }

  if (!data) {
    return (
      <section>
        <h2 className="text-lg font-bold text-white mb-4">Referrals</h2>
        <p className="text-sm text-slate-500">Loading…</p>
      </section>
    );
  }

  const { config, queue } = data;

  return (
    <section>
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-lg font-bold text-white">Referrals</h2>
        <button
          onClick={load}
          className="text-xs flex items-center gap-1 text-slate-400 hover:text-white transition-colors"
        >
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {/* Configuration banner — both of these fail closed, so surface them loudly */}
      {(!config.payoutsEnabled || config.thresholdCents === null) && (
        <div
          className="mb-4 rounded-xl px-4 py-3 text-xs leading-relaxed flex gap-2"
          style={{ background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)', color: '#fcd34d' }}
        >
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          <div>
            <strong>Payout execution is disabled.</strong>
            <ul className="mt-1 space-y-0.5 list-disc list-inside">
              {!config.payoutsEnabled && (
                <li><code>REFERRAL_PAYOUTS_ENABLED</code> is not set to <code>true</code>.</li>
              )}
              {config.thresholdCents === null && (
                <li>
                  <code>REFERRAL_PAYOUT_THRESHOLD_CENTS</code> is not configured — the payout
                  threshold is an owner decision and has no default in code.
                </li>
              )}
            </ul>
            Accrual, attribution and the audit trail all continue to work.
          </div>
        </div>
      )}

      <div className="grid grid-cols-4 gap-4 mb-5">
        {[
          { label: 'Lifetime price', value: money(config.lifetimePriceCents) },
          { label: 'Active reward range', value: `${money(config.rewardMinCents)}–${money(config.rewardMaxCents)}` },
          { label: 'Payout threshold',    value: config.thresholdCents === null ? 'not set' : money(config.thresholdCents) },
          { label: 'Referrers with codes', value: String(queue.length) },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-2xl border p-5" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
            <p className="text-xs text-slate-500 mb-1">{label}</p>
            <p className="text-2xl font-bold text-slate-200">{value}</p>
          </div>
        ))}
      </div>

      {notice && <p className="text-xs mb-3" style={{ color: '#a78bfa' }}>{notice}</p>}

      <div className="rounded-2xl border overflow-hidden" style={{ borderColor: 'var(--border)' }}>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
              <th className="px-4 py-3">Code</th>
              <th className="px-4 py-3">Applied</th>
              <th className="px-4 py-3">Clearing</th>
              <th className="px-4 py-3">Eligible</th>
              <th className="px-4 py-3">In transit</th>
              <th className="px-4 py-3">Paid</th>
              <th className="px-4 py-3">Reversed</th>
              <th className="px-4 py-3">Bank</th>
              <th className="px-4 py-3">Next step</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {queue.length === 0 && (
              <tr><td colSpan={10} className="px-4 py-6 text-center text-slate-600 text-xs">No referral codes issued yet.</td></tr>
            )}
            {queue.map((r) => (
              <tr key={r.referrerUserId} className="border-b last:border-0" style={{ borderColor: 'var(--border)' }}>
                <td className="px-4 py-3">
                  <span className="font-mono text-xs text-slate-300">{r.code}</span>
                  {r.codeStatus !== 'active' && (
                    <span className="ml-2 text-xs" style={{ color: '#f87171' }}>disabled</span>
                  )}
                </td>
                <td className="px-4 py-3 text-xs" style={{ color: r.awaitingPayment > 0 ? '#fbbf24' : '#475569' }}
                    title="Checkouts started with this code that have not been paid for. Earns nothing.">
                  {r.awaitingPayment || '—'}
                </td>
                <td className="px-4 py-3 text-slate-400 text-xs">{money(r.pendingCents)}</td>
                <td className="px-4 py-3 text-xs font-medium" style={{ color: r.isNegative ? '#f87171' : '#86efac' }}>
                  {money(r.eligibleCents)}
                  {r.isNegative && (
                    <span className="ml-1" title="Negative balance from a reversal after payout">⚠</span>
                  )}
                </td>
                <td className="px-4 py-3 text-xs" style={{ color: r.processingCents > 0 ? '#60a5fa' : '#475569' }}>
                  {money(r.processingCents)}
                </td>
                <td className="px-4 py-3 text-slate-400 text-xs">{money(r.paidCents)}</td>
                <td className="px-4 py-3 text-xs" style={{ color: r.reversedCents > 0 ? '#fcd34d' : '#475569' }}>
                  {money(r.reversedCents)}
                </td>
                <td className="px-4 py-3 text-xs">
                  {r.payoutsEnabled
                    ? <span style={{ color: '#86efac' }}><Check size={12} className="inline" /> ready</span>
                    : <span className="text-slate-500">{bankStatusLabel(r.connectStatus)}</span>}
                </td>
                <td
                  className="px-4 py-3 text-xs"
                  style={{ color: nextPayoutAction(r, config) === 'Ready for owner review' ? '#c4b5fd' : '#64748b' }}
                >
                  {nextPayoutAction(r, config)}
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-2">
                    <button
                      onClick={() => act('preflight', r.referrerUserId)}
                      disabled={busy !== null}
                      className="text-xs px-2 py-1 rounded-lg border transition-colors disabled:opacity-40"
                      style={{ borderColor: 'var(--border)', color: '#94a3b8' }}
                    >
                      Check
                    </button>
                    <button
                      onClick={() => {
                        const expected = `PAY ${r.code}`;
                        const typed = prompt(
                          `Owner approval required. To send ${money(r.eligibleCents)}, type exactly:\n\n${expected}`
                        );
                        if (typed?.trim().toUpperCase() === expected) {
                          act('approve', r.referrerUserId, undefined, typed);
                        }
                      }}
                      disabled={busy !== null || !r.meetsThreshold || !r.payoutsEnabled || !config.payoutsEnabled}
                      className="text-xs px-2 py-1 rounded-lg font-medium transition-colors disabled:opacity-30"
                      style={{ background: 'var(--accent)', color: '#fff' }}
                    >
                      Approve payout
                    </button>
                    {r.codeStatus === 'active' ? (
                      <button
                        onClick={() => {
                          const reason = prompt('Reason for disabling this code?');
                          if (reason) act('disable-code', r.referrerUserId, reason);
                        }}
                        disabled={busy !== null}
                        className="text-xs px-2 py-1 rounded-lg border transition-colors disabled:opacity-40"
                        style={{ borderColor: 'rgba(248,113,113,0.3)', color: '#f87171' }}
                      >
                        <Ban size={11} className="inline" /> Disable
                      </button>
                    ) : (
                      <button
                        onClick={() => act('enable-code', r.referrerUserId)}
                        disabled={busy !== null}
                        className="text-xs px-2 py-1 rounded-lg border transition-colors disabled:opacity-40"
                        style={{ borderColor: 'var(--border)', color: '#94a3b8' }}
                      >
                        Re-enable
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-600 mt-2">
        Balances are computed live from the append-only <code className="text-slate-500">referral_ledger</code>.
        Disabling a code stops future use; attributions already earned remain payable.
      </p>

      <div className="mt-6 rounded-2xl border overflow-hidden" style={{ borderColor: 'var(--border)' }}>
        <div className="px-4 py-3 border-b" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
          <h3 className="text-sm font-semibold text-slate-200">Payout history</h3>
          <p className="text-xs text-slate-500 mt-0.5">Processing payouts remain visible until Stripe confirms they posted or failed.</p>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b" style={{ borderColor: 'var(--border)' }}>
              <th className="px-4 py-3">Referral code</th>
              <th className="px-4 py-3">Amount</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Owner approval</th>
              <th className="px-4 py-3">Submitted</th>
            </tr>
          </thead>
          <tbody>
            {data.payouts.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-600 text-xs">No payout attempts yet.</td></tr>
            )}
            {data.payouts.map((payout) => {
              const code = queue.find((row) => row.referrerUserId === payout.referrer_user_id)?.code ?? 'Unknown';
              const statusColor = payout.status === 'paid' ? '#86efac'
                : payout.status === 'processing' ? '#60a5fa'
                  : payout.status === 'failed' || payout.status === 'canceled' ? '#f87171' : '#fbbf24';
              return (
                <tr key={payout.id} className="border-b last:border-0" style={{ borderColor: 'var(--border)' }}>
                  <td className="px-4 py-3 font-mono text-xs text-slate-300">{code}</td>
                  <td className="px-4 py-3 text-xs text-slate-300">{money(payout.amount_cents)}</td>
                  <td className="px-4 py-3 text-xs font-medium" style={{ color: statusColor }}>
                    {payout.status === 'processing' ? 'In transit' : payout.status}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400">{payout.approved_by_email}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{new Date(payout.created_at).toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
