# Ruflo Bot — Monetization Layer

Cloud billing + license verification that wraps the existing local automation.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  CLOUD (Vercel)                                         │
│                                                         │
│  monetization/web/   ← Next.js 14 app                  │
│  ├─ Landing / Pricing page  (dynamic early-adopter)    │
│  ├─ Auth pages              (Supabase auth)             │
│  ├─ Customer dashboard      (license, devices, billing) │
│  ├─ Admin panel             (licenses, subscriptions)   │
│  └─ API routes:                                         │
│       GET  /api/pricing                                 │
│       POST /api/checkout/monthly                        │
│       POST /api/checkout/lifetime   (price auto-picks)  │
│       POST /api/licenses/verify     ← bot calls this    │
│       POST /api/licenses/register-device                │
│       GET  /api/account                                 │
│       POST /api/billing/portal                          │
│       POST /api/webhooks/stripe                         │
│                                                         │
│  Supabase:  auth + database                             │
│  Stripe:    payments + webhooks + billing portal        │
└─────────────────────────────────────────────────────────┘
         ▲                          │
         │ verify license           │ provision license
         │ on bot startup           │ on webhook
         │                          ▼
┌─────────────────────────────────────────────────────────┐
│  LOCAL (customer's machine)                             │
│                                                         │
│  monetization/local-gate/   ← thin pre-run gate         │
│  ├─ auth-gate.js            ← called from src/main.js   │
│  ├─ license-client.js       ← HTTP verifier             │
│  └─ token-store.js          ← disk cache (~/.ruflo-bot) │
│                                                         │
│  src/   ← existing bot (UNTOUCHED except main.js gate)  │
│  ui/    ← existing local dashboard (UNTOUCHED)          │
└─────────────────────────────────────────────────────────┘
```

**Cloud runs:** billing, auth, license DB, webhook processing  
**Local runs:** Playwright browser automation (your machine, your Statflo session)

---

## Pricing Model

| Plan | Price | Available |
|------|-------|-----------|
| Monthly | $10/month | Always |
| Lifetime Early Adopter | $50 one-time | First 90 days after launch |
| Lifetime Standard | $100 one-time | After 90-day window |

Pricing window is **enforced server-side** via `pricing_config` table. The frontend receives it from `/api/pricing`.

---

## Setup — Step by Step

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com)
2. In the SQL editor, run `monetization/supabase/schema.sql`
3. Copy the project URL and anon key from Settings → API
4. Copy the service role key (keep secret)

### 2. Stripe

1. Create a Stripe account at [stripe.com](https://stripe.com)
2. Create three products:
   - **Monthly subscription**: $10/month recurring → copy price ID as `STRIPE_PRICE_MONTHLY`
   - **Lifetime Early Adopter**: $50 one-time → copy as `STRIPE_PRICE_LIFETIME_EARLY`
   - **Lifetime Standard**: $100 one-time → copy as `STRIPE_PRICE_LIFETIME_STANDARD`
3. Add the price IDs to `PLANS.stripe_price_id` in Supabase (or just use the env vars — the checkout routes use them directly)

### 3. Deploy the dashboard

```bash
cd monetization/web
npm install
cp .env.example .env.local
# Fill in all values in .env.local
vercel deploy
```

Or use any Next.js-compatible host (Railway, Fly.io, etc.).

### 4. Configure Stripe webhooks

In Stripe Dashboard → Webhooks → Add endpoint:
- URL: `https://your-app.vercel.app/api/webhooks/stripe`
- Events to listen for:
  - `checkout.session.completed`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.paid`
  - `invoice.payment_failed`

Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

### 5. Set launch date

In Supabase SQL editor:

```sql
UPDATE pricing_config SET launch_date = '2026-04-17' WHERE id = 1;
```

This starts the 90-day early-adopter clock.

### 6. Configure the local bot

Add to your root `.env`:

```env
LICENSE_API_URL=https://your-app.vercel.app
RUFLO_LICENSE_KEY=RUFLO-XXXX-XXXX-XXXX-XXXX
```

---

## Customer Journey

1. Customer visits `/` → sees pricing (early vs standard, enforced by backend)
2. Creates account → signs in
3. Clicks "Get Monthly" or "Get Lifetime" → Stripe Checkout
4. Payment succeeds → webhook fires → license row created → status `active`
5. Customer sees license key in `/dashboard`
6. Customer adds `RUFLO_LICENSE_KEY` to their bot's `.env`
7. On bot startup: `auth-gate.js` calls `/api/licenses/verify`
8. Valid → bot runs. Invalid → clean error message + link to dashboard

---

## Environment Variables

### monetization/web/.env.local

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_MONTHLY=
STRIPE_PRICE_LIFETIME_EARLY=
STRIPE_PRICE_LIFETIME_STANDARD=
NEXT_PUBLIC_APP_URL=
ADMIN_EMAILS=
```

### Root .env (local bot)

```env
LICENSE_API_URL=
RUFLO_LICENSE_KEY=
```

---

## Local Development

```bash
# Run the dashboard locally
cd monetization/web
npm install
npm run dev
# → http://localhost:3000

# Test webhooks locally with Stripe CLI
stripe listen --forward-to localhost:3000/api/webhooks/stripe

# Run the bot (with license gate)
cd ../..
npm start
```

For local bot dev without hitting the license API:
```env
LICENSE_SKIP=true
```

---

## Admin

Visit `/admin` while signed in with an email listed in `ADMIN_EMAILS`.  
Shows all licenses and subscriptions. Manual revoke/reactivate can be done directly in Supabase until a full admin UI is built.
