import { useState } from 'react';
import { AlertTriangle, CreditCard, Zap, RefreshCw } from 'lucide-react';
import { openBillingPortal, openMonthlyCheckout, openLifetimeCheckout } from '../lib/cloudApi';

/**
 * SubscriptionGate
 *
 * Rendered as a modal when the user tries to start a run without an active subscription.
 * Shows their current status, explains why access is blocked, and provides CTAs.
 *
 * Props:
 *   subscription — the subscription object from useSubscription
 *   onDismiss    — close the gate
 *   onRefresh    — re-fetch account state after billing change
 */
export default function SubscriptionGate({ subscription, onDismiss, onRefresh }) {
  const [portalLoading,   setPortalLoading]   = useState(false);
  const [upgradeLoading,  setUpgradeLoading]  = useState(false);
  const [monthlyLoading,  setMonthlyLoading]  = useState(false);
  const [error,           setError]           = useState(null);

  const status     = subscription?.status ?? 'none';
  const isNoPlan   = status === 'none' || status === 'inactive' || !subscription;
  const isPastDue  = status === 'past_due';
  const isCanceled = status === 'canceled';

  async function handlePortal() {
    setPortalLoading(true); setError(null);
    try { await openBillingPortal(); }
    catch (e) { setError(e.message); }
    finally { setPortalLoading(false); }
  }

  async function handleUpgrade() {
    setUpgradeLoading(true); setError(null);
    try { await openLifetimeCheckout(); }
    catch (e) { setError(e.message); }
    finally { setUpgradeLoading(false); }
  }

  async function handleMonthly() {
    setMonthlyLoading(true); setError(null);
    try { await openMonthlyCheckout(); }
    catch (e) { setError(e.message); }
    finally { setMonthlyLoading(false); }
  }

  const statusConfig = {
    none:     { icon: <Zap size={22} />, title: 'Subscription required', body: 'Start a plan to unlock the bot and begin automating your outreach.' },
    inactive: { icon: <Zap size={22} />, title: 'No active subscription', body: 'Your subscription is inactive. Purchase a plan to get started.' },
    past_due: { icon: <AlertTriangle size={22} />, title: 'Payment past due', body: 'Your last payment failed. Update your payment method to restore access.' },
    canceled: { icon: <AlertTriangle size={22} />, title: 'Subscription canceled', body: 'Your subscription has ended. Resubscribe to continue using StatfloBot.' },
  };

  const cfg = statusConfig[status] ?? statusConfig.none;

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 px-4"
      style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)' }}>
      <div
        className="w-full max-w-md rounded-2xl p-8 border"
        style={{ background: '#13131f', borderColor: 'rgba(255,255,255,0.09)' }}
      >
        {/* Icon + title */}
        <div className="flex flex-col items-center text-center mb-6">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4"
            style={{ background: 'rgba(239,68,68,0.1)', color: '#f87171' }}
          >
            {cfg.icon}
          </div>
          <h2 className="text-lg font-bold text-white mb-2">{cfg.title}</h2>
          <p className="text-sm" style={{ color: '#94a3b8' }}>{cfg.body}</p>
        </div>

        {error && (
          <p className="text-red-400 text-xs text-center mb-4">{error}</p>
        )}

        {/* CTAs */}
        <div className="flex flex-col gap-3">
          {/* No plan / inactive / canceled → buy or resubscribe */}
          {(isNoPlan || isCanceled) && (
            <>
              <ActionBtn
                onClick={handleUpgrade}
                loading={upgradeLoading}
                primary
                icon={<Zap size={15} />}
              >
                Get Lifetime — $50
              </ActionBtn>
              <ActionBtn
                onClick={handleMonthly}
                loading={monthlyLoading}
                icon={<CreditCard size={15} />}
              >
                Subscribe Monthly — $10/mo
              </ActionBtn>
            </>
          )}

          {/* Past due → billing portal to fix payment */}
          {isPastDue && (
            <ActionBtn
              onClick={handlePortal}
              loading={portalLoading}
              primary
              icon={<CreditCard size={15} />}
            >
              Fix payment method
            </ActionBtn>
          )}

          {/* Refresh — after they pay in the browser */}
          <ActionBtn
            onClick={onRefresh}
            icon={<RefreshCw size={15} />}
          >
            I just paid — refresh status
          </ActionBtn>

          <button
            onClick={onDismiss}
            className="text-xs mt-1 transition-colors"
            style={{ color: '#475569' }}
          >
            Dismiss
          </button>
        </div>

        <p className="text-center text-xs mt-6" style={{ color: '#334155' }}>
          Payment opens securely in your browser via Stripe
        </p>
      </div>
    </div>
  );
}

function ActionBtn({ children, onClick, loading, primary, icon }) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="flex items-center justify-center gap-2 w-full py-3 rounded-xl font-medium text-sm transition-all disabled:opacity-50"
      style={primary
        ? { background: 'linear-gradient(135deg, #6366f1, #818cf8)', color: '#fff' }
        : { background: '#1a1a2e', color: '#e2e8f0', border: '1px solid rgba(255,255,255,0.08)' }}
    >
      {icon}
      {loading ? 'Opening…' : children}
    </button>
  );
}
