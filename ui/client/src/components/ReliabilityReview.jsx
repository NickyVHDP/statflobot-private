import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, Download, Loader2, RefreshCw, Trash2, Users } from 'lucide-react';
import { cleanExpiredDashboardHistory, fetchReliabilityReview } from '../lib/cloudApi.js';
import { summarizeReliability } from '../lib/ownerAttention.js';

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
    latestVersions: payload.latestVersions,
    publicAppVersion: payload.publicAppVersion,
    outdatedUsers: payload.outdatedUsers,
    runs: payload.runs,
  };
  const blob = new Blob([JSON.stringify(safeBundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `statflobot-owner-runs-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function ReliabilityReview({ onLoaded, refreshToken = 0 }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanupNotice, setCleanupNotice] = useState(null);

  // Ref, not a dependency: the parent re-renders whenever this panel reports in,
  // and a changed callback identity must not retrigger the fetch.
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchReliabilityReview();
      setData(next);
      setSelected(current => current
        ? (next.runs || []).find(run => run.id === current.id) || null
        : null);
      onLoadedRef.current?.(summarizeReliability(next));
    } catch (err) {
      setError(err.status === 403 ? 'This activity view is restricted to the verified owner account.' : 'User run activity is temporarily unavailable.');
      onLoadedRef.current?.(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, refreshToken]);

  const cleanExpired = useCallback(async () => {
    setCleaning(true);
    setCleanupNotice(null);
    try {
      const result = await cleanExpiredDashboardHistory();
      setCleanupNotice(`Removed ${result.deletedRuns} expired run${result.deletedRuns === 1 ? '' : 's'} and ${result.deletedReports} resolved support report${result.deletedReports === 1 ? '' : 's'}.`);
      setSelected(null);
      await load();
    } catch {
      setCleanupNotice('Cleanup could not be completed. No current records were changed.');
    } finally {
      setCleaning(false);
    }
  }, [load]);

  const runs = useMemo(() => {
    const all = data?.runs || [];
    if (filter === 'failed') return all.filter(run => run.reportableFailure);
    if (filter === 'successful') return all.filter(run => !run.reportableFailure);
    return all;
  }, [data, filter]);
  const health = useMemo(() => summarizeReliability(data), [data]);

  return (
    <section className="rounded-xl p-5" style={{ background: '#13131a', border: '1px solid #1e1e2e' }}>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <div className="flex items-center gap-2">
            <Users size={16} style={{ color: '#a78bfa' }} />
            <h3 className="text-sm font-semibold text-white">User Runs</h3>
            <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ color: '#a78bfa', background: 'rgba(167,139,250,0.12)' }}>Owner only</span>
          </div>
          <p className="text-xs mt-1 max-w-xl" style={{ color: '#64748b' }}>
            See which account ran StatfloBot, when it ran, and whether it completed cleanly. Statflo customer names and message content remain private.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={cleanExpired} disabled={loading || cleaning} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs disabled:opacity-40" style={{ color: '#fca5a5', background: 'rgba(239,68,68,0.08)' }} title="Delete run history and resolved support reports older than 30 days">
            {cleaning ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} Clean 30+ days
          </button>
          <button onClick={load} disabled={loading} className="p-2 rounded-lg disabled:opacity-50" style={{ color: '#94a3b8', background: '#1e1e2e' }} title="Refresh">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          <button onClick={() => data && exportBundle(data)} disabled={!data?.runs?.length} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs disabled:opacity-40" style={{ color: '#c4b5fd', background: 'rgba(124,58,237,0.13)' }}>
            <Download size={13} /> Export
          </button>
        </div>
      </div>

      {error && <div className="rounded-lg px-3 py-2 text-xs mb-3" style={{ color: '#fca5a5', background: 'rgba(239,68,68,0.08)' }}>{error}</div>}
      {cleanupNotice && <div className="rounded-lg px-3 py-2 text-xs mb-3" style={{ color: '#c4b5fd', background: 'rgba(124,58,237,0.10)' }}>{cleanupNotice}</div>}
      {loading && !data ? (
        <div className="h-28 flex items-center justify-center gap-2 text-sm" style={{ color: '#64748b' }}><Loader2 size={15} className="animate-spin" /> Loading user runs…</div>
      ) : (
        <>
          {health && (
            <div className="rounded-lg p-3 mb-4" style={{ background: '#0e0e14', border: '1px solid #222233' }}>
              <div className="flex items-center gap-2 mb-2.5">
                <Activity size={13} style={{ color: '#a78bfa' }} />
                <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: '#94a3b8' }}>Usage and run health</span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <div className="text-[11px]" style={{ color: '#64748b' }}>Runs · last 24h</div>
                  <div className="text-lg font-semibold" style={{ color: '#e2e8f0' }}>{health.runsLast24h}</div>
                  <div className="text-[10px]" style={{ color: '#475569' }}>{health.totalRuns} retained</div>
                </div>
                <div>
                  <div className="text-[11px]" style={{ color: '#64748b' }}>Active users · 7 days</div>
                  <div className="text-lg font-semibold" style={{ color: '#c4b5fd' }}>{health.activeUsers7d}</div>
                  <div className="text-[10px]" style={{ color: '#475569' }}>Accounts with a run</div>
                </div>
                <div>
                  <div className="text-[11px]" style={{ color: '#64748b' }}>Messages sent · 24h</div>
                  <div className="text-lg font-semibold" style={{ color: '#86efac' }}>{health.sentLast24h}</div>
                  <div className="text-[10px]" style={{ color: '#475569' }}>Across recorded runs</div>
                </div>
                <div>
                  <div className="text-[11px]" style={{ color: '#64748b' }}>Failures · last 24h</div>
                  <div className="text-lg font-semibold" style={{ color: health.trendRatio > 1.5 ? '#f87171' : '#e2e8f0' }}>
                    {health.last24h}
                  </div>
                  <div className="text-[10px]" style={{ color: '#475569' }}>
                    {health.trendRatio === null
                      ? health.trendReason
                      : `${health.trendRatio >= 1 ? '↑' : '↓'} ${health.trendRatio.toFixed(1)}× the usual day`}
                  </div>
                </div>
              </div>
              {health.latestVersions.length > 0 && (
                <div className="mt-3 pt-3" style={{ borderTop: '1px solid #1a1a27' }}>
                  <div className="text-[11px] mb-1.5" style={{ color: '#64748b' }}>
                    Latest version seen per user{health.publicAppVersion ? ` · current release ${health.publicAppVersion}` : ''}
                  </div>
                  <div className="space-y-1">
                    {health.latestVersions.slice(0, 4).map(entry => (
                      <div key={entry.version} className="flex items-center justify-between gap-3 text-[11px]">
                        <span className="font-mono" style={{ color: '#c4b5fd' }}>{entry.version}</span>
                        <span style={{ color: '#64748b' }}>
                          {entry.count} user{entry.count === 1 ? '' : 's'}
                        </span>
                      </div>
                    ))}
                  </div>
                  {health.outdatedUsers > 0 && (
                    <p className="text-[10px] mt-2" style={{ color: '#fbbf24' }}>
                      {health.outdatedUsers} user{health.outdatedUsers === 1 ? '' : 's'} most recently reported an older build. Historical runs remain listed below for audit purposes.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-2 mb-3">
            {[
              ['all', `All runs (${data?.runs?.length ?? 0})`],
              ['successful', 'Completed'],
              ['failed', `Needs review (${data?.failureCount ?? 0})`],
            ].map(([value, label]) => (
              <button key={value} onClick={() => setFilter(value)} className="rounded-lg px-3 py-1.5 text-xs" style={{ color: filter === value ? '#ddd6fe' : '#64748b', background: filter === value ? 'rgba(124,58,237,0.14)' : '#0e0e14', border: '1px solid #222233' }}>{label}</button>
            ))}
          </div>

          {data?.truncated && <p className="text-[11px] mb-3" style={{ color: '#fbbf24' }}>Showing the newest {data.runs.length} runs. Export is bounded for safety.</p>}
          <div className="grid lg:grid-cols-[0.85fr_1.15fr] gap-3 min-h-[300px]">
            <div className="rounded-lg border overflow-y-auto max-h-[480px]" style={{ borderColor: '#222233', background: '#0e0e14' }}>
              {runs.length === 0 ? (
                <div className="h-32 flex items-center justify-center text-xs" style={{ color: '#64748b' }}>No matching runs.</div>
              ) : runs.map(run => (
                <button key={run.id} onClick={() => setSelected(run)} className="w-full text-left p-3 border-b" style={{ borderColor: '#1e1e2e', background: selected?.id === run.id ? 'rgba(99,102,241,0.09)' : 'transparent' }}>
                  <div className="flex justify-between gap-2">
                    <span className="text-xs font-medium truncate" style={{ color: '#e2e8f0' }}>{run.lockedUsername || run.actorName || run.actorEmail}</span>
                    <span className="text-[10px] whitespace-nowrap" style={{ color: '#64748b' }}>{formatDate(run.created_at)}</span>
                  </div>
                  {(run.lockedUsername || run.actorName) && <div className="text-[10px] truncate" style={{ color: '#64748b' }}>{run.actorEmail}</div>}
                  <div className="text-[11px] mt-1 flex items-center gap-1" style={{ color: run.reportableFailure ? '#fca5a5' : '#86efac' }}>
                    {run.reportableFailure ? <AlertTriangle size={11} /> : <CheckCircle2 size={11} />}
                    {run.reportableFailure ? run.categoryLabel : 'Completed'} · {run.sent_count} sent · {run.failed_count} failed
                  </div>
                </button>
              ))}
            </div>
            <div className="rounded-lg border p-3 overflow-auto max-h-[480px]" style={{ borderColor: '#222233', background: '#0a0a0f' }}>
              {!selected ? (
                <div className="h-full min-h-[180px] flex flex-col items-center justify-center text-center gap-2">
                  <Activity size={22} style={{ color: '#333345' }} />
                  <p className="text-xs" style={{ color: '#64748b' }}>Select a run to see its owner-safe details.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <div className="text-sm font-medium text-white">{selected.lockedUsername || selected.actorName || selected.actorEmail}</div>
                    {(selected.lockedUsername || selected.actorName) && <div className="text-[11px]" style={{ color: '#64748b' }}>{selected.actorEmail}</div>}
                    <div className="text-[11px] mt-1" style={{ color: '#64748b' }}>{formatDate(selected.created_at)} · Runtime app {selected.app_version || 'unknown'} · {selected.platform || 'unknown platform'}</div>
                    <div className="text-[11px] mt-1" style={{ color: '#94a3b8' }}>{selected.sent_count} sent · {selected.skipped_count} skipped · {selected.failed_count} failed</div>
                  </div>
                  {selected.reportableFailure ? (
                    <>
                      <div className="flex flex-wrap gap-1.5">
                        {(selected.markers || []).map(marker => <span key={marker} className="text-[10px] px-2 py-1 rounded" style={{ color: '#fbbf24', background: 'rgba(245,158,11,0.10)' }}>{marker}</span>)}
                        {!selected.markers?.length && <span className="text-[10px]" style={{ color: '#64748b' }}>No known marker — review the sanitized excerpt</span>}
                      </div>
                      <pre className="text-[10px] leading-relaxed whitespace-pre-wrap break-words" style={{ color: '#94a3b8' }}>{selected.raw_log_sanitized || 'No diagnostic excerpt was captured.'}</pre>
                    </>
                  ) : (
                    <div className="rounded-lg px-3 py-2 text-xs flex items-center gap-2" style={{ color: '#86efac', background: 'rgba(34,197,94,0.08)' }}><CheckCircle2 size={14} /> This run completed without a reportable automation failure.</div>
                  )}
                </div>
              )}
            </div>
          </div>
          <p className="text-[10px] mt-3" style={{ color: '#475569' }}>
            Run history and resolved support reports are deleted automatically after 30 days. Unresolved support requests, billing, referral, and payout records are preserved. Account identity is visible only to the owner.
          </p>
        </>
      )}
    </section>
  );
}
