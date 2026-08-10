'use client';

import { useState } from 'react';
import { ChevronDown, ChevronUp, Copy, Download, LifeBuoy, Check } from 'lucide-react';
import { useRouter } from 'next/navigation';

interface Run {
  id: string;
  created_at: string;
  list_name: string | null;
  mode: string | null;
  status: string;
  sent_count: number;
  skipped_count: number;
  failed_count: number;
  raw_log_sanitized: string | null;
  app_version: string | null;
  platform: string | null;
}

function buildSummary(run: Run): string {
  return [
    'StatfloBot Run Summary',
    `Date: ${new Date(run.created_at).toLocaleString()}`,
    `List: ${run.list_name ?? 'Unknown'}`,
    `Mode: ${run.mode ?? 'Unknown'}`,
    `Status: ${run.status}`,
    `Sent: ${run.sent_count}  Skipped: ${run.skipped_count}  Failed: ${run.failed_count}`,
    run.app_version ? `App version: ${run.app_version}` : '',
    run.platform    ? `Platform: ${run.platform}` : '',
    '',
    run.raw_log_sanitized ? `--- Activity log ---\n${run.raw_log_sanitized}` : '(no log captured)',
  ].filter(Boolean).join('\n');
}

export default function RunHistory({ runs }: { runs: Run[] }) {
  const router = useRouter();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedId,   setCopiedId]   = useState<string | null>(null);

  if (runs.length === 0) {
    return (
      <div className="space-y-1">
        <p className="text-sm text-slate-400">No runs recorded in the last 30 days.</p>
        <p className="text-xs text-slate-500">
          Run summaries appear here automatically after you use the desktop app.
        </p>
      </div>
    );
  }

  async function handleCopy(run: Run) {
    await navigator.clipboard.writeText(buildSummary(run));
    setCopiedId(run.id);
    setTimeout(() => setCopiedId(null), 2000);
  }

  function handleDownload(run: Run) {
    const blob = new Blob([buildSummary(run)], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `statflobot-run-${run.id.slice(0, 8)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleSendToSupport(run: Run) {
    sessionStorage.setItem('statflobot_run_log', JSON.stringify({
      id:                run.id,
      created_at:        run.created_at,
      list_name:         run.list_name,
      mode:              run.mode,
      status:            run.status,
      sent_count:        run.sent_count,
      skipped_count:     run.skipped_count,
      failed_count:      run.failed_count,
      app_version:       run.app_version,
      platform:          run.platform,
      raw_log_sanitized: run.raw_log_sanitized,
      summary:           buildSummary(run),
      subject:           `StatfloBot run issue — ${run.list_name ?? 'Unknown list'} / ${run.mode ?? 'Unknown mode'}`,
      listName:          run.list_name,
    }));
    router.push('/support?attachRun=1');
  }

  return (
    <div className="space-y-2">
      {runs.map(run => {
        const isExpanded = expandedId === run.id;
        const hasProblem = run.failed_count > 0
          || ['error', 'failed', 'browser_closed', 'completed_with_errors'].includes(run.status);

        return (
          <div
            key={run.id}
            className="rounded-xl border"
            style={{
              background:   'var(--raised)',
              borderColor:  hasProblem ? 'rgba(248,113,113,0.3)' : 'var(--border)',
            }}
          >
            {/* Summary row */}
            <div
              className="flex items-center gap-3 px-3 py-2.5 cursor-pointer select-none"
              onClick={() => setExpandedId(isExpanded ? null : run.id)}
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white truncate">
                  {run.list_name ?? 'Unknown list'}
                  {run.mode ? ` · ${run.mode}` : ''}
                </p>
                <p className="text-xs text-slate-500 mt-0.5">
                  {new Date(run.created_at).toLocaleString()}
                  {' · '}
                  <span style={{ color: '#86efac' }}>{run.sent_count} sent</span>
                  {run.skipped_count > 0 && (
                    <span className="text-slate-400"> · {run.skipped_count} skipped</span>
                  )}
                  {run.failed_count > 0 && (
                    <span style={{ color: '#f87171' }}> · {run.failed_count} failed</span>
                  )}
                </p>
              </div>
              {isExpanded
                ? <ChevronUp  size={14} className="text-slate-500 shrink-0" />
                : <ChevronDown size={14} className="text-slate-500 shrink-0" />
              }
            </div>

            {/* Expanded detail */}
            {isExpanded && (
              <div
                className="px-3 pb-3 pt-2.5 border-t space-y-2"
                style={{ borderColor: 'var(--border)' }}
              >
                {run.raw_log_sanitized && (
                  <pre
                    className="text-xs text-slate-400 whitespace-pre-wrap break-words rounded-lg px-3 py-2"
                    style={{ background: 'rgba(0,0,0,0.3)', maxHeight: '140px', overflowY: 'auto' }}
                  >
                    {run.raw_log_sanitized}
                  </pre>
                )}

                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => handleCopy(run)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-colors hover:border-violet-500/50"
                    style={{ background: 'var(--raised)', borderColor: 'var(--border)', color: '#94a3b8' }}
                  >
                    {copiedId === run.id
                      ? <Check size={12} style={{ color: '#86efac' }} />
                      : <Copy  size={12} />
                    }
                    {copiedId === run.id ? 'Copied' : 'Copy log'}
                  </button>

                  <button
                    onClick={() => handleDownload(run)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-colors hover:border-violet-500/50"
                    style={{ background: 'var(--raised)', borderColor: 'var(--border)', color: '#94a3b8' }}
                  >
                    <Download size={12} />
                    Download .txt
                  </button>

                  <button
                    onClick={() => handleSendToSupport(run)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors"
                    style={{
                      background:  hasProblem ? 'rgba(124,58,237,0.18)' : 'rgba(124,58,237,0.10)',
                      color:       '#a78bfa',
                      border:      `1px solid ${hasProblem ? 'rgba(124,58,237,0.4)' : 'rgba(124,58,237,0.25)'}`,
                    }}
                  >
                    <LifeBuoy size={12} />
                    Send log to support
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <p className="text-xs text-slate-600 pt-1">
        If a run fails, click{' '}
        <span style={{ color: '#a78bfa' }}>Send to support</span>{' '}
        and we'll receive the details needed to troubleshoot.
      </p>
    </div>
  );
}
