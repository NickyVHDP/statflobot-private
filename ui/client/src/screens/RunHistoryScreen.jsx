import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Check, Copy, Download, History, LifeBuoy, Loader2, RefreshCw, Send, SkipForward } from 'lucide-react';
import { getAccessToken } from '../lib/cloudApi.js';

const STATUS = {
  completed: { label: 'Complete', color: '#86efac', bg: 'rgba(34,197,94,0.10)' },
  completed_with_errors: { label: 'Completed with errors', color: '#fbbf24', bg: 'rgba(251,191,36,0.10)' },
  failed: { label: 'Failed', color: '#f87171', bg: 'rgba(248,113,113,0.10)' },
  error: { label: 'Error', color: '#f87171', bg: 'rgba(248,113,113,0.10)' },
  stopped: { label: 'Stopped', color: '#94a3b8', bg: 'rgba(148,163,184,0.10)' },
  browser_closed: { label: 'Browser closed', color: '#fbbf24', bg: 'rgba(251,191,36,0.10)' },
  recorded: { label: 'Recorded', color: '#94a3b8', bg: 'rgba(148,163,184,0.10)' },
};

function formatDate(value) {
  if (!value) return 'Unknown date';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(value));
}

function buildSummary(run) {
  return [
    'StatfloBot Run Summary',
    `Date: ${formatDate(run.created_at)}`,
    `List: ${run.list_name || 'Unknown'}`,
    `Mode: ${run.mode || 'Unknown'}`,
    `Status: ${run.status}`,
    `Sent: ${run.sent_count}  Skipped: ${run.skipped_count}  Failed: ${run.failed_count}`,
    run.app_version ? `App version: ${run.app_version}` : '',
    run.platform ? `Platform: ${run.platform}` : '',
    '',
    run.raw_log_sanitized ? `--- Sanitized activity log ---\n${run.raw_log_sanitized}` : '(no activity log captured)',
  ].filter(Boolean).join('\n');
}

