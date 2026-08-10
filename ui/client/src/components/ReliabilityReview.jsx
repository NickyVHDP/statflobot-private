import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Download, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { fetchReliabilityReview } from '../lib/cloudApi.js';

const CATEGORY_COLORS = {
  send_confirmation: '#f59e0b',
  line_navigation: '#60a5fa',
  dnc_workflow: '#f472b6',
  session_login: '#a78bfa',
  embedded_browser: '#fb7185',
  identity_safety: '#64748b',
  process_fatal: '#ef4444',
  unclassified: '#94a3b8',
};

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : 'Unknown date';
}

function exportBundle(payload) {
  const safeBundle = {
    generatedAt: payload.generatedAt,
    retentionDays: payload.retentionDays,
    privacy: payload.privacy,
    categories: payload.categories,
    versions: payload.versions,
    runs: payload.runs,
  };
  const blob = new Blob([JSON.stringify(safeBundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `statflobot-reliability-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function ReliabilityReview() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchReliabilityReview();
      setData(next);
      setSelected(current => current
        ? (next.runs || []).find(run => run.id === current.id) || null
        : null);
    } catch (err) {
      setError(err.status === 403 ? 'This review is restricted to the verified owner account.' : 'Reliability data is temporarily unavailable.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const runs = useMemo(() => {
    const all = data?.runs || [];
    return filter === 'all' ? all : all.filter(run => run.category === filter);
  }, [data, filter]);
  const categories = Object.entries(data?.categories || {}).sort((a, b) => b[1] - a[1]);

  return (
    <section className="rounded-xl p-5" style={{ background: '#13131a', border: '1px solid #1e1e2e' }}>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck size={16} style={{ color: '#a78bfa' }} />
            <h3 className="text-sm font-semibold text-white">Reliability Review</h3>
            <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ color: '#a78bfa', background: 'rgba(167,139,250,0.12)' }}>Owner only</span>
          </div>
          <p className="text-xs mt-1 max-w-xl" style={{ color: '#64748b' }}>
            Failed and error runs across all accounts for the last {data?.retentionDays || 30} days. Customer identities and message content are omitted.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={load} disabled={loading} className="p-2 rounded-lg disabled:opacity-50" style={{ color: '#94a3b8', background: '#1e1e2e' }} title="Refresh">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          <button onClick={() => data && exportBundle(data)} disabled={!data?.runs?.length} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs disabled:opacity-40" style={{ color: '#c4b5fd', background: 'rgba(124,58,237,0.13)' }}>
            <Download size={13} /> Export repair bundle
          </button>
        </div>
      </div>

      {error && <div className="rounded-lg px-3 py-2 text-xs mb-3" style={{ color: '#fca5a5', background: 'rgba(239,68,68,0.08)' }}>{error}</div>}
      {loading && !data ? (
        <div className="h-28 flex items-center justify-center gap-2 text-sm" style={{ color: '#64748b' }}><Loader2 size={15} className="animate-spin" /> Loading failures…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
            <button onClick={() => setFilter('all')} className="text-left rounded-lg p-3" style={{ background: filter === 'all' ? 'rgba(99,102,241,0.13)' : '#0e0e14', border: '1px solid #222233' }}>
              <div className="text-[11px]" style={{ color: '#64748b' }}>Failure runs</div>
              <div className="text-xl font-semibold text-white">{data?.totalCount || 0}</div>
            </button>
            {categories.slice(0, 7).map(([category, count]) => {
              const sample = data.runs.find(run => run.category === category);
              return (
                <button key={category} onClick={() => setFilter(category)} className="text-left rounded-lg p-3" style={{ background: filter === category ? 'rgba(99,102,241,0.13)' : '#0e0e14', border: '1px solid #222233' }}>
                  <div className="text-[11px] truncate" style={{ color: CATEGORY_COLORS[category] || '#94a3b8' }}>{sample?.categoryLabel || category}</div>
                  <div className="text-xl font-semibold text-white">{count}</div>
                </button>
              );
            })}
          </div>

          {data?.truncated && <p className="text-[11px] mb-3" style={{ color: '#fbbf24' }}>Showing the newest {data.runs.length} failures. Export is bounded for safety.</p>}
          <div className="grid lg:grid-cols-[0.85fr_1.15fr] gap-3 min-h-[300px]">
            <div className="rounded-lg border overflow-y-auto max-h-[480px]" style={{ borderColor: '#222233', background: '#0e0e14' }}>
              {runs.length === 0 ? (
                <div className="h-32 flex items-center justify-center text-xs" style={{ color: '#64748b' }}>No matching failed runs.</div>
              ) : runs.map(run => (
                <button key={run.id} onClick={() => setSelected(run)} className="w-full text-left p-3 border-b" style={{ borderColor: '#1e1e2e', background: selected?.id === run.id ? 'rgba(99,102,241,0.09)' : 'transparent' }}>
                  <div className="flex justify-between gap-2">
                    <span className="text-xs font-medium truncate" style={{ color: '#e2e8f0' }}>{run.categoryLabel}</span>
                    <span className="text-[10px] whitespace-nowrap" style={{ color: '#64748b' }}>{formatDate(run.created_at)}</span>
                  </div>
                  <div className="text-[11px] mt-1" style={{ color: '#64748b' }}>App {run.app_version || 'unknown'} · {run.sent_count} sent · {run.skipped_count} skipped · {run.failed_count} failed</div>
                </button>
              ))}
            </div>
            <div className="rounded-lg border p-3 overflow-auto max-h-[480px]" style={{ borderColor: '#222233', background: '#0a0a0f' }}>
              {!selected ? (
                <div className="h-full min-h-[180px] flex flex-col items-center justify-center text-center gap-2">
                  <AlertTriangle size={22} style={{ color: '#333345' }} />
                  <p className="text-xs" style={{ color: '#64748b' }}>Select a failed run to inspect its sanitized diagnostic excerpt.</p>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap gap-1.5 mb-3">
                    {(selected.markers || []).map(marker => <span key={marker} className="text-[10px] px-2 py-1 rounded" style={{ color: '#fbbf24', background: 'rgba(245,158,11,0.10)' }}>{marker}</span>)}
                    {!selected.markers?.length && <span className="text-[10px]" style={{ color: '#64748b' }}>No known marker — needs manual classification</span>}
                  </div>
                  <pre className="text-[10px] leading-relaxed whitespace-pre-wrap break-words" style={{ color: '#94a3b8' }}>{selected.raw_log_sanitized || 'No diagnostic excerpt was captured.'}</pre>
                </>
              )}
            </div>
          </div>
          <p className="text-[10px] mt-3" style={{ color: '#475569' }}>
            Identity safety blocks are separated from defects. Cooldowns and explicit DNC states are expected skips unless the run also records a true automation error.
          </p>
        </>
      )}
    </section>
  );
}
