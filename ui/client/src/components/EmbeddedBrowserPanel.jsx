import { useEffect, useRef, useState, useCallback } from 'react';
import { Globe, Loader } from 'lucide-react';

// ── Debug mode ──────────────────────────────────────────────────────────────
// Set to true to show: (a) red outline on the panel container, (b) a fixed
// info box in the bottom-left corner showing last-sent BrowserView bounds,
// (c) console.warn + IPC logs for every setBounds call.
const DEBUG = true;

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
  const [status, setStatus]         = useState({ url: 'about:blank', loading: false });
  const [isReady, setIsReady]       = useState(false);
  const [debugBounds, setDebugBounds] = useState(null);

  const hasFallback = logs.some(l => l.text?.includes('[EMBEDDED_BROWSER_FALLBACK_USED]'));
  const hasMatchFailed = logs.some(l =>
    l.text?.includes('[EMBEDDED_TARGET_MATCH_FAILED]') &&
    l.text?.includes('Playwright pages')
  );

  let pillState = 'idle';
  if (hasFallback || hasMatchFailed) pillState = 'fallback';
  else if (status.loading)           pillState = 'loading';
  else if (!isSentinelOrBlank(status.url)) pillState = 'active';
  const pill = PILL_CONFIG[pillState];

  const applyVisibility = useCallback(() => {
    if (!window.electron?.embeddedBrowser) return;
    if (shouldShowRef.current && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();

      // ── Diagnostic payload sent to main-process boot log ──────────────────
      const diagData = {
        // Raw rect from the panel container
        rectLeft:   Math.round(rect.left),
        rectTop:    Math.round(rect.top),
        rectRight:  Math.round(rect.right),
        rectBottom: Math.round(rect.bottom),
        rectWidth:  Math.round(rect.width),
        rectHeight: Math.round(rect.height),
        // Viewport dimensions at call time
        innerWidth:  window.innerWidth,
        innerHeight: window.innerHeight,
        // DPI scale — if this is 2 on Retina, coordinate spaces may differ
        devicePixelRatio: window.devicePixelRatio,
        // Scroll offset (should be 0 for an Electron app)
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
      };
      // console.warn lands in boot log (level 2); console.log does not
      console.warn(`[DIAG:RENDERER_RECT] ${JSON.stringify(diagData)}`);
      window.electron.embeddedBrowser.sendDebug?.(diagData);

      if (rect.width < 20 || rect.height < 20) {
        console.warn(`[DIAG:BOUNDS_SKIP] panel too small: w=${rect.width} h=${rect.height}`);
        return;
      }

      const bounds = {
        x:      Math.round(rect.left),
        y:      Math.round(rect.top),
        width:  Math.round(rect.width),
        height: Math.round(rect.height),
      };
      if (DEBUG) setDebugBounds(bounds);
      console.warn(`[DIAG:BOUNDS_SET] ${JSON.stringify(bounds)}`);
      window.electron.embeddedBrowser.setBounds(bounds);
    } else {
      if (DEBUG) setDebugBounds(null);
      window.electron.embeddedBrowser.hide();
    }
  }, [setDebugBounds]);

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
    if (!window.electron?.embeddedBrowser) return;

    window.electron.embeddedBrowser.getStatus().then(s => {
      setIsReady(s.ready);
      const url = s.url ?? 'about:blank';
      setStatus({ url, loading: false });
    }).catch(() => {});

    window.electron.embeddedBrowser.onStatus((data) => {
      setStatus(prev => ({ ...prev, ...data }));
    });

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
    <>
      {/* ── DEBUG: fixed info box bottom-left (visible even under BrowserView
           if BrowserView is panel-only; covered if BrowserView is full-screen) */}
      {DEBUG && debugBounds && (
        <div
          style={{
            position:    'fixed',
            bottom:      8,
            left:        8,
            background:  'rgba(0,0,0,0.85)',
            color:       '#f00',
            fontSize:    10,
            padding:     '6px 10px',
            borderRadius: 4,
            zIndex:      9999,
            pointerEvents: 'none',
            fontFamily:  'monospace',
            lineHeight:  1.6,
            border:      '1px solid #f00',
          }}
        >
          <div style={{ color: '#fbbf24', marginBottom: 2 }}>BV INTENDED BOUNDS</div>
          <div>x={debugBounds.x}  y={debugBounds.y}</div>
          <div>w={debugBounds.width}  h={debugBounds.height}</div>
          <div style={{ color: '#94a3b8', marginTop: 2 }}>
            vp={window.innerWidth}×{window.innerHeight}
            &nbsp;dpr={window.devicePixelRatio}
          </div>
        </div>
      )}

      {/* ── Panel container ───────────────────────────────────────────── */}
      <div
        ref={containerRef}
        className="relative rounded-2xl overflow-hidden flex-1"
        style={{
          minHeight: 400,
          background: '#0d0d14',
          // DEBUG: bright outline so we can see exactly where React measures the panel
          outline: DEBUG ? '3px solid red' : 'none',
          outlineOffset: -1,
          border: '1px solid #1e1e2e',
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
        </div>

        {/* Idle placeholder */}
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
    </>
  );
}
