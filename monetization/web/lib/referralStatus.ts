/**
 * lib/referralStatus.ts
 *
 * The referral status vocabulary and the state machine that produces the list a
 * referrer sees.
 *
 * WHY THIS IS ITS OWN FILE: it has NO imports. Not Supabase, not Stripe, not
 * `next/*`. That is deliberate — tests/referrals.test.js imports this module
 * directly and exercises the real shipped function, rather than asserting on
 * its source text or re-implementing it. Money-adjacent display logic that
 * decides whether a customer is told "you earned this" deserves real coverage,
 * and the only way to get it here is to keep this file free of I/O.
 *
 * Nothing in this file computes a balance, a threshold or a transfer amount.
 * The append-only ledger remains the single authority on money; this decides
 * only what words appear next to a date.
 */

/**
 * The states a single referral moves through, in order.
 *
 *   code_applied  → a new buyer applied the code and started checkout
 *   not_completed → that checkout was never paid for
 *   purchased     → paid; inside the hold
 *   available     → past the hold; payable
 *   paid          → covered by a completed payout
 *   reversed      → the purchase was refunded or charged back
 */
export type ReferralStatus =
  | 'code_applied'
  | 'not_completed'
  | 'purchased'
  | 'available'
  | 'paid'
  | 'reversed';

/**
 * Plain-language labels.
 *
 * Deliberately avoids the bare word "pending", which previously meant two
 * different things — "someone applied my code" and "paid, inside the hold" —
 * and that ambiguity is exactly what leaves a referrer unsure whether they have
 * earned anything.
 *
 * These describe reward state, not a guaranteed transfer time. Automatic and
 * owner-approved payouts still pass funding, bank-readiness and safety checks.
 */
export const REFERRAL_STATUS_LABELS: Record<ReferralStatus, string> = {
  code_applied:  'Code applied — not paid yet',
  not_completed: 'Checkout not completed',
  purchased:     'Purchased — clearing',
  available:     'Ready for payout',
  paid:          'Paid',
  reversed:      'Reversed — purchase refunded',
};

/** Longer explanations, parameterised by the configured hold. */
export function referralStatusDescriptions(holdDays: number): Record<ReferralStatus, string> {
  return {
    code_applied:  'Someone started a Lifetime checkout with your code. You earn nothing until they pay.',
    not_completed: 'That checkout was not paid for. Nothing was earned.',
    purchased:     `Paid. Held for ${holdDays} days in case of a refund, then it becomes payable.`,
    available:     'Cleared the hold. Counts toward your next approved payout.',
    paid:          'Included in a payout that was approved and sent.',
    reversed:      'The purchase was refunded or charged back, so the reward was reversed.',
  };
}

export interface ReferralTimelineItem {
  /** ISO timestamp this entry is sorted and displayed by. */
  at: string;
  status: ReferralStatus;
  label: string;
  /** When a held reward matures. Null unless the status is `purchased`. */
  eligibleAt: string | null;
  /** Exact immutable reward for this purchase; null for unpaid checkouts. */
  amountCents: number | null;
  /** Present when the owner waived the remaining hold for this reward. */
  releasedEarlyAt: string | null;
}

export interface ReferralTimelineInput {
  /** Codes applied at checkout. `converted` rows are represented by their attribution instead. */
  reservations: Array<{ createdAt: string; expiresAt: string; status: string }>;
  attributions: Array<{ id: string; createdAt: string }>;
  accruals: Array<{
    attributionId: string;
    eligibleAt: string;
    amountCents: number;
    /** Present when the owner explicitly released this reward before the hold ended. */
    releasedEarlyAt?: string | null;
  }>;
  reversedAttributionIds: string[];
  /** Lifetime total already paid out, in cents (positive). */
  paidCents: number;
  now?: number;
}

/**
 * Derive the per-referral status list shown to a referrer.
 *
 * PURE — no I/O, and no clock beyond the injected `now`.
 *
 * The `paid` allocation is FIFO over matured accruals: a payout draws the
 * entire eligible balance at once, so the oldest cleared rewards are the ones a
 * completed payout covered. DISPLAY ONLY — it never feeds a balance, a
 * threshold check, or a transfer amount.
 */
