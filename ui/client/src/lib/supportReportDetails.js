// Attached diagnostics are useful even when a customer cannot describe the
// issue. Keep their own note intact; use a summary only when they leave it blank.
export function supportReportDescription(message, hasAttachedRun, status) {
  const note = String(message ?? '').trim();
  if (note || !hasAttachedRun) return note;
  return status === 'completed_with_errors'
    ? 'The run completed, but one or more clients failed. No additional explanation was provided; please review the attached run diagnostics.'
    : 'Please review the attached run diagnostics. No additional explanation was provided.';
}
