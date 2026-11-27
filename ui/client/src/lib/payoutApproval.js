/** Snapshot the deliberate owner action; opening this confirmation never pays. */
export function buildPayoutApproval(row, reward = null) {
  const code = String(row?.code ?? '').trim().toUpperCase();
  const amountCents = row?.eligibleCents + (reward?.amountCents ?? 0);
  if (!code || !row?.referrerUserId || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new Error('Refresh referrals before approving this payout.');
  }
  const early = Boolean(reward);
  if (early && !reward.attributionId) throw new Error('Refresh referrals before releasing this reward.');
  const amount = `$${(amountCents / 100).toFixed(2)}`;
  return {
    row, amount, early, attributionId: reward?.attributionId,
    action: early ? 'approve-early' : 'approve',
    expected: early ? `PAY NOW ${code} ${amount}` : `PAY ${code}`,
    recipient: row.referrerEmail || code,
  };
}

export function matchesPayoutApproval(approval, text) {
  return Boolean(approval?.expected && String(text ?? '').trim().toUpperCase() === approval.expected);
}