export function deriveReferralTimeline(input: ReferralTimelineInput): ReferralTimelineItem[] {
  const now = input.now ?? Date.now();
  const reversed = new Set(input.reversedAttributionIds);
  const accrualById = new Map(input.accruals.map((a) => [a.attributionId, a]));

  const item = (
    at: string,
    status: ReferralStatus,
    eligibleAt: string | null = null,
    amountCents: number | null = null,
    releasedEarlyAt: string | null = null
  ): ReferralTimelineItem => ({ at, status, label: REFERRAL_STATUS_LABELS[status], eligibleAt, amountCents, releasedEarlyAt });

  const out: ReferralTimelineItem[] = [];

  // Bucket paid purchases first so payout coverage can be allocated in order.
  const matured: Array<{ createdAt: string; eligibleAt: string; amountCents: number; releasedEarlyAt: string | null }> = [];

  for (const a of input.attributions) {
    const accrual = accrualById.get(a.id);
    const eligibleAt = accrual?.eligibleAt ?? null;
    const amountCents = accrual?.amountCents ?? null;

    if (reversed.has(a.id)) {
      out.push(item(a.createdAt, 'reversed', null, amountCents, accrual?.releasedEarlyAt ?? null));
      continue;
    }
    // A missing accrual means the purchase landed but the reward write did not.
    // Show it as still clearing rather than inventing a payable reward.
    if (!eligibleAt || (new Date(eligibleAt).getTime() > now && !accrual?.releasedEarlyAt)) {
      out.push(item(a.createdAt, 'purchased', eligibleAt, amountCents, accrual?.releasedEarlyAt ?? null));
      continue;
    }
    matured.push({
      createdAt: a.createdAt,
      eligibleAt,
      amountCents: amountCents!,
      releasedEarlyAt: accrual?.releasedEarlyAt ?? null,
    });
  }

  matured.sort((x, y) => new Date(x.eligibleAt).getTime() - new Date(y.eligibleAt).getTime());

  let remainingPaid = Math.max(0, input.paidCents);
  for (const m of matured) {
    if (m.amountCents > 0 && remainingPaid >= m.amountCents) {
      remainingPaid -= m.amountCents;
      out.push(item(m.createdAt, 'paid', null, m.amountCents, m.releasedEarlyAt));
    } else {
      out.push(item(m.createdAt, 'available', null, m.amountCents, m.releasedEarlyAt));
    }
  }

  // Applied-but-unpaid checkouts. A `reserved` row past its TTL is treated as
  // abandoned even if `checkout.session.expired` never arrived.
  for (const r of input.reservations) {
    if (r.status === 'converted') continue;
    const stale = new Date(r.expiresAt).getTime() <= now;
    out.push(item(r.createdAt, r.status === 'reserved' && !stale ? 'code_applied' : 'not_completed'));
  }

  return out.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

type OwnerRewardStatus = 'clearing' | 'eligible' | 'processing' | 'completed' | 'reversed';
interface OwnerLedgerEntry {
  referrer_user_id: string;
  attribution_id?: string | null;
  payout_id?: string | null;
  entry_type: string;
  amount_cents: number;
  eligible_at?: string | null;
  created_at: string;
}

/**
 * Display-only FIFO coverage from actual payout debits, not lifetime totals.
 * A later reward cannot inherit an old payment, even if that payment's reward
 * was subsequently reversed. Completed means Stripe posted, not bank receipt.
 * This never reserves, approves, or changes a balance or payout.
 */
export function deriveOwnerReferralStatuses(input: {
  ledger: OwnerLedgerEntry[];
  payouts: Array<{ id: string; status: string; amount_cents: number }>;
  earlyApprovals?: Array<{ attribution_id: string; approved_at: string }>;
  now?: number;
}): Map<string, OwnerRewardStatus> {
  const now = input.now ?? Date.now();
  const early = new Map((input.earlyApprovals ?? []).map(a => [a.attribution_id, Date.parse(a.approved_at)]));
  const reversedAt = new Map<string, number>();
  for (const e of input.ledger) {
    if (e.entry_type === 'reversal' && e.attribution_id) {
      reversedAt.set(e.attribution_id, Math.min(reversedAt.get(e.attribution_id) ?? Infinity, Date.parse(e.created_at)));
    }
  }
  const rewards = input.ledger.filter(e => e.entry_type === 'accrual' && e.attribution_id).map(e => ({
    entry: e,
    readyAt: Math.min(Date.parse(e.eligible_at ?? ''), early.get(e.attribution_id!) ?? Infinity),
    paid: 0,
    processing: 0,
  })).sort((a, b) => a.readyAt - b.readyAt || Date.parse(a.entry.created_at) - Date.parse(b.entry.created_at) || a.entry.attribution_id!.localeCompare(b.entry.attribution_id!));
  const payouts = new Map(input.payouts.map(p => [p.id, p]));
  const seen = new Set<string>();
  const debits = input.ledger.filter(e => e.entry_type === 'payout' && e.payout_id)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  for (const debit of debits) {
    const payout = payouts.get(debit.payout_id!);
    if (!payout || !['paid', 'processing'].includes(payout.status) || seen.has(payout.id)) continue;
    seen.add(payout.id);
    let remaining = Math.min(-debit.amount_cents, payout.amount_cents);
    if (!Number.isSafeInteger(remaining) || remaining <= 0) continue;
    const sentAt = Date.parse(debit.created_at);
    for (const reward of rewards) {
      const e = reward.entry;
      if (remaining <= 0) break;
      if (e.referrer_user_id !== debit.referrer_user_id ||
          !(reward.readyAt <= sentAt && Date.parse(e.created_at) <= sentAt) ||
          (reversedAt.get(e.attribution_id!) ?? Infinity) <= sentAt ||
          !Number.isSafeInteger(e.amount_cents) || e.amount_cents <= 0) continue;
      const covered = Math.min(remaining, e.amount_cents - reward.paid - reward.processing);
      if (payout.status === 'paid') reward.paid += covered;
      else reward.processing += covered;
      remaining -= covered;
    }
  }
  return new Map(rewards.map(reward => {
    const e = reward.entry;
    const status: OwnerRewardStatus = reversedAt.has(e.attribution_id!) ? 'reversed'
      : reward.paid >= e.amount_cents && e.amount_cents > 0 ? 'completed'
      : reward.processing > 0 ? 'processing'
      : reward.readyAt <= now ? 'eligible' : 'clearing';
    return [e.attribution_id!, status];
  }));
}
