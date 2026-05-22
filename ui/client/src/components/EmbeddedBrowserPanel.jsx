import { useEffect, useRef, useState, useCallback } from 'react';
import { Globe, Loader } from 'lucide-react';

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
  lastRunStatus = null,
}) {
  const containerRef  = useRef(null);
  const shouldShowRef = useRef(false);
  const rafRef        = useRef(null);
  const [status, setStatus]               = useState({ url: 'about:blank', loading: false });
  const [isReady, setIsReady]             = useState(false);
  const [forceFallback, setForceFallback] = useState(false);

  const isError    = lastRunStatus === 'error';
  const isElectron = !!window.electron?.isElectron;

  const hasFallback = forceFallback;

  let pillState = 'idle';
  if (hasFallback) pillState = 'fallback';
  else if (status.loading) pillState = 'loading';
  else if (!isSentinelOrBlank(status.url)) pillState = 'active';
  const pill = PILL_CONFIG[pillState];

  // Height of the status bar rendered above the BrowserView in the React DOM.
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
    const show = !isSentinelOrBlank(status.url) && !hasFallback;
    shouldShowRef.current = show;
    scheduleApply();
  }, [status.url, hasFallback, scheduleApply]);

  useEffect(() => {
    const isRunning = runState === 'running';
    window.electron?.embeddedBrowser?.notifyRunActive?.(isRunning, lastRunStatus);
    if (!isRunning && !isError) setForceFallback(false);
    if (isRunning && shouldShowRef.current) scheduleApply();
  }, [runState, lastRunStatus, isError, scheduleApply]);

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

    window.electron?.embeddedBrowser?.onBoundsRefresh?.(() => {
      console.info('[EMBEDDED_BOUNDS_REFRESH_REQUESTED] reapplying bounds from main-process trigger');
      scheduleApply();
    });

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && shouldShowRef.current) scheduleApply();
    };
    const onWindowFocus = () => {
      if (shouldShowRef.current) scheduleApply();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onWindowFocus);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      observer.disconnect();
      window.removeEventListener('resize', scheduleApply);
      window.removeEventListener('focus', onWindowFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.electron?.embeddedBrowser?.removeBoundsRefreshListener?.();
      window.electron?.embeddedBrowser?.removeStatusListener?.();
      window.electron?.embeddedBrowser?.hide?.();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const hasContent = !isSentinelOrBlank(status.url);
  let displayHost = null;
  if (hasContent) {
    try { displayHost = new URL(status.url).hostname; } catch { displayHost = status.url; }
  }

  return (
    <div
      ref={containerRef}
      className={`relative overflow-hidden flex-1${isElectron ? '' : ' rounded-2xl'}`}
      style={{
        minHeight: 0,
        height: '100%',
        background: '#0d0d14',
        border: isElectron ? 'none' : `1px solid ${isError ? 'rgba(248,113,113,0.3)' : '#1e1e2e'}`,
        borderTop: isElectron && isError ? '1px solid rgba(248,113,113,0.25)' : undefined,
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
        <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: pill.color }} />
        <span className="text-xs truncate flex-1" style={{ color: pill.color }}>
          {status.loading ? PILL_CONFIG.loading.label : displayHost ?? pill.label}
        </span>
        {status.loading && (
          <Loader size={10} className="animate-spin flex-shrink-0" style={{ color: '#6366f1' }} />
        )}
      </div>

      {/* Idle / fallback / error placeholder */}
      {!hasContent && (
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
                  ? 'Check the Account tab for detailed logs'
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
