import { useState } from 'react';
import { User, CreditCard, Laptop, CheckCircle, AlertTriangle, Clock, XCircle, Zap, Copy, Check, RefreshCw } from 'lucide-react';
import { openBillingPortal, openLifetimeCheckout, removeDevice } from '../lib/cloudApi';

// ── Status helpers ────────────────────────────────────────────────────────────

const STATUS_CONFIG = {
  active:   { label: 'Active',   color: '#86efac', bg: 'rgba(134,239,172,0.1)', Icon: CheckCircle },
  trialing: { label: 'Trial',    color: '#fbbf24', bg: 'rgba(251,191,36,0.1)',  Icon: Clock },
  past_due: { label: 'Past due', color: '#f87171', bg: 'rgba(248,113,113,0.1)', Icon: AlertTriangle },
  canceled: { label: 'Canceled', color: '#94a3b8', bg: 'rgba(148,163,184,0.1)', Icon: XCircle },
  inactive: { label: 'Inactive', color: '#94a3b8', bg: 'rgba(148,163,184,0.1)', Icon: XCircle },
  lifetime: { label: 'Lifetime', color: '#a78bfa', bg: 'rgba(167,139,250,0.1)', Icon: Zap },
};

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.inactive;
  const { Icon } = cfg;
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium"
      style={{ background: cfg.bg, color: cfg.color }}>
      <Icon size={12} />
      {cfg.label}
    </span>
  );
}

function planLabel(code) {
  if (!code) return 'None';
  const map = {
    monthly:  'Monthly ($10/mo)',
    lifetime: 'Lifetime',
  };
  return map[code] ?? code;
}

// ── Card wrapper ──────────────────────────────────────────────────────────────

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

// ── Main component ────────────────────────────────────────────────────────────

