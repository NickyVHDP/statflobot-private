'use client';

import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

interface Props {
  planCode:           string;
  name:               string;
  subtitle?:          string;
  priceCents:         number;
  originalPriceCents?: number;
  billingType:        'monthly' | 'lifetime';
  features:           string[];
  featured?:          boolean;
  badge?:             string;
  note?:              string;
}

export default function PricingCard({
  planCode, name, subtitle, priceCents, originalPriceCents, billingType, features, featured, badge, note,
}: Props) {
  const [loading,     setLoading]     = useState(false);
  const [isLoggedIn,  setIsLoggedIn]  = useState<boolean | null>(null);
  const [referral,    setReferral]    = useState('');
  const [referralMsg, setReferralMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [checkingRef, setCheckingRef] = useState(false);
  const [finalSaleOk, setFinalSaleOk] = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  const isLifetime      = billingType === 'lifetime';
  const dollars         = (priceCents / 100).toFixed(0);
  const originalDollars = originalPriceCents ? (originalPriceCents / 100).toFixed(0) : null;
  const endpoint = billingType === 'monthly' ? '/api/checkout/monthly' : '/api/checkout/lifetime';

  // Detect auth state once on mount — drives button label only, never blocks checkout
  useEffect(() => {
    createClient().auth.getUser().then(({ data }) => {
      setIsLoggedIn(!!data.user);
    });
  }, []);

  // Prefill from a ?ref= share link so referred buyers never have to retype it.
  useEffect(() => {
    if (!isLifetime) return;
    const ref = new URLSearchParams(window.location.search).get('ref');
    if (ref) setReferral(ref.toUpperCase());
  }, [isLifetime]);

  function buttonLabel() {
    if (loading)             return 'Redirecting…';
    if (isLoggedIn === null) return `Get ${name}`;           // still resolving
    if (isLoggedIn)          return `Get ${name}`;           // signed in
    return 'Continue to checkout';                           // guest
  }

  async function checkReferral() {
    if (!referral.trim()) return;
    setCheckingRef(true);
    setReferralMsg(null);
    try {
      const res = await fetch('/api/referrals/validate', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ referralCode: referral }),
      });
      const data = await res.json();
      setReferralMsg({ ok: !!data.valid, text: data.message ?? '' });
    } catch {
      setReferralMsg({ ok: false, text: 'Could not check that code right now.' });
    } finally {
      setCheckingRef(false);
    }
  }

  async function handleClick() {
    setError(null);

    // Server re-validates both of these; this is only fast feedback.
    if (isLifetime && !finalSaleOk) {
      setError('Please confirm you understand this purchase is final.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(endpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          isLifetime
            ? {
                termsAccepted: finalSaleOk,
                ...(referral.trim() ? { referralCode: referral.trim() } : {}),
              }
            : {}
        ),
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        setLoading(false);
        setError(data.error ?? 'Something went wrong');
      }
    } catch {
      setLoading(false);
      setError('Could not reach checkout. Please try again.');
    }
  }

  return (
    <div
      className={`relative rounded-2xl p-6 flex flex-col border transition-all ${
        featured ? 'shadow-lg shadow-violet-900/20' : ''
      }`}
      style={{
        background:  featured ? 'linear-gradient(135deg, rgba(124,58,237,0.15), rgba(79,70,229,0.08))' : 'var(--card)',
        borderColor: featured ? 'rgba(124,58,237,0.5)' : 'var(--border)',
      }}
    >
      {badge && (
        <span
          className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full text-xs font-semibold"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          {badge}
        </span>
      )}

      <div className="mb-4">
        <p className="text-sm font-medium text-slate-400 mb-0.5">{name}</p>
        {subtitle && (
          <p className="text-xs mb-2" style={{ color: featured ? '#a78bfa' : '#64748b' }}>
            {subtitle}
          </p>
        )}
        {originalDollars && (
          <div className="mb-2">
            <span className="relative inline-block">
              <span
                className="text-sm font-medium tracking-wide"
                style={{ color: '#4a3d6e', letterSpacing: '0.02em' }}
              >
                ${originalDollars}
              </span>
              {/* diagonal slash — angled gradient line, not text-decoration */}
              <span
                aria-hidden
                className="absolute inset-0 flex items-center"
                style={{ transform: 'rotate(-10deg) translateY(1px)', pointerEvents: 'none' }}
              >
                <span
                  className="block w-full"
                  style={{
                    height: '1.5px',
                    background: 'linear-gradient(90deg, transparent 0%, rgba(139,92,246,0.55) 30%, rgba(139,92,246,0.55) 70%, transparent 100%)',
                    borderRadius: '1px',
                  }}
                />
              </span>
            </span>
          </div>
        )}
        <div className="flex items-end gap-1">
          <span className="text-4xl font-bold text-white">${dollars}</span>
          <span className="text-slate-400 text-sm mb-1">
            {billingType === 'monthly' ? '/month' : ' one-time'}
          </span>
        </div>
        {originalDollars && (
          <p className="mt-1.5 text-xs leading-relaxed" style={{ color: '#4a3d6e' }}>
            Early adopter pricing ends when spots are filled.{' '}
            Lifetime becomes ${originalDollars} after launch.
          </p>
        )}
      </div>

      <ul className="flex flex-col gap-2.5 mb-4 flex-1">
        {features.map(f => (
          <li key={f} className="flex items-start gap-2 text-sm text-slate-300">
            <Check size={15} className="mt-0.5 flex-shrink-0" style={{ color: '#86efac' }} />
            {f}
          </li>
        ))}
      </ul>

      {note && (
        <div
          className="mb-4 px-3 py-2.5 rounded-xl text-xs leading-relaxed"
          style={{
            background: 'rgba(124,58,237,0.12)',
            border: '1px solid rgba(167,139,250,0.25)',
            color: '#c4b5fd',
          }}
        >
          {note}
        </div>
      )}

      {/* ── Lifetime-only: referral code + required final-sale acknowledgment ── */}
      {isLifetime && (
        <div className="mb-4 flex flex-col gap-3">
          <div>
            <label htmlFor="referral-code" className="block text-xs mb-1.5" style={{ color: '#64748b' }}>
              Referral code <span style={{ color: '#475569' }}>(optional)</span>
            </label>
            <div className="flex gap-2">
              <input
                id="referral-code"
                value={referral}
                onChange={(e) => { setReferral(e.target.value.toUpperCase()); setReferralMsg(null); }}
                onBlur={checkReferral}
                placeholder="ABCD234XYZ"
                autoComplete="off"
                spellCheck={false}
                className="flex-1 px-3 py-2 rounded-lg text-sm font-mono tracking-wider outline-none"
                style={{
                  background:  'rgba(0,0,0,0.25)',
                  border:      '1px solid var(--border)',
                  color:       '#e2e8f0',
                }}
              />
              <button
                type="button"
                onClick={checkReferral}
                disabled={checkingRef || !referral.trim()}
                className="px-3 rounded-lg text-xs transition-colors disabled:opacity-40"
                style={{ border: '1px solid var(--border)', color: '#94a3b8' }}
              >
                {checkingRef ? '…' : 'Apply'}
              </button>
            </div>
            {referralMsg && (
              <p className="text-xs mt-1.5" style={{ color: referralMsg.ok ? '#86efac' : '#f87171' }}>
                {referralMsg.text}
              </p>
            )}
          </div>

          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={finalSaleOk}
              onChange={(e) => { setFinalSaleOk(e.target.checked); setError(null); }}
              className="mt-0.5 flex-shrink-0"
              style={{ accentColor: '#7c3aed' }}
            />
            <span className="text-xs leading-relaxed" style={{ color: '#94a3b8' }}>
              I understand this is a <strong style={{ color: '#e2e8f0' }}>final sale</strong> — lifetime
              purchases are non-refundable except where required by law. See the{' '}
              <a
                href="/terms"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-white transition-colors"
              >
                Terms
              </a>.
            </span>
          </label>
        </div>
      )}

      <button
        onClick={handleClick}
        disabled={loading || (isLifetime && !finalSaleOk)}
        className="w-full py-3 rounded-xl font-semibold text-sm transition-all disabled:opacity-50"
        style={{
          background: featured ? 'var(--accent)' : 'var(--raised)',
          color:      featured ? '#fff' : '#e2e8f0',
          border:     featured ? 'none' : '1px solid var(--border)',
        }}
      >
        {buttonLabel()}
      </button>

      {error && (
        <p className="text-center text-xs mt-2" style={{ color: '#f87171' }}>{error}</p>
      )}

      {/* Final-sale disclosure sits adjacent to the payment button, not only in Terms */}
      {isLifetime && (
        <p className="text-center text-xs mt-2" style={{ color: '#64748b' }}>
          Final sale · non-refundable except where required by law
        </p>
      )}

      {/* Reassurance note for guests */}
      {isLoggedIn === false && (
        <p className="text-center text-xs text-slate-600 mt-2">
          Access links to your checkout email
        </p>
      )}
    </div>
  );
}
