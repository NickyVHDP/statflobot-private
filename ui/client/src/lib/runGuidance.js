const LABELS = {
  SKIPPED_RECENTLY_MESSAGED_SINGLE_LINE: 'Recently messaged',
  SKIPPED_ALL_LINES_RECENTLY_MESSAGED: 'All lines recently messaged',
  SKIPPED_ALL_LINES_DNC: 'All lines marked DNC',
  SKIPPED_SEND_STATE_UNCERTAIN: 'Send status uncertain',
  SKIPPED_NO_ELIGIBLE_LINE: 'No eligible phone line',
  SKIPPED_NO_TEXT_AREA_OR_PREMADE_AVAILABLE: 'Message composer unavailable',
  SKIPPED_LINES_NOT_FULLY_ATTEMPTED: 'Not all phone lines could be checked',
  SKIPPED_ACCOUNT_VIEW_UNAVAILABLE: 'Account view unavailable',
  SKIPPED_UNKNOWN_RESULT: 'Unrecognized result',
};

const TECHNICAL_REASONS = new Set([
  'SKIPPED_SEND_STATE_UNCERTAIN',
  'SKIPPED_NO_TEXT_AREA_OR_PREMADE_AVAILABLE',
  'SKIPPED_LINES_NOT_FULLY_ATTEMPTED',
  'SKIPPED_ACCOUNT_VIEW_UNAVAILABLE',
  'SKIPPED_UNKNOWN_RESULT',
]);

export function skipReasonLabel(reason) {
  if (LABELS[reason]) return LABELS[reason];
  return String(reason || 'Unknown reason')
    .replace(/^SKIPPED_/, '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^./, value => value.toUpperCase());
}

export function skipBreakdown(run) {
  const reasons = Object.entries(run?.skip_reasons || run?.skipReasons || {})
    .map(([reason, count]) => ({ reason, label: skipReasonLabel(reason), count: Math.max(0, Number(count) || 0) }))
    .filter(item => item.count > 0)
    .sort((a, b) => b.count - a.count);
  const dnc = Math.max(0, Number(run?.dnc_count ?? run?.dnc) || 0);
  if (dnc > 0) reasons.push({ reason: 'DNC_LOGGED', label: 'Do-not-contact protected', count: dnc });
  return reasons;
}

export function runNeedsReview(run) {
  const failed = Number(run?.failed_count ?? run?.failed) || 0;
  const sent = Number(run?.sent_count ?? run?.messaged) || 0;
  const skipped = Number(run?.skipped_count ?? ((run?.skipped || 0) + (run?.dnc || 0))) || 0;
  return failed > 0 || (
    sent === 0 && skipped > 0
  );
}

export function runGuidance(run) {
  if (Number(run?.failed_count ?? run?.failed) > 0) {
    return 'This run recorded an automation failure. Send it to support before retrying the full list.';
  }
  if (!runNeedsReview(run)) return null;

  const reasons = Object.keys(run?.skip_reasons || run?.skipReasons || {});
  if (reasons.length === 0 && Number(run?.dnc_count ?? run?.dnc) === 0) {
    return 'This run sent no messages, but this older report did not save the skip breakdown. Confirm the contacts were not messaged in Statflo before rerunning.';
  }
  if (reasons.some(reason => TECHNICAL_REASONS.has(reason))) {
    return 'Some contacts were blocked by a safety or page-access condition. Check any uncertain sends in Statflo, then retry only after confirming no message was delivered.';
  }
  return 'No automation failure was recorded. These contacts were protected by recent-message or DNC rules, so another immediate run is not needed.';
}
