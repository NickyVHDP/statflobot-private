import { useCallback, useMemo, useState } from 'react';
import {
  AlertTriangle, ChevronDown, ChevronRight, CheckCircle2, Loader2,
  RefreshCw, ShieldCheck, Wrench,
} from 'lucide-react';
import DebugPanel from './DebugPanel.jsx';
import ReliabilityReview from './ReliabilityReview.jsx';
import AdminSupportReports from './AdminSupportReports.jsx';
import AdminReferralsOverview from './AdminReferralsOverview.jsx';
import { buildAttentionItems } from '../lib/ownerAttention.js';

const TONE = {
  critical: { color: '#f87171', background: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.20)' },
  warn:     { color: '#fbbf24', background: 'rgba(251,191,36,0.07)', border: 'rgba(251,191,36,0.18)' },
  info:     { color: '#a5b4fc', background: 'rgba(99,102,241,0.07)', border: 'rgba(99,102,241,0.18)' },
};

function AttentionSummary({ items, pending, unavailable }) {
  return (
    <section className="rounded-xl p-5" style={{ background: '#13131a', border: '1px solid #1e1e2e' }}>
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle size={15} style={{ color: items.length ? '#fbbf24' : '#475569' }} />
        <h3 className="text-sm font-semibold text-white">Needs your attention</h3>
        {pending > 0 && (
          <span className="flex items-center gap-1 text-[11px]" style={{ color: '#64748b' }}>
            <Loader2 size={11} className="animate-spin" /> checking {pending} more
          </span>
        )}
      </div>

      {items.length === 0 ? (
        <div className="flex items-center gap-2 text-sm" style={{ color: '#64748b' }}>
          {pending > 0
            ? <><Loader2 size={14} className="animate-spin" /> Gathering signals from the sections below…</>
            : unavailable > 0
              ? <><AlertTriangle size={15} style={{ color: '#fbbf24' }} /> Could not check {unavailable} owner section{unavailable === 1 ? '' : 's'}. Use the section refresh button{unavailable === 1 ? '' : 's'} below.</>
            : <><CheckCircle2 size={15} style={{ color: '#4ade80' }} /> Nothing needs your attention right now.</>}
        </div>
      ) : (
        <div className="space-y-2">
          {items.map(item => {
            const tone = TONE[item.tone] ?? TONE.info;
            return (
              <div
                key={item.id}
                className="rounded-lg px-3 py-2.5"
                style={{ background: tone.background, border: `1px solid ${tone.border}` }}
              >
                <div className="text-sm font-medium" style={{ color: tone.color }}>{item.label}</div>
                <div className="text-[11px] mt-0.5" style={{ color: '#94a3b8' }}>{item.detail}</div>
              </div>
            );
          })}
          {unavailable > 0 && (
            <div className="text-[11px] px-1 pt-1" style={{ color: '#fbbf24' }}>
              {unavailable} owner section{unavailable === 1 ? '' : 's'} could not be checked; no all-clear is being claimed.
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function DeviceRow({ label, value }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2" style={{ borderBottom: '1px solid #1a1a27' }}>
      <span className="text-xs shrink-0" style={{ color: '#64748b' }}>{label}</span>
      <span className="text-xs text-right break-all" style={{ color: '#e2e8f0' }}>{value ?? '—'}</span>
    </div>
  );
}

export default function AdminPanel({ account, backendDown, deviceRegResult, onRefresh }) {
  const [refreshing, setRefreshing] = useState(false);
  const [showTechnical, setShowTechnical] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [support, setSupport] = useState(undefined);
  const [reliability, setReliability] = useState(undefined);
  const [referrals, setReferrals] = useState(undefined);

  // Stable identities so a panel's `onLoaded` prop never changes between
  // renders and re-triggers the fetch that feeds it.
  const onSupportLoaded = useCallback(next => setSupport(next), []);
  const onReliabilityLoaded = useCallback(next => setReliability(next), []);
  const onReferralsLoaded = useCallback(next => setReferrals(next), []);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await onRefresh();
      setRefreshToken(current => current + 1);
    } finally {
      setRefreshing(false);
    }
  }

  const items = useMemo(
    () => buildAttentionItems({ support, reliability, referrals }),
    [support, reliability, referrals],
  );
  // `undefined` is "has not reported yet"; `null` is "reported, but unavailable".
  const pending = [support, reliability, referrals].filter(s => s === undefined).length;
  const unavailable = [support, reliability, referrals].filter(s => s === null).length;

  const devices = account?.devices ?? [];

  return (
    <div className="flex-1 container mx-auto px-4 py-6 max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck size={18} style={{ color: '#a78bfa' }} />
          <span className="font-semibold" style={{ color: '#e2e8f0' }}>Owner Command Center</span>
          <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(167,139,250,0.12)', color: '#a78bfa' }}>
            Internal
          </span>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium disabled:opacity-50"
          style={{ background: '#1e1e2e', color: '#94a3b8', border: '1px solid #2a2a3e' }}
        >
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Concise attention summary, derived from the sections below. */}
      <AttentionSummary items={items} pending={pending} unavailable={unavailable} />

      {/* Customer-facing work first: someone is waiting on a reply. */}
      <AdminSupportReports onLoaded={onSupportLoaded} refreshToken={refreshToken} />

      {/* Then fleet health: what is breaking and in which build. */}
      <ReliabilityReview onLoaded={onReliabilityLoaded} refreshToken={refreshToken} />

      {/* Then money owed. Payout approval stays web-admin-only by design. */}
      <AdminReferralsOverview onLoaded={onReferralsLoaded} refreshToken={refreshToken} />

      {/* Technical tools — collapsed, because they are for debugging, not for
          the daily read of the business. */}
      <section className="rounded-xl" style={{ background: '#13131a', border: '1px solid #1e1e2e' }}>
        <button
          onClick={() => setShowTechnical(open => !open)}
          className="w-full flex items-center gap-2 px-5 py-4 text-left"
          aria-expanded={showTechnical}
        >
          {showTechnical ? <ChevronDown size={14} style={{ color: '#64748b' }} /> : <ChevronRight size={14} style={{ color: '#64748b' }} />}
          <Wrench size={14} style={{ color: '#64748b' }} />
          <span className="text-sm font-semibold" style={{ color: '#94a3b8' }}>Technical Tools</span>
          <span className="text-[11px]" style={{ color: '#475569' }}>Cloud status, this device, debug</span>
        </button>

        {showTechnical && (
          <div className="px-5 pb-5 space-y-4">
            <div className="rounded-lg p-4" style={{ background: '#0e0e14', border: '1px solid #222233' }}>
              <div className="flex items-center justify-between">
                <span className="text-xs" style={{ color: '#64748b' }}>Cloud API</span>
                <span className="text-xs flex items-center gap-2" style={{ color: backendDown ? '#f87171' : '#4ade80' }}>
                  <span
                    className="inline-block w-2 h-2 rounded-full"
                    style={{ background: backendDown ? '#ef4444' : '#22c55e' }}
                  />
                  {backendDown ? 'Unreachable' : 'Connected'}
                </span>
              </div>
            </div>

            <div className="rounded-lg p-4" style={{ background: '#0e0e14', border: '1px solid #222233' }}>
              <div className="text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color: '#475569' }}>
                This device
              </div>
              <DeviceRow label="Devices on account" value={devices.length} />
              <DeviceRow
                label="Registration"
                value={deviceRegResult?.action ?? (deviceRegResult?.error ? 'Failed' : '—')}
              />
              <DeviceRow
                label="Cloud sync"
                value={deviceRegResult?.adminNote
                  ?? deviceRegResult?.error
                  ?? (deviceRegResult?.action ? 'OK' : 'Not checked')}
              />
            </div>

            <DebugPanel />
          </div>
        )}
      </section>
    </div>
  );
}
