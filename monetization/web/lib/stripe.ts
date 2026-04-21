import Stripe from 'stripe';

export function getStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not set');
  }

  return new Stripe(secretKey, {
    apiVersion: '2024-06-20',
    typescript: true,
  });
}

export const PRICE_IDS = {
  monthly: process.env.STRIPE_PRICE_MONTHLY!,
  lifetime_early: process.env.STRIPE_PRICE_LIFETIME_EARLY!,
  lifetime_standard: process.env.STRIPE_PRICE_LIFETIME_STANDARD!,
} as const;