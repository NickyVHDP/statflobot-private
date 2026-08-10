import { useEffect, useState } from 'react';
import { fetchPricing } from '../lib/cloudApi';

export function usePricing() {
  const [pricing, setPricing] = useState(null);

  useEffect(() => {
    let active = true;
    fetchPricing()
      .then(data => { if (active && !data?.error) setPricing(data); })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  const format = cents => cents == null ? null : `$${(Number(cents) / 100).toFixed(0)}`;
  return {
    pricing,
    monthlyLabel: pricing ? `${format(pricing.monthly_price_cents)}/mo` : null,
    lifetimeLabel: pricing ? format(pricing.lifetime_price_cents) : null,
  };
}