async function loadCloudHistory() {
  const token = await getAccessToken();
  const response = await fetch('/api/proxy/runs', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function SummaryCard({ Icon, label, value, color }) {
  return (
    <div className="rounded-xl border p-4" style={{ background: '#13131a', borderColor: '#1e1e2e' }}>
      <div className="flex items-center gap-2 mb-2 text-xs" style={{ color: '#64748b' }}>
        <Icon size={14} style={{ color }} /> {label}
      </div>
      <div className="text-2xl font-semibold" style={{ color: '#f1f5f9' }}>{value}</div>
    </div>
  );
}

export default function RunHistoryScreen({ isAdmin = false }) {
  const [runs, setRuns] = useState([]);
  const [retentionDays, setRetentionDays] = useState(30);
  const [totalCount, setTotalCount] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [copied, setCopied] = useState(false);
  const [diagnosticsVisible, setDiagnosticsVisible] = useState(false);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await loadCloudHistory();
      setRuns(data.runs || []);
      setRetentionDays(data.retentionDays || 30);
      setTotalCount(Number(data.totalCount) || (data.runs || []).length);
      setTruncated(data.truncated === true);
      setDiagnosticsVisible(isAdmin && data.diagnosticsVisible === true);
      setSelected(current => {
        if (!current) return null;
        return (data.runs || []).find(run => run.id === current.id) || null;
      });
    } catch (err) {
      setError(err.status === 401
        ? 'Please sign in again to view your account history.'
        : 'Run history is temporarily unavailable. Your saved runs have not been lost.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const totals = useMemo(() => runs.reduce((acc, run) => {
    acc.sent += Number(run.sent_count) || 0;
    acc.skipped += Number(run.skipped_count) || 0;
    acc.failed += Number(run.failed_count) || 0;
    return acc;
  }, { sent: 0, skipped: 0, failed: 0 }), [runs]);

  async function copyRun(run) {
    await navigator.clipboard.writeText(buildSummary(run)).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  function downloadRun(run) {
    const blob = new Blob([buildSummary(run)], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `statflobot-run-${run.id.slice(0, 8)}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function sendToSupport(run) {
    sessionStorage.setItem('statflobot_support_history_run', JSON.stringify({
      id: run.id,
      created_at: run.created_at,
      list_name: run.list_name,
      mode: run.mode,
      status: run.status,
      sent_count: run.sent_count,
      skipped_count: run.skipped_count,
      failed_count: run.failed_count,
      app_version: run.app_version,
      platform: run.platform,
    }));
    window.location.href = `/support?attachHistoryRun=1&runId=${encodeURIComponent(run.id)}`;
  }

  return (
    <main className="flex-1 container mx-auto px-4 py-6 max-w-7xl w-full">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <History size={20} style={{ color: '#818cf8' }} />
            <h1 className="text-xl font-semibold text-white">Run History</h1>
          </div>
          <p className="text-sm" style={{ color: '#64748b' }}>
            Safe run summaries connected to your account from the last {retentionDays} days. Technical logs stay private.
          </p>
        </div>
        <button
          onClick={loadHistory}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium disabled:opacity-50"
          style={{ background: '#13131a', border: '1px solid #1e1e2e', color: '#94a3b8' }}
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <SummaryCard Icon={History} label="Runs" value={totalCount} color="#818cf8" />
        <SummaryCard Icon={Send} label={truncated ? 'Messages sent (shown)' : 'Messages sent'} value={totals.sent} color="#86efac" />
        <SummaryCard Icon={SkipForward} label={truncated ? 'Skipped (shown)' : 'Skipped'} value={totals.skipped} color="#fbbf24" />
        <SummaryCard Icon={AlertCircle} label={truncated ? 'Failed (shown)' : 'Failed'} value={totals.failed} color={totals.failed ? '#f87171' : '#64748b'} />
      </div>

      {error && (
        <div className="rounded-xl border px-4 py-3 mb-5 text-sm" style={{ color: '#fca5a5', background: 'rgba(239,68,68,0.08)', borderColor: 'rgba(239,68,68,0.25)' }}>
          {error}
        </div>
      )}
      {truncated && !error && (
        <div className="text-xs mb-4" style={{ color: '#64748b' }}>
          Showing the latest {runs.length} of {totalCount} runs from this {retentionDays}-day period.
        </div>
      )}

      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)] gap-4 min-h-[480px]">
        <section className="rounded-xl border overflow-hidden" style={{ background: '#13131a', borderColor: '#1e1e2e' }}>
          <div className="px-4 py-3 border-b text-xs font-medium" style={{ borderColor: '#1e1e2e', color: '#94a3b8' }}>Recent runs</div>
          <div className="max-h-[620px] overflow-y-auto">
            {loading ? (
              <div className="h-48 flex items-center justify-center gap-2 text-sm" style={{ color: '#64748b' }}>
                <Loader2 size={16} className="animate-spin" /> Loading history…
              </div>
            ) : runs.length === 0 ? (
              <div className="h-48 flex flex-col items-center justify-center gap-2 text-center px-6">
                <History size={28} style={{ color: '#2d2d3d' }} />
                <p className="text-sm" style={{ color: '#64748b' }}>No runs were recorded in the last {retentionDays} days.</p>
                <p className="text-xs" style={{ color: '#3d4152' }}>New run summaries appear here automatically.</p>
              </div>
            ) : runs.map(run => {
              const status = STATUS[run.status] || STATUS.recorded;
              const active = selected?.id === run.id;
              return (
                <button
                  key={run.id}
                  onClick={() => { setSelected(run); setCopied(false); }}
                  className="w-full text-left px-4 py-3 border-b transition-colors"
                  style={{ borderColor: '#1e1e2e', background: active ? 'rgba(99,102,241,0.09)' : 'transparent' }}
                >
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate" style={{ color: '#e2e8f0' }}>{run.list_name || 'Unknown list'}</div>
                      <div className="text-xs mt-0.5" style={{ color: '#64748b' }}>{formatDate(run.created_at)}{run.mode ? ` · ${run.mode}` : ''}</div>
                    </div>
                    <span className="text-[11px] px-2 py-0.5 rounded-full whitespace-nowrap" style={{ color: status.color, background: status.bg }}>{status.label}</span>
                  </div>
                  <div className="flex gap-4 text-xs" style={{ color: '#64748b' }}>
                    <span style={{ color: '#86efac' }}>{run.sent_count} sent</span>
                    <span>{run.skipped_count} skipped</span>
                    <span style={{ color: run.failed_count ? '#f87171' : '#64748b' }}>{run.failed_count} failed</span>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="rounded-xl border flex flex-col overflow-hidden" style={{ background: '#13131a', borderColor: '#1e1e2e' }}>
          <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: '#1e1e2e' }}>
            <div>
              <div className="text-xs font-medium" style={{ color: '#94a3b8' }}>Run details</div>
              {selected && <div className="text-[11px] mt-0.5" style={{ color: '#475569' }}>{formatDate(selected.created_at)}</div>}
            </div>
            {selected && (
              <div className="flex items-center gap-3">
                {diagnosticsVisible && <button onClick={() => copyRun(selected)} className="flex items-center gap-1.5 text-xs" style={{ color: copied ? '#86efac' : '#818cf8' }}>
                  {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
                </button>}
                {diagnosticsVisible && <button onClick={() => downloadRun(selected)} className="flex items-center gap-1.5 text-xs" style={{ color: '#818cf8' }}>
                  <Download size={12} /> Download
                </button>}
                <button onClick={() => sendToSupport(selected)} className="flex items-center gap-1.5 text-xs" style={{ color: '#a78bfa' }}>
                  <LifeBuoy size={12} /> Send to support
                </button>
              </div>
            )}
          </div>
          <div className="flex-1 min-h-[420px] overflow-auto p-4">
            {!selected ? (
              <div className="h-full flex flex-col items-center justify-center gap-2 text-center">
                <History size={26} style={{ color: '#2d2d3d' }} />
                <p className="text-sm" style={{ color: '#64748b' }}>Select a run to view its details.</p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-2 mb-4">
                  <SummaryCard Icon={Send} label="Sent" value={selected.sent_count} color="#86efac" />
                  <SummaryCard Icon={SkipForward} label="Skipped" value={selected.skipped_count} color="#fbbf24" />
                  <SummaryCard Icon={AlertCircle} label="Failed" value={selected.failed_count} color={selected.failed_count ? '#f87171' : '#64748b'} />
                </div>
                <div className="text-xs mb-3 flex flex-wrap gap-x-4 gap-y-1" style={{ color: '#64748b' }}>
                  {selected.app_version && <span>App {selected.app_version}</span>}
                  {selected.platform && <span>{selected.platform}</span>}
                  {selected.mode && <span>{selected.mode}</span>}
                </div>
                {diagnosticsVisible ? (
                  <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words rounded-lg p-3" style={{ color: '#94a3b8', background: '#0a0a0f', minHeight: 180 }}>
                    {selected.raw_log_sanitized || 'No activity log was captured for this run.'}
                  </pre>
                ) : (
                  <div className="rounded-lg p-4 text-sm" style={{ color: '#64748b', background: '#0a0a0f' }}>
                    Technical diagnostics are kept private. If this run needs attention, choose <strong style={{ color: '#a78bfa' }}>Send to support</strong> and the server will attach them securely.
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
