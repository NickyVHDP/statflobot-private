import { useState } from 'react';
import { Zap, X } from 'lucide-react';
import { openLifetimeCheckout, validateReferralCode } from '../lib/cloudApi';

/**
 * Lifetime purchase confirmation for the desktop app.
 *
 * PARITY REQUIREMENT: this must collect the same final-sale acknowledgment and
 * optional referral code as the website's PricingCard. If the desktop skipped
 * it, the desktop would become a route to buy without accepting the final-sale
 * terms — which would undermine the policy on the web too. The cloud route
 * rejects any lifetime checkout without `termsAccepted`, so both surfaces are
 * held to it server-side regardless.
 */
export default function LifetimePurchaseDialog({ priceLabel, onClose }) {
  const [accepted,   setAccepted]   = useState(false);
  const [referral,   setReferral]   = useState('');
  const [refMsg,     setRefMsg]     = useState(null);
  const [checking,   setChecking]   = useState(false);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState(null);

  async function handleCheckReferral() {
    if (!referral.trim()) return;
    setChecking(true); setRefMsg(null);
    try {
      const data = await validateReferralCode(referral.trim());
      setRefMsg({ ok: !!data.valid, text: data.message ?? '' });
    } catch {
      setRefMsg({ ok: false, text: 'Could not check that code right now.' });
    } finally {
      setChecking(false);
    }
  }

  async function handleContinue() {
    setError(null);
    if (!accepted) {
      setError('Please confirm you understand this purchase is final.');
      return;
    }
    setLoading(true);
    try {
      await openLifetimeCheckout({
        termsAccepted: true,
        ...(referral.trim() ? { referralCode: referral.trim() } : {}),
      });
      onClose?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-[60] px-4"
      style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)' }}
    >
      <div
        className="w-full max-w-md rounded-2xl p-7 border relative"
        style={{ background: '#13131f', borderColor: 'rgba(255,255,255,0.09)' }}
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-slate-500 hover:text-white transition-colors"
          aria-label="Close"
        >
          <X size={16} />
        </button>

        <div className="flex flex-col items-center text-center mb-5">
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center mb-3"
            style={{ background: 'rgba(124,58,237,0.15)', color: '#a78bfa' }}
          >
            <Zap size={20} />
          </div>
          <h2 className="text-lg font-bold text-white mb-1">
            Get Lifetime{priceLabel ? ` — ${priceLabel}` : ''}
          </h2>
          <p className="text-sm" style={{ color: '#94a3b8' }}>
            One-time payment. All future updates included.
          </p>
        </div>

        {/* Referral code */}
        <label className="block text-xs mb-1.5" style={{ color: '#64748b' }}>
          Referral code <span style={{ color: '#475569' }}>(optional)</span>
        </label>
        <div className="flex gap-2 mb-4">
          <input
            value={referral}
            onChange={(e) => { setReferral(e.target.value.toUpperCase()); setRefMsg(null); }}
            onBlur={handleCheckReferral}
            placeholder="ABCD234XYZ"
            autoComplete="off"
            spellCheck={false}
            className="flex-1 px-3 py-2 rounded-lg text-sm font-mono tracking-wider outline-none"
            style={{
              background:  'rgba(0,0,0,0.3)',
              border:      '1px solid rgba(255,255,255,0.09)',
              color:       '#e2e8f0',
            }}
          />
          <button
            type="button"
            onClick={handleCheckReferral}
            disabled={checking || !referral.trim()}
            className="px-3 rounded-lg text-xs transition-colors disabled:opacity-40"
            style={{ border: '1px solid rgba(255,255,255,0.09)', color: '#94a3b8' }}
          >
            {checking ? '…' : 'Apply'}
          </button>
        </div>
        {refMsg && (
          <p className="text-xs -mt-2 mb-3" style={{ color: refMsg.ok ? '#86efac' : '#f87171' }}>
            {refMsg.text}
          </p>
        )}

        {/* Final-sale acknowledgment */}
        <label className="flex items-start gap-2 cursor-pointer mb-4">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => { setAccepted(e.target.checked); setError(null); }}
            className="mt-0.5 flex-shrink-0"
            style={{ accentColor: '#7c3aed' }}
          />
          <span className="text-xs leading-relaxed" style={{ color: '#94a3b8' }}>
            I understand this is a <strong style={{ color: '#e2e8f0' }}>final sale</strong> — lifetime
            purchases are non-refundable except where required by law.
          </span>
        </label>

        {error && <p className="text-xs text-center mb-3" style={{ color: '#f87171' }}>{error}</p>}

        <button
          onClick={handleContinue}
          disabled={loading || !accepted}
          className="w-full py-3 rounded-xl font-semibold text-sm transition-all disabled:opacity-40"
          style={{ background: '#7c3aed', color: '#fff' }}
        >
          {loading ? 'Opening checkout…' : 'Continue to payment'}
        </button>

        <p className="text-center text-xs mt-2" style={{ color: '#64748b' }}>
          Final sale · non-refundable except where required by law
        </p>
      </div>
    </div>
  );
}
