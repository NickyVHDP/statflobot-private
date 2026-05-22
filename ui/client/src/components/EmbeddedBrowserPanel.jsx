import { useEffect, useRef, useState, useCallback } from 'react';
import { Globe, Loader, Copy, ChevronDown } from 'lucide-react';

const SENTINEL_MARKER = 'statflobot-automation-view';

function isSentinelOrBlank(url) {
  if (!url || url === '' || url === 'about:blank') return true;
  return url.includes(SENTINEL_MARKER);
}

const PILL_CONFIG = {
  idle:     { label: 'Automation Browser', color: '#475569' },
  active:   { label: 'Embedded Active',    color: '#4ade80' },
  loading:  { label: 'Embedded Loading',   color: '#fbbf24' },
  fallback: { label: 'External Browser',   color: '#f97316' },
  error:    { label: 'Embedded Error',     color: '#f87171' },
};

export default function EmbeddedBrowserPanel({
  runState,
  logs = [],
  lastRunStatus  = null,
  lastRunLogFile = null,
  isAdmin        = false,
}) {
  const containerRef  = useRef(null);
  const shouldShowRef = useRef(false);
  const rafRef        = useRef(null);
  const [status, setStatus]               = useState({ url: 'about:blank', loading: false });
  const [isReady, setIsReady]             = useState(false);
  const [forceFallback, setForceFallback] = useState(false);
  const [showDiag, setShowDiag]           = useState(false);
  const [diagTab, setDiagTab]             = useState('filtered'); // 'filtered' | 'all'
  const [copied, setCopied]               = useState(false);

  const isError = lastRunStatus === 'error';

  // Auto-open diagnostics after an error run so the user sees it immediately
  useEffect(() => {
    if (isError) setShowDiag(true);
  }, [isError]);

  const diagLogs = logs.filter(l => l.text && (
    l.text.includes('[EMBEDDED') ||
    l.text.includes('[BRIDGE') ||
    l.text.includes('[AUTOMATION') ||
    l.text.includes('[BROWSER_') ||
    l.text.includes('[LOGIN_') ||
    l.text.includes('[PROXY_') ||
    l.text.includes('[ADAPTER') ||
    l.text.includes('Fatal error') ||
    l.text.includes('TypeError') ||
    l.text.includes('Error:')
  ));
  const displayedLogs = diagTab === 'all' ? logs : diagLogs;

  const copyDiag = useCallback(() => {
    const text = displayedLogs.map(l => l.text).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }, [displayedLogs]);

  const hasFallback = forceFallback || logs.some(l => l.text?.includes('[EMBEDDED_BROWSER_FALLBACK_USED]'));
  const hasMatchFailed = logs.some(l =>
    l.text?.includes('[EMBEDDED_TARGET_MATCH_FAILED]') &&
    l.text?.includes('Playwright pages')
  );

  let pillState = 'idle';
  if (hasFallback || hasMatchFailed) pillState = 'fallback';
  else if (isError && !isSentinelOrBlank(status.url)) pillState = 'error';
  else if (status.loading)           pillState = 'loading';
  else if (!isSentinelOrBlank(status.url)) pillState = 'active';
  const pill = PILL_CONFIG[pillState];

  // Height of the status bar rendered above the BrowserView in the React DOM.
  // The native BrowserView must start below it so the status bar stays visible.
  const STATUS_BAR_H = 33;

  const applyVisibility = useCallback(() => {
    if (!window.electron?.embeddedBrowser) return;
    if (shouldShowRef.current && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 20) return;
      const bounds = {
        x:      Math.round(rect.left),
        y:      Math.round(rect.top) + STATUS_BAR_H,
        width:  Math.round(rect.width),
        height: Math.max(20, Math.round(rect.height) - STATUS_BAR_H),
      };
      window.electron.embeddedBrowser.setBounds(bounds);
    } else {
      window.electron.embeddedBrowser.hide();
    }
  }, []);

  const scheduleApply = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      applyVisibility();
    });
  }, [applyVisibility]);

  useEffect(() => {
    // On error, keep BrowserView visible so user can inspect the embedded page.
    // Main process already holds it open for 30 s; here we keep the overlay showing too.
    const show = !isSentinelOrBlank(status.url) && !hasFallback;
    shouldShowRef.current = show;
    scheduleApply();
  }, [status.url, hasFallback, scheduleApply]);

  // Notify main process when run starts/stops. Pass lastRunStatus so main can
  // keep BrowserView visible on error for 30 s.
  useEffect(() => {
    const isRunning = runState === 'running';
    window.electron?.embeddedBrowser?.notifyRunActive?.(isRunning, lastRunStatus);
    if (!isRunning && !isError) setForceFallback(false);
  }, [runState, lastRunStatus, isError]);

  useEffect(() => {
    if (!window.electron?.embeddedBrowser) return;

    window.electron.embeddedBrowser.getStatus().then(s => {
      setIsReady(s.ready);
      setStatus({ url: s.url ?? 'about:blank', loading: false });
    }).catch(() => {});

    window.electron.embeddedBrowser.onStatus((data) => {
      if (data.fallback) { setForceFallback(true); return; }
      setStatus(prev => ({ ...prev, ...data }));
    });

    const observer = new ResizeObserver(() => {
      if (shouldShowRef.current) scheduleApply();
    });
    if (containerRef.current) observer.observe(containerRef.current);
    window.addEventListener('resize', scheduleApply);

    const onBeforeUnload = () => {
      console.warn('[RENDERER_BEFORE_UNLOAD] renderer is unloading');
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      observer.disconnect();
      window.removeEventListener('resize', scheduleApply);
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.electron?.embeddedBrowser?.removeStatusListener?.();
      window.electron?.embeddedBrowser?.hide?.();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const hasContent = !isSentinelOrBlank(status.url);
  let displayHost = null;
  if (hasContent) {
    try { displayHost = new URL(status.url).hostname; } catch { displayHost = status.url; }
  }

  // Show Diag button for admin/owner-admin, or always when there's an error
  const showDiagButton = isAdmin || isError;

  return (
    <div
      ref={containerRef}
      className="relative rounded-2xl overflow-hidden flex-1"
      style={{
        minHeight: 480,
        height: '100%',
        background: '#0d0d14',
        border: `1px solid ${isError ? 'rgba(248,113,113,0.3)' : '#1e1e2e'}`,
      }}
    >
      {/* Status bar */}
      <div
        className="absolute top-0 left-0 right-0 z-10 flex items-center gap-2 px-3 py-2"
        style={{
          background:     'rgba(10,10,15,0.92)',
          borderBottom:   '1px solid #1e1e2e',
          backdropFilter: 'blur(4px)',
        }}
      >
        <div
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{ background: pill.color }}
        />
        <span className="text-xs truncate flex-1" style={{ color: pill.color }}>
          {status.loading ? PILL_CONFIG.loading.label : displayHost ?? pill.label}
        </span>
        {status.loading && (
          <Loader size={10} className="animate-spin flex-shrink-0" style={{ color: '#6366f1' }} />
        )}
        {showDiagButton && (
          <button
            onClick={() => setShowDiag(d => !d)}
            title="Logs / Diagnostics"
            style={{
              background: isError ? 'rgba(248,113,113,0.1)' : 'none',
              border: `1px solid ${isError ? 'rgba(248,113,113,0.4)' : '#1e2a3a'}`,
              borderRadius: 4,
              color: showDiag ? (isError ? '#f87171' : '#6366f1') : (isError ? '#f87171' : '#475569'),
              cursor: 'pointer',
              fontSize: 9, padding: '1px 5px', flexShrink: 0, lineHeight: '14px',
            }}
          >
            {isError ? 'Error Log' : 'Diag'}
            <ChevronDown size={8} style={{ display: 'inline', marginLeft: 2, transform: showDiag ? 'rotate(180deg)' : 'none' }} />
          </button>
        )}
      </div>

      {/* Diagnostics / run log overlay */}
      {showDiag && (
        <div
          className="absolute left-0 right-0 z-20 overflow-auto"
          style={{ top: 33, bottom: 0, background: '#060610', padding: '6px 8px' }}
        >
          {/* Header row */}
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <button
              onClick={() => setDiagTab('filtered')}
              style={{
                background: diagTab === 'filtered' ? 'rgba(99,102,241,0.15)' : 'none',
                border: '1px solid #1e2a3a', borderRadius: 4,
                color: diagTab === 'filtered' ? '#6366f1' : '#475569',
                cursor: 'pointer', fontSize: 9, padding: '1px 6px',
              }}
            >
              Embedded ({diagLogs.length})
            </button>
            <button
              onClick={() => setDiagTab('all')}
              style={{
                background: diagTab === 'all' ? 'rgba(99,102,241,0.15)' : 'none',
                border: '1px solid #1e2a3a', borderRadius: 4,
                color: diagTab === 'all' ? '#6366f1' : '#475569',
                cursor: 'pointer', fontSize: 9, padding: '1px 6px',
              }}
            >
              All logs ({logs.length})
            </button>
            <button
              onClick={copyDiag}
              style={{
                background: 'none', border: '1px solid #1e2a3a', borderRadius: 4,
                color: copied ? '#4ade80' : '#475569', cursor: 'pointer',
                fontSize: 9, padding: '1px 5px', display: 'flex', alignItems: 'center', gap: 3,
              }}
            >
              <Copy size={8} />
              {copied ? 'Copied' : 'Copy'}
            </button>
            {lastRunLogFile && (
              <span style={{ color: '#334155', fontSize: 9, fontFamily: 'monospace', wordBreak: 'break-all' }}>
                {lastRunLogFile.split('/').slice(-3).join('/')}
              </span>
            )}
          </div>

          {/* Error banner */}
          {isError && (
            <div style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: 4, padding: '4px 8px', marginBottom: 6 }}>
              <span style={{ color: '#f87171', fontSize: 10 }}>
                Run failed — BrowserView kept visible for 30 s
              </span>
            </div>
          )}

          {/* Log lines */}
          {displayedLogs.length === 0 ? (
            <p style={{ color: '#334155', fontSize: 10, fontFamily: 'monospace' }}>
              No log lines yet — start a run to populate.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {displayedLogs.map((l, i) => {
                const isErrLine = l.level === 'error' || l.text?.includes('Fatal error') || l.text?.includes('TypeError');
                return (
                  <div
                    key={i}
                    style={{
                      fontFamily: 'monospace', fontSize: 9,
                      color: isErrLine ? '#f87171' : '#64748b',
                      lineHeight: '14px', wordBreak: 'break-all',
                    }}
                  >
                    {l.text}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Idle / fallback / error placeholder */}
      {!hasContent && !showDiag && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-4"
          style={{ paddingTop: 32 }}
        >
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center"
            style={{
              background: hasFallback ? 'rgba(249,115,22,0.1)' : isError ? 'rgba(248,113,113,0.1)' : 'rgba(99,102,241,0.1)',
              border:     `1px solid ${hasFallback ? 'rgba(249,115,22,0.2)' : isError ? 'rgba(248,113,113,0.2)' : 'rgba(99,102,241,0.2)'}`,
            }}
          >
            <Globe size={20} style={{ color: hasFallback ? '#f97316' : isError ? '#f87171' : '#6366f1' }} />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium" style={{ color: hasFallback ? '#f97316' : isError ? '#f87171' : '#475569' }}>
              {hasFallback ? 'Running in external browser' : isError ? 'Run failed' : 'Automation browser'}
            </p>
            <p className="text-xs mt-1" style={{ color: '#334155' }}>
              {hasFallback
                ? 'Embedded mode unavailable — a separate window was opened'
                : isError
                  ? 'Check the Error Log above for details'
                  : isReady
                    ? 'Statflo will appear here when a run starts'
                    : 'Connecting to automation view…'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
