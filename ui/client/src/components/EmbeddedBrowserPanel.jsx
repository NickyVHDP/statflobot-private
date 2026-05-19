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

export default function EmbeddedBrowserPanel({ runState, logs = [] }) {
  const containerRef  = useRef(null);
  const shouldShowRef = useRef(false);
  const rafRef        = useRef(null);
  const [status, setStatus]   = useState({ url: 'about:blank', loading: false });
  const [isReady, setIsReady] = useState(false);

  const hasFallback = logs.some(l => l.text?.includes('[EMBEDDED_BROWSER_FALLBACK_USED]'));
  const hasMatchFailed = logs.some(l =>
    l.text?.includes('[EMBEDDED_TARGET_MATCH_FAILED]') &&
    l.text?.includes('Playwright pages')
  );

  let pillState = 'idle';
  if (hasFallback || hasMatchFailed) {
    pillState = 'fallback';
  } else if (status.loading) {
    pillState = 'loading';
  } else if (!isSentinelOrBlank(status.url)) {
    pillState = 'active';
  }

  const pill = PILL_CONFIG[pillState];

  // applyVisibility reads the panel's current DOM rect and either sets the
  // BrowserView bounds to match exactly, or hides it.  Must only be called
  // after layout (via requestAnimationFrame / useEffect — never from a React
  // state updater or render).
  const applyVisibility = useCallback(() => {
    if (!window.electron?.embeddedBrowser) return;
    if (shouldShowRef.current && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      // Sanity check: skip if layout hasn't settled
      if (rect.width < 20 || rect.height < 20) return;
      const bounds = {
        x:      Math.round(rect.left),
        y:      Math.round(rect.top),
        width:  Math.round(rect.width),
        height: Math.round(rect.height),
      };
      console.log(`[EMBEDDED_BOUNDS_SET] x=${bounds.x} y=${bounds.y} w=${bounds.width} h=${bounds.height}`);
      window.electron.embeddedBrowser.setBounds(bounds);
    } else {
      window.electron.embeddedBrowser.hide();
    }
  }, []);

  // Defer the actual bounds read until after the next paint so the DOM
  // has fully reflected the latest layout change.
  const scheduleApply = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      applyVisibility();
    });
  }, [applyVisibility]);

  // React to URL and fallback changes — this is the single source of truth for
  // whether the BrowserView should be visible.  Using a useEffect (not a state
  // updater) guarantees the DOM has committed before we read getBoundingClientRect.
  useEffect(() => {
    const show = !isSentinelOrBlank(status.url) && !hasFallback;
    shouldShowRef.current = show;
    scheduleApply();
  }, [status.url, hasFallback, scheduleApply]);

  // Mount: subscribe to status events, attach ResizeObserver and resize listener.
  useEffect(() => {
    if (!window.electron?.embeddedBrowser) return;

    // Initial state from main process
    window.electron.embeddedBrowser.getStatus().then(s => {
      setIsReady(s.ready);
      const url = s.url ?? 'about:blank';
      setStatus({ url, loading: false });
      // shouldShowRef + applyVisibility run via the [status.url] effect above
    }).catch(() => {});

    // Live navigation / loading events from main process
    window.electron.embeddedBrowser.onStatus((data) => {
      // Only update state — never call DOM APIs from inside a state updater.
      // The [status.url] effect above will call scheduleApply after React commits.
      setStatus(prev => ({ ...prev, ...data }));
    });

    // Reapply bounds when the panel container resizes (e.g. window resize)
    const observer = new ResizeObserver(() => {
      if (shouldShowRef.current) scheduleApply();
    });
    if (containerRef.current) observer.observe(containerRef.current);
    window.addEventListener('resize', scheduleApply);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      observer.disconnect();
      window.removeEventListener('resize', scheduleApply);
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
      className="relative rounded-2xl overflow-hidden flex-1"
      style={{ minHeight: 400, background: '#0d0d14', border: '1px solid #1e1e2e' }}
    >
      {/* Status bar — always visible, sits above the BrowserView */}
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
      </div>

      {/* Idle placeholder — visible when no real content is loaded */}
      {!hasContent && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-4"
          style={{ paddingTop: 32 }}
        >
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center"
            style={{
              background: hasFallback ? 'rgba(249,115,22,0.1)' : 'rgba(99,102,241,0.1)',
              border:     `1px solid ${hasFallback ? 'rgba(249,115,22,0.2)' : 'rgba(99,102,241,0.2)'}`,
            }}
          >
            <Globe size={20} style={{ color: hasFallback ? '#f97316' : '#6366f1' }} />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium" style={{ color: hasFallback ? '#f97316' : '#475569' }}>
              {hasFallback ? 'Running in external browser' : 'Automation browser'}
            </p>
            <p className="text-xs mt-1" style={{ color: '#334155' }}>
              {hasFallback
                ? 'Embedded mode unavailable — a separate window was opened'
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
