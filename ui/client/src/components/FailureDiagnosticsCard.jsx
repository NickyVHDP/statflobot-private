import { useState, useCallback } from 'react';
import { AlertTriangle, Copy, Check, Download, RefreshCw, Send, ChevronDown, ChevronRight } from 'lucide-react';

function CopyBtn({ label, getText, small }) {
  const [copied, setCopied] = useState(false);
  async function handle() {
    try {
      const text = typeof getText === 'function' ? await getText() : getText;
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable */ }
  }
  return (
    <button
      onClick={handle}
      className="flex items-center gap-1.5 rounded-lg transition-all"
      style={{
        padding: small ? '4px 10px' : '6px 14px',
        fontSize: small ? 11 : 12,
        fontWeight: 500,
        background: copied ? 'rgba(134,239,172,0.12)' : 'rgba(99,102,241,0.12)',
        border: `1px solid ${copied ? 'rgba(134,239,172,0.3)' : 'rgba(99,102,241,0.3)'}`,
        color: copied ? '#86efac' : '#818cf8',
        cursor: 'pointer',
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? 'Copied!' : label}
    </button>
  );
}

function Collapsible({ title, defaultOpen, children, badge }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div style={{ border: '1px solid #1e1e2e', borderRadius: 8, overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-left"
        style={{ background: '#0d0d17', cursor: 'pointer' }}
      >
        <span className="flex items-center gap-2 text-xs font-medium" style={{ color: '#94a3b8' }}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {title}
        </span>
        {badge && (
          <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(239,68,68,0.15)', color: '#f87171' }}>
            {badge}
          </span>
        )}
      </button>
      {open && (
        <div
          style={{
            background: '#060610',
            padding: '6px 8px',
            maxHeight: 200,
            overflowY: 'auto',
            fontFamily: 'monospace',
            fontSize: 9,
            color: '#64748b',
            lineHeight: '13px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function LogBlock({ content }) {
  if (!content) return <span style={{ color: '#475569' }}>(no content)</span>;
  return content.split('\n').map((line, i) => {
    const isErr = /error|fatal|fail|exception/i.test(line);
    const isKey = MARKER_NAMES.some(m => line.includes(`[${m}]`));
    return (
      <div key={i} style={{ color: isKey ? '#fbbf24' : isErr ? '#f87171' : '#64748b' }}>
        {line || ' '}
      </div>
    );
  });
}

const MARKER_NAMES = [
  'FINAL_SPAWN_CONTRACT_FAILED', 'EMBEDDED_ENDPOINT_UNAVAILABLE', 'DASHBOARD_EMBEDDED_REQUIRED',
  'EMBEDDED_BROWSER_ENDPOINT_MISSING', 'BOOT_FATAL', 'UNCAUGHT_EXCEPTION', 'UNHANDLED_REJECTION',
  'BOOT_LICENSE_BLOCKED', 'PATH_GUARD_REJECTED', 'SUPPORT_EMAIL_DELIVERY_FAILED',
];

export default function FailureDiagnosticsCard({ diagnostics, onRefresh, onSendReport }) {
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await onRefresh?.(); } finally { setRefreshing(false); }
  }, [onRefresh]);

  const handleDownload = useCallback(() => {
    if (!diagnostics) return;
    const blob = new Blob([JSON.stringify(diagnostics, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `statflobot-failure-${diagnostics.serverInstanceId ?? 'report'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [diagnostics]);

  const getSummaryText = useCallback(() => {
    if (!diagnostics) return '';
    return [
      `StatfloBot Failure Report — ${diagnostics.createdAt ?? new Date().toISOString()}`,
      `Likely cause: ${diagnostics.likelyCause}`,
      `Exit code: ${diagnostics.exitCode ?? 'unknown'}`,
      `Fatal markers: ${diagnostics.fatalMarkers?.join(', ') || 'none'}`,
      `isDesktop: ${diagnostics.isDesktop}`,
      `USER_DATA_DIR: ${diagnostics.userDataDirPresent ? 'present' : 'MISSING'}`,
      `STATFLOBOT_DESKTOP: ${diagnostics.statflobotDesktopPresent ? 'present' : 'MISSING'}`,
      `EMBEDDED_WS_ENDPOINT: ${diagnostics.embeddedBrowserWsEndpointPresent ? 'present' : 'MISSING'}`,
      `Server: instanceId=${diagnostics.serverInstanceId} pid=${diagnostics.pid} source=${diagnostics.serverSource}`,
    ].join('\n');
  }, [diagnostics]);

  const getFullBundleText = useCallback(() => {
    if (!diagnostics) return '';
    return JSON.stringify(diagnostics, null, 2);
  }, [diagnostics]);

  const getRufloPrompt = useCallback(() => {
    return diagnostics?.recommendedNextPrompt || '';
  }, [diagnostics]);

  if (!diagnostics) {
    return (
      <div
        className="rounded-2xl p-5 border"
        style={{ background: '#13131f', borderColor: 'rgba(255,255,255,0.07)' }}
      >
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle size={15} style={{ color: '#f59e0b' }} />
          <h2 className="text-sm font-semibold text-white">Failure Diagnostics</h2>
        </div>
        <p className="text-xs" style={{ color: '#64748b' }}>No failure recorded yet. Diagnostics are auto-captured on run failure.</p>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="mt-3 flex items-center gap-1.5 text-xs transition-colors disabled:opacity-40"
          style={{ color: '#818cf8' }}
        >
          <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
          Check for failures
        </button>
      </div>
    );
  }

  const hasMarkers = diagnostics.fatalMarkers && diagnostics.fatalMarkers.length > 0;

  return (
    <div
      className="rounded-2xl p-5 border flex flex-col gap-4"
      style={{ background: '#13131f', borderColor: 'rgba(239,68,68,0.25)' }}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <AlertTriangle size={15} style={{ color: '#f87171', marginTop: 1, flexShrink: 0 }} />
          <div>
            <h2 className="text-sm font-semibold" style={{ color: '#f87171' }}>Run Failed</h2>
            <p className="text-xs mt-0.5" style={{ color: '#64748b' }}>
              {diagnostics.createdAt ? new Date(diagnostics.createdAt).toLocaleString() : '—'}
            </p>
          </div>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="text-xs flex items-center gap-1 disabled:opacity-40"
          style={{ color: '#475569', cursor: 'pointer' }}
        >
          <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Likely cause */}
      <div
        className="rounded-xl px-3 py-2.5 text-xs"
        style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: '#fca5a5', lineHeight: 1.6 }}
      >
        <span className="font-semibold" style={{ color: '#f87171' }}>Likely cause: </span>
        {diagnostics.likelyCause}
      </div>

      {/* Key env signals */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: 'isDesktop',   ok: diagnostics.isDesktop,                         val: diagnostics.isDesktop ? 'true' : 'false' },
          { label: 'USER_DATA',   ok: diagnostics.userDataDirPresent,                val: diagnostics.userDataDirPresent ? 'present' : 'MISSING' },
          { label: 'WS_ENDPOINT', ok: diagnostics.embeddedBrowserWsEndpointPresent, val: diagnostics.embeddedBrowserWsEndpointPresent ? 'present' : 'MISSING' },
        ].map(({ label, ok, val }) => (
          <div
            key={label}
            className="rounded-lg px-2 py-1.5 text-center"
            style={{
              background: ok ? 'rgba(134,239,172,0.08)' : 'rgba(239,68,68,0.08)',
              border: `1px solid ${ok ? 'rgba(134,239,172,0.2)' : 'rgba(239,68,68,0.2)'}`,
            }}
          >
            <div className="text-xs" style={{ color: '#64748b', fontSize: 9, marginBottom: 2 }}>{label}</div>
            <div className="text-xs font-mono font-semibold" style={{ color: ok ? '#86efac' : '#f87171', fontSize: 10 }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Fatal markers */}
      {hasMarkers && (
        <div className="rounded-lg px-3 py-2 text-xs" style={{ background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.2)' }}>
          <span className="font-semibold" style={{ color: '#fbbf24' }}>Markers: </span>
          <span style={{ color: '#fde68a', fontFamily: 'monospace' }}>{diagnostics.fatalMarkers.join(', ')}</span>
        </div>
      )}

      {/* Exit code + server info row */}
      <div className="flex gap-3 text-xs" style={{ color: '#64748b' }}>
        <span>exit <span className="font-mono" style={{ color: '#94a3b8' }}>{diagnostics.exitCode ?? '?'}</span></span>
        <span>·</span>
        <span>pid <span className="font-mono" style={{ color: '#94a3b8' }}>{diagnostics.pid ?? '?'}</span></span>
        <span>·</span>
        <span>list <span className="font-mono" style={{ color: '#94a3b8' }}>{diagnostics.selectedList ?? '?'}</span></span>
        <span>·</span>
        <span style={{ fontFamily: 'monospace', color: diagnostics.isDesktop ? '#86efac' : '#f87171' }}>
          {diagnostics.serverSource ?? '?'}
        </span>
      </div>

      {/* Log sections */}
      <div className="flex flex-col gap-2">
        {diagnostics.finalSpawnContract && (
          <Collapsible title="Final Spawn Contract" defaultOpen badge={diagnostics.fatalMarkers?.includes('FINAL_SPAWN_CONTRACT_FAILED') ? 'FAILED' : null}>
            <LogBlock content={diagnostics.finalSpawnContract} />
          </Collapsible>
        )}
        {diagnostics.bootLastLogContent && (
          <Collapsible title="boot-last.log">
            <LogBlock content={diagnostics.bootLastLogContent.split('\n').slice(-60).join('\n')} />
          </Collapsible>
        )}
        {diagnostics.latestRunLogContent && (
          <Collapsible title="Latest Run Log">
            <LogBlock content={diagnostics.latestRunLogContent.split('\n').slice(-80).join('\n')} />
          </Collapsible>
        )}
        {diagnostics.stderrLines && diagnostics.stderrLines.length > 0 && (
          <Collapsible title={`stderr (${diagnostics.stderrLines.length} lines)`} defaultOpen badge="errors">
            <LogBlock content={diagnostics.stderrLines.join('\n')} />
          </Collapsible>
        )}
        {diagnostics.recentServerLog && diagnostics.recentServerLog.length > 0 && (
          <Collapsible title={`Recent Server Log (${diagnostics.recentServerLog.length} lines)`}>
            <LogBlock content={diagnostics.recentServerLog.slice(-50).join('\n')} />
          </Collapsible>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex flex-wrap gap-2 pt-1">
        <CopyBtn label="Copy Summary"       getText={getSummaryText}  />
        <CopyBtn label="Copy Full Bundle"   getText={getFullBundleText} />
        <CopyBtn label="Copy Ruflo Prompt"  getText={getRufloPrompt}  />
        <button
          onClick={handleDownload}
          className="flex items-center gap-1.5 rounded-lg transition-all"
          style={{ padding: '6px 14px', fontSize: 12, fontWeight: 500, background: 'rgba(30,30,46,0.8)', border: '1px solid #1e1e2e', color: '#64748b', cursor: 'pointer' }}
        >
          <Download size={12} />
          Download JSON
        </button>
        {onSendReport && (
          <button
            onClick={() => onSendReport(diagnostics)}
            className="flex items-center gap-1.5 rounded-lg transition-all"
            style={{ padding: '6px 14px', fontSize: 12, fontWeight: 500, background: 'rgba(30,30,46,0.8)', border: '1px solid #1e1e2e', color: '#64748b', cursor: 'pointer' }}
          >
            <Send size={12} />
            Send Report
          </button>
        )}
      </div>
    </div>
  );
}
