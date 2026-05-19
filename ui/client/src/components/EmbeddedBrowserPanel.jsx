import { useEffect, useRef, useState, useCallback } from 'react';
import { Globe, Loader } from 'lucide-react';

export default function EmbeddedBrowserPanel({ runState }) {
  const containerRef = useRef(null);
  const [status, setStatus] = useState({ url: 'about:blank', loading: false });
  const [isReady, setIsReady] = useState(false);

  const reportBounds = useCallback(() => {
    if (!containerRef.current || !window.electron?.embeddedBrowser) return;
    const rect = containerRef.current.getBoundingClientRect();
    window.electron.embeddedBrowser.setBounds({
      x:      Math.round(rect.left),
      y:      Math.round(rect.top),
      width:  Math.round(rect.width),
      height: Math.round(rect.height),
    });
  }, []);

  // Show or hide the BrowserView based on whether there is real content
  const syncVisibility = useCallback((url) => {
    if (!window.electron?.embeddedBrowser) return;
    const hasContent = url && url !== 'about:blank' && url !== '';
    if (hasContent) {
      reportBounds();
    } else {
      window.electron.embeddedBrowser.hide();
    }
  }, [reportBounds]);

  useEffect(() => {
    if (!window.electron?.embeddedBrowser) return;

    window.electron.embeddedBrowser.getStatus().then(s => {
      setIsReady(s.ready);
      setStatus({ url: s.url ?? 'about:blank', loading: false });
      syncVisibility(s.url);
    }).catch(() => {});

    window.electron.embeddedBrowser.onStatus((data) => {
      setStatus(prev => {
        const next = { ...prev, ...data };
        syncVisibility(next.url);
        return next;
      });
    });

    const observer = new ResizeObserver(() => {
      if (status.url && status.url !== 'about:blank') reportBounds();
    });
    if (containerRef.current) observer.observe(containerRef.current);
    window.addEventListener('resize', reportBounds);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', reportBounds);
      window.electron?.embeddedBrowser?.removeStatusListener?.();
      window.electron?.embeddedBrowser?.hide?.();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const isActive  = runState === 'running';
  const hasContent = status.url && status.url !== 'about:blank' && status.url !== '';

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
          background:   'rgba(10,10,15,0.92)',
          borderBottom: '1px solid #1e1e2e',
          backdropFilter: 'blur(4px)',
        }}
      >
        <div
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{ background: isActive ? '#4ade80' : '#334155' }}
        />
        <span className="text-xs truncate flex-1" style={{ color: '#475569' }}>
          {status.loading ? 'Loading…' : displayHost ?? 'Automation browser'}
        </span>
        {status.loading && (
          <Loader size={10} className="animate-spin flex-shrink-0" style={{ color: '#6366f1' }} />
        )}
      </div>

      {/* Idle placeholder — hidden by the BrowserView when content is loaded */}
      {!hasContent && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4" style={{ paddingTop: 32 }}>
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center"
            style={{ background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)' }}
          >
            <Globe size={20} style={{ color: '#6366f1' }} />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium" style={{ color: '#475569' }}>Automation browser</p>
            <p className="text-xs mt-1" style={{ color: '#334155' }}>
              {isReady ? 'Statflo will appear here when a run starts' : 'Connecting to automation view…'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
