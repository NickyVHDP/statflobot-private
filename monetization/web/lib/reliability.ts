export type ReliabilityCategory =
  | 'send_confirmation'
  | 'line_navigation'
  | 'dnc_workflow'
  | 'session_login'
  | 'embedded_browser'
  | 'identity_safety'
  | 'process_fatal'
  | 'unclassified';

const CATEGORY_MARKERS: ReadonlyArray<{
  category: ReliabilityCategory;
  markers: readonly string[];
}> = [
  {
    category: 'send_confirmation',
    markers: [
      'SMS_SEND_BLOCKED_SELECTOR_UNCERTAIN',
      'SEND_BUTTON_NOT_FOUND',
      'SEND_NOT_CONFIRMED',
      'UNCERTAIN_SEND_SKIP_CLIENT',
    ],
  },
  {
    category: 'line_navigation',
    markers: [
      'SMS_LINE_CLICK_ERROR',
      'SMS_LINE_INCOMPLETE_NO_DNC',
      'SMS_LINE_FILL_FAILED_NO_DNC',
      'SMS_LINE_UNCERTAIN_SKIP_NO_DNC',
    ],
  },
  {
    category: 'dnc_workflow',
    markers: [
      'DNC_MENU_NOT_FOUND',
      'DNC_LOG_ACTIVITY_FAILED_NONFATAL',
      'POST_DNC_FAILURE_REASON',
    ],
  },
  {
    category: 'session_login',
    markers: ['LOGIN_NAV_FAILED', 'LOGIN_REQUIRED', 'LOGIN_TIMEOUT'],
  },
  {
    category: 'embedded_browser',
    markers: [
      'EMBEDDED_BRIDGE_LOST',
      'EMBEDDED_ADAPTER_MISSING_METHOD',
      'RUN_STOPPED_BROWSER_CLOSED',
    ],
  },
  {
    // These are intentional access protections, not automation defects. They
    // remain visible as their own category so they are never mixed into fixes.
    category: 'identity_safety',
    markers: ['STATFLO_IDENTITY_MISMATCH_BLOCKED', 'STATFLO_IDENTITY_UNKNOWN_BLOCKED'],
  },
  {
    category: 'process_fatal',
    markers: ['BOOT_FATAL', 'UNCAUGHT_EXCEPTION', 'RUN_ALL_CLIENTS_FAILED'],
  },
] as const;

export const RELIABILITY_CATEGORY_LABELS: Record<ReliabilityCategory, string> = {
  send_confirmation: 'Send confirmation',
  line_navigation: 'Phone-line navigation',
  dnc_workflow: 'DNC workflow',
  session_login: 'Login / session',
  embedded_browser: 'Embedded browser',
  identity_safety: 'Identity safety block',
  process_fatal: 'Fatal process error',
  unclassified: 'Unclassified failure',
};

export function classifyReliabilityLog(rawLog: unknown): {
  category: ReliabilityCategory;
  categoryLabel: string;
  markers: string[];
} {
  const text = String(rawLog ?? '');
  const matched = CATEGORY_MARKERS.flatMap(({ category, markers }) =>
    markers.filter((marker) => text.includes(`[${marker}]`)).map((marker) => ({ category, marker }))
  );
  const category = matched[0]?.category ?? 'unclassified';
  return {
    category,
    categoryLabel: RELIABILITY_CATEGORY_LABELS[category],
    markers: Array.from(new Set(matched.map(({ marker }) => marker))).slice(0, 12),
  };
}

export function isReportableFailure(run: { status?: unknown; failed_count?: unknown }): boolean {
  const status = String(run.status ?? '').toLowerCase();
  return Number(run.failed_count) > 0 || [
    'failed', 'error', 'completed_with_errors', 'browser_closed',
  ].includes(status);
}
