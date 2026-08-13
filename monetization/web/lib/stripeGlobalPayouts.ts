const STRIPE_V2_BASE = 'https://api.stripe.com';
const DEFAULT_PREVIEW_VERSION = '2026-02-25.preview';

export class StripeGlobalPayoutsError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'StripeGlobalPayoutsError';
    this.status = status;
    this.code = code;
  }
}

function secretKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  return key;
}

async function stripeV2<T>(opts: {
  path: string;
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  stripeContext?: string;
  idempotencyKey?: string;
}): Promise<T> {
  const response = await fetch(`${STRIPE_V2_BASE}${opts.path}`, {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${secretKey()}`,
      'Stripe-Version': process.env.STRIPE_GLOBAL_PAYOUTS_API_VERSION ?? DEFAULT_PREVIEW_VERSION,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.stripeContext ? { 'Stripe-Context': opts.stripeContext } : {}),
      ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });

  const payload = await response.json().catch(() => ({} as any));
  if (!response.ok) {
    const error = payload?.error ?? payload;
    throw new StripeGlobalPayoutsError(
      String(error?.message ?? `Stripe Global Payouts returned HTTP ${response.status}`),
      response.status,
      error?.code ? String(error.code) : undefined
    );
  }
  return payload as T;
}

export interface GlobalRecipient {
  id: string;
  configuration?: {
    recipient?: {
      capabilities?: {
        bank_accounts?: { local?: { status?: string } };
      };
    };
  };
  requirements?: unknown;
}

export interface GlobalPayoutMethod {
  id: string;
  type?: string;
  usage_status?: { payments?: string };
  bank_account?: { archived?: boolean };
  card?: { archived?: boolean };
}

export async function createGlobalRecipient(input: {
  referrerUserId: string;
  email: string;
  displayName: string;
}): Promise<GlobalRecipient> {
  return stripeV2<GlobalRecipient>({
    path: '/v2/core/accounts',
    method: 'POST',
    idempotencyKey: `referral_recipient_${input.referrerUserId}`,
    body: {
      contact_email: input.email,
      display_name: input.displayName,
      identity: { country: 'us', entity_type: 'individual' },
      configuration: {
        recipient: {
          capabilities: { bank_accounts: { local: { requested: true } } },
        },
      },
      include: ['identity', 'configuration.recipient', 'requirements'],
    },
  });
}

export async function createGlobalRecipientLink(input: {
  recipientId: string;
  referrerUserId: string;
  returnUrl: string;
  refreshUrl: string;
  update?: boolean;
}): Promise<{ url: string }> {
  const type = input.update ? 'account_update' : 'account_onboarding';
  return stripeV2<{ url: string }>({
    path: '/v2/core/account_links',
    method: 'POST',
    idempotencyKey: `referral_recipient_link_${input.referrerUserId}_${Date.now()}`,
    body: {
      account: input.recipientId,
      use_case: {
        type,
        [type]: {
          configurations: ['recipient'],
          return_url: input.returnUrl,
          refresh_url: input.refreshUrl,
        },
      },
    },
  });
}

export async function retrieveGlobalRecipient(recipientId: string): Promise<GlobalRecipient> {
  const query = new URLSearchParams();
  query.append('include[]', 'configuration.recipient');
  query.append('include[]', 'requirements');
  return stripeV2<GlobalRecipient>({
    path: `/v2/core/accounts/${encodeURIComponent(recipientId)}?${query.toString()}`,
  });
}

export async function listEligibleGlobalPayoutMethods(
  recipientId: string
): Promise<GlobalPayoutMethod[]> {
  const result = await stripeV2<{ data?: GlobalPayoutMethod[] }>({
    path: '/v2/money_management/payout_methods?limit=20',
    stripeContext: recipientId,
  });
  return (result.data ?? []).filter((method) =>
    method.usage_status?.payments === 'eligible' &&
    method.bank_account?.archived !== true &&
    method.card?.archived !== true
  );
}

export async function createGlobalOutboundPayment(input: {
  financialAccountId: string;
  recipientId: string;
  payoutMethodId: string;
  amountCents: number;
  payoutId: string;
  referrerUserId: string;
  idempotencyKey: string;
}): Promise<{ id: string; status?: string }> {
  return stripeV2<{ id: string; status?: string }>({
    path: '/v2/money_management/outbound_payments',
    method: 'POST',
    idempotencyKey: input.idempotencyKey,
    body: {
      from: { financial_account: input.financialAccountId, currency: 'usd' },
      to: {
        recipient: input.recipientId,
        payout_method: input.payoutMethodId,
        currency: 'usd',
      },
      amount: { value: input.amountCents, currency: 'usd' },
      delivery_options: { bank_account: 'automatic' },
      recipient_notification: { setting: 'configured' },
      description: 'StatfloBot referral reward',
      metadata: {
        payout_id: input.payoutId,
        referrer_user_id: input.referrerUserId,
      },
    },
  });
}

export async function retrieveGlobalOutboundPayment(
  outboundPaymentId: string
): Promise<{ id: string; status: 'processing' | 'posted' | 'failed' | 'returned' | 'canceled'; status_details?: unknown }> {
  return stripeV2({
    path: `/v2/money_management/outbound_payments/${encodeURIComponent(outboundPaymentId)}`,
  });
}
