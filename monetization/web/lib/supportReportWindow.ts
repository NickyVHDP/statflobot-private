/** Non-destructive working-queue window. Historical reports remain retrievable. */
export const SUPPORT_QUEUE_DAYS = 30;
export function supportReportWindow(range: string | null, now = Date.now()) {
  return {
    range: range === 'older' ? 'older' : 'recent',
    cutoff: new Date(now - SUPPORT_QUEUE_DAYS * 86_400_000).toISOString(),
  };
}
