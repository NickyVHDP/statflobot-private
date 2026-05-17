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

// ── Stripe configuration checklist ──────────────────────────────────────────
// Before going live, verify the following in the Stripe dashboard:
//
// 1. STRIPE_PRICE_MONTHLY must be a "Recurring" price (monthly interval).
//    If set to one-time, checkout.session.completed fires with mode=payment
//    and the subscription table is never updated — bot access will never work.
//
// 2. STRIPE_PRICE_LIFETIME_EARLY and STRIPE_PRICE_LIFETIME_STANDARD must be
//    "One-time" prices (not recurring). If set to recurring, checkout fires
//    with mode=subscription and the lifetime license provisioning path is skipped.
//
// 3. Stripe Customer Portal must have "Cancel subscription" enabled.
//    Dashboard → Customer portal → Cancellation → Allow customers to cancel.
//    Without this, the "Manage billing" button opens a portal with no cancel option.
//
// 4. Webhook endpoint must be registered for the live environment with:
//    - checkout.session.completed
//    - customer.subscription.updated
//    - customer.subscription.deleted
//    - invoice.paid
//    - invoice.payment_failed
//
// 5. STRIPE_WEBHOOK_SECRET must match the signing secret for that endpoint.
//    Test and live webhooks have different secrets.
// ────────────────────────────────────────────────────────────────────────────