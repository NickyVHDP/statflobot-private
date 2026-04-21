import { useState } from 'react';
import { RefreshCw, Wifi, WifiOff, ShieldCheck, Info, HelpCircle } from 'lucide-react';
import { shouldShowWelcome } from './WelcomeModal.jsx';
import DebugPanel from './DebugPanel.jsx';

function Row({ label, value, mono = false, dim = false }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5" style={{ borderBottom: '1px solid #1a1a27' }}>
      <span className="text-sm" style={{ color: '#64748b', flexShrink: 0 }}>{label}</span>
      <span
        className={`text-sm text-right ${mono ? 'font-mono' : ''}`}
        style={{ color: dim ? '#475569' : '#e2e8f0', wordBreak: 'break-all' }}
      >
        {value ?? '—'}
      </span>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="rounded-xl p-5" style={{ background: '#13131a', border: '1px solid #1e1e2e' }}>
      <h3 className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: '#475569' }}>
        {title}
      </h3>
      {children}
    </div>
  );
}

function ConnDot({ ok }) {
  return (
    <span
      className="inline-block w-2 h-2 rounded-full mr-2"
      style={{ background: ok ? '#22c55e' : '#ef4444', boxShadow: `0 0 6px ${ok ? '#22c55e' : '#ef4444'}` }}
    />
  );
}

export default function AdminPanel({ account, backendDown, onRefresh, onShowWelcome }) {
  const [refreshing, setRefreshing] = useState(false);

  async function handleRefresh() {
    setRefreshing(true);
    try { await onRefresh(); } finally { setRefreshing(false); }
  }

  const profile = account?.profile;
  const license = account?.license;
  const sub = account?.subscription;
  const devices = account?.devices ?? [];

  return (
    <div className="flex-1 container mx-auto px-4 py-6 max-w-3xl space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck size={18} style={{ color: '#a78bfa' }} />
          <span className="font-semibold" style={{ color: '#e2e8f0' }}>Admin Panel</span>
          <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(167,139,250,0.12)', color: '#a78bfa' }}>
            Internal
          </span>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => onShowWelcome()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium"
            style={{ background: '#1e1e2e', color: '#94a3b8', border: '1px solid #2a2a3e' }}
          >
            <HelpCircle size={13} />
            Welcome guide
          </button>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium disabled:opacity-50"
            style={{ background: '#1e1e2e', color: '#94a3b8', border: '1px solid #2a2a3e' }}
          >
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
            Refresh account
          </button>
        </div>
      </div>

      {/* Connectivity */}
      <Section title="Connectivity">
        <Row
          label="Cloud API"
          value={
            <span>
              <ConnDot ok={!backendDown} />
              {backendDown ? 'Unreachable' : 'Connected'}
            </span>
          }
        />
        <Row label="Socket" value={<span><ConnDot ok={true} />Connected</span>} />
      </Section>

      {/* Current user */}
      <Section title="Authenticated user">
        <Row label="Email"    value={profile?.email ?? account?.profile?.email ?? '—'} mono />
        <Row label="User ID"  value={profile?.id} mono dim />
        <Row label="Admin"    value={profile?.is_admin ? 'Yes' : 'No'} />
        <Row label="Created"  value={profile?.created_at ? new Date(profile.created_at).toLocaleDateString() : '—'} />
      </Section>

      {/* License */}
      <Section title="License">
        <Row label="Status"      value={license?.status ?? '—'} />
        <Row label="Plan"        value={license?.plan ?? '—'} />
        <Row label="Max devices" value={license?.max_devices ?? '—'} />
        <Row label="License key" value={license?.license_key ?? '—'} mono dim />
        <Row label="Devices registered" value={devices.length} />
      </Section>

      {/* Subscription */}
      <Section title="Subscription">
        <Row label="Status"   value={sub?.status ?? '—'} />
        <Row label="Plan"     value={sub?.plan ?? '—'} />
        <Row label="Customer" value={sub?.stripe_customer_id ?? '—'} mono dim />
      </Section>

      {/* Devices */}
      {devices.length > 0 && (
        <Section title={`Registered devices (${devices.length})`}>
          {devices.map((d, i) => (
            <div key={d.id ?? i} className="py-2.5" style={{ borderBottom: i < devices.length - 1 ? '1px solid #1a1a27' : 'none' }}>
              <div className="flex items-center justify-between">
                <span className="text-sm" style={{ color: '#e2e8f0' }}>{d.device_name || 'Unnamed device'}</span>
                <span className="text-xs font-mono" style={{ color: '#475569' }}>
                  {d.last_seen_at ? new Date(d.last_seen_at).toLocaleDateString() : '—'}
                </span>
              </div>
              <div className="text-xs font-mono mt-0.5" style={{ color: '#475569' }}>
                {d.device_fingerprint?.slice(0, 16)}…
              </div>
            </div>
          ))}
        </Section>
      )}

      {/* Debug panel */}
      <DebugPanel />

      {/* Raw JSON */}
      <Section title="Raw account payload">
        <pre
          className="text-xs overflow-auto max-h-64 rounded-lg p-3"
          style={{ background: '#0a0a0f', color: '#64748b', fontFamily: 'monospace' }}
        >
          {JSON.stringify(account, null, 2)}
        </pre>
      </Section>
    </div>
  );
}