export default function AccountScreen({ user, account, backendDown, onSignOut, onRefresh }) {
  const [copiedKey,     setCopiedKey]     = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
  const [upgradeLoading,setUpgradeLoading]= useState(false);
  const [removingId,    setRemovingId]    = useState(null);
  const [err,           setErr]           = useState(null);

  const profile      = account?.profile;
  const license      = account?.license;
  const subscription = account?.subscription;
  const devices      = account?.devices ?? [];
  const swapStatus   = account?.swapStatus;

  const isMonthly    = license?.plan === 'monthly';
  const isLifetime   = license?.plan === 'lifetime';
  const subStatus    = subscription?.status;
  const periodEnd    = subscription?.current_period_end
    ? new Date(subscription.current_period_end).toLocaleDateString()
    : null;

  async function handleCopyKey() {
    if (!license?.license_key) return;
    await navigator.clipboard.writeText(license.license_key);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  }

  async function handlePortal() {
    setPortalLoading(true); setErr(null);
    try { await openBillingPortal(); }
    catch (e) { setErr(e.message); }
    finally { setPortalLoading(false); }
  }

  async function handleUpgrade() {
    setUpgradeLoading(true); setErr(null);
    try { await openLifetimeCheckout(); }
    catch (e) { setErr(e.message); }
    finally { setUpgradeLoading(false); }
  }

  async function handleRemoveDevice(id) {
    setRemovingId(id); setErr(null);
    try {
      const result = await removeDevice(id);
      if (result?.error) {
        setErr(result.error);
        setRemovingId(null);
        return;
      }
    } catch (e) {
      setErr(e.message);
      setRemovingId(null);
      return;
    }
    onRefresh?.();
    setRemovingId(null);
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6 max-w-4xl mx-auto w-full">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-white">Account</h1>
        <p className="text-sm mt-0.5" style={{ color: '#64748b' }}>
          {profile?.email ?? user?.email}
        </p>
      </div>

      {backendDown && (
        <div className="mb-4 rounded-xl px-4 py-3 text-sm border flex items-center gap-2"
          style={{ background: 'rgba(251,191,36,0.07)', borderColor: 'rgba(251,191,36,0.2)', color: '#fbbf24' }}>
          <AlertTriangle size={14} className="flex-shrink-0" />
          Backend unavailable — billing and license data cannot be loaded. Dry-mode runs still work.
        </div>
      )}

      {err && (
        <div className="mb-4 rounded-xl px-4 py-3 text-sm text-red-400 border"
          style={{ background: 'rgba(248,113,113,0.08)', borderColor: 'rgba(248,113,113,0.2)' }}>
          {err}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">

        {/* Profile */}
        <Card title="Profile" icon={<User size={16} />}>
          <div className="space-y-3">
            <InfoRow label="Name" value={profile?.full_name || '—'} />
            <InfoRow label="Email" value={profile?.email ?? user?.email} />
            <InfoRow label="Member since" value={profile?.created_at
              ? new Date(profile.created_at).toLocaleDateString() : '—'} />
            <button
              onClick={onSignOut}
              className="text-xs mt-2 transition-colors"
              style={{ color: '#f87171' }}
            >
              Sign out
            </button>
          </div>
        </Card>

        {/* License */}
        <Card title="License" icon={<Zap size={16} />}>
          {license ? (
            <div className="space-y-3">
              <div
                className="flex items-center gap-2 rounded-xl px-4 py-3 border font-mono"
                style={{ background: '#1a1a2e', borderColor: 'rgba(255,255,255,0.08)' }}
              >
                <span className="flex-1 text-slate-300 text-xs tracking-wider truncate">
                  {license.license_key}
                </span>
                <button onClick={handleCopyKey} className="text-slate-400 hover:text-white transition-colors flex-shrink-0">
                  {copiedKey ? <Check size={13} style={{ color: '#86efac' }} /> : <Copy size={13} />}
                </button>
              </div>
              <div className="flex items-center justify-between">
                <StatusBadge status={license.status} />
                <span className="text-xs" style={{ color: '#64748b' }}>{planLabel(license.plan)}</span>
              </div>
            </div>
          ) : (
            <p className="text-sm" style={{ color: '#94a3b8' }}>No license — purchase a plan to get started.</p>
          )}
        </Card>

        {/* Billing */}
        <Card title="Billing" icon={<CreditCard size={16} />}>
          {subscription ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <StatusBadge status={subStatus} />
                {isLifetime && (
                  <span className="text-xs font-medium" style={{ color: '#a78bfa' }}>No renewal</span>
                )}
              </div>

              {isMonthly && periodEnd && (
                <InfoRow
                  label={subscription.cancel_at_period_end ? 'Cancels on' : 'Renews on'}
                  value={periodEnd}
                />
              )}

              {/* Manage billing */}
              {!isLifetime && (
                <BillingBtn onClick={handlePortal} loading={portalLoading}>
                  Manage billing
                </BillingBtn>
              )}

              {/* Upgrade to lifetime */}
              {isMonthly && (
                <BillingBtn onClick={handleUpgrade} loading={upgradeLoading} primary>
                  <Zap size={13} /> Upgrade to Lifetime
                </BillingBtn>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm" style={{ color: '#94a3b8' }}>No subscription found.</p>
              <BillingBtn onClick={handleUpgrade} loading={upgradeLoading} primary>
                <Zap size={13} /> Get Lifetime — $50
              </BillingBtn>
            </div>
          )}
        </Card>

        {/* Devices */}
        <Card title="Registered Devices" icon={<Laptop size={16} />}>
          <div className="space-y-2">

            {/* Swap quota warning */}
            {swapStatus && !swapStatus.canSwapNow && (
              <div className="rounded-lg px-3 py-2 text-xs border"
                style={{ background: 'rgba(251,191,36,0.07)', borderColor: 'rgba(251,191,36,0.2)', color: '#fbbf24' }}>
                Swap used this period.{swapStatus.nextSwapAt
                  ? ` Available again ${new Date(swapStatus.nextSwapAt).toLocaleDateString()}.`
                  : ''}
              </div>
            )}

            {/* Pending cooldowns */}
            {(swapStatus?.pendingCooldowns ?? []).map((c, i) => (
              <div key={i} className="rounded-lg px-3 py-2 text-xs border"
                style={{ background: 'rgba(99,102,241,0.06)', borderColor: 'rgba(99,102,241,0.2)', color: '#818cf8' }}>
                Removed slot for "{c.deviceName ?? 'device'}" frees in {c.hoursRemaining}h.
              </div>
            ))}

            {devices.length === 0 && (
              <p className="text-sm" style={{ color: '#64748b' }}>
                No devices registered yet. Run the bot once to register automatically.
              </p>
            )}
            {devices.map(dev => (
              <div key={dev.id}
                className="flex items-center justify-between rounded-xl px-3 py-2.5 border"
                style={{ background: '#1a1a2e', borderColor: 'rgba(255,255,255,0.07)' }}
              >
                <div>
                  <p className="text-sm text-white">{dev.device_name ?? 'Unknown Device'}</p>
                  <p className="text-xs" style={{ color: '#475569' }}>
                    Last seen {new Date(dev.last_seen_at).toLocaleDateString()}
                    {dev.days_old !== undefined && ` · Added ${dev.days_old}d ago`}
                  </p>
                </div>
                <button
                  onClick={() => handleRemoveDevice(dev.id)}
                  disabled={removingId === dev.id || !dev.can_remove || !swapStatus?.canSwapNow}
                  title={
                    !dev.can_remove
                      ? `Must be ≥ 7 days old to remove (${dev.days_old}d)`
                      : !swapStatus?.canSwapNow
                      ? 'Swap quota used this period'
                      : 'Remove device'
                  }
                  className="text-xs transition-colors disabled:opacity-30"
                  style={{ color: '#f87171', cursor: (!dev.can_remove || !swapStatus?.canSwapNow) ? 'not-allowed' : 'pointer' }}
                >
                  {removingId === dev.id ? 'Removing…' : 'Remove'}
                </button>
              </div>
            ))}
            <p className="text-xs pt-1" style={{ color: '#475569' }}>
              {devices.length} / {license?.max_devices ?? 2} used
              {swapStatus && ` · ${swapStatus.swapsUsedLast30Days}/1 swap this month`}
            </p>
          </div>

          {onRefresh && (
            <button
              onClick={onRefresh}
              className="flex items-center gap-1.5 text-xs mt-3 transition-colors"
              style={{ color: '#64748b' }}
            >
              <RefreshCw size={11} /> Refresh
            </button>
          )}
        </Card>

      </div>
    </div>
  );
}

function InfoRow({ label, value }) {
  return (
    <div className="flex justify-between text-sm">
      <span style={{ color: '#64748b' }}>{label}</span>
      <span className="text-white text-right">{value}</span>
    </div>
  );
}

function BillingBtn({ children, onClick, loading, primary }) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="flex items-center justify-center gap-1.5 w-full py-2.5 rounded-xl text-sm font-medium transition-all disabled:opacity-50 border"
      style={primary
        ? { background: 'linear-gradient(135deg, #6366f1, #818cf8)', color: '#fff', border: 'none' }
        : { background: 'transparent', color: '#e2e8f0', borderColor: 'rgba(255,255,255,0.1)' }}
    >
      {loading ? 'Opening…' : children}
    </button>
  );
}
