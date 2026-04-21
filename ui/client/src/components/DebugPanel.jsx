import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Trash2, AlertTriangle } from 'lucide-react';
import { getAccessToken } from '../lib/cloudApi.js';

function Row({ label, value, mono = false, warn = false }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5" style={{ borderBottom: '1px solid #1a1a27' }}>
      <span className="text-xs shrink-0" style={{ color: '#64748b' }}>{label}</span>
      <span
        className={`text-xs text-right break-all ${mono ? 'font-mono' : ''}`}
        style={{ color: warn ? '#f87171' : '#e2e8f0' }}
      >
        {value ?? <span style={{ color: '#475569' }}>—</span>}
      </span>
    </div>
  );
}

export default function DebugPanel() {
  const [info,        setInfo]        = useState(null);
  const [loading,     setLoading]     = useState(false);
  const [resetStatus, setResetStatus] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/debug', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await res.json();
      setInfo(data);
    } catch (e) {
      setInfo({ error: e.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleReset = useCallback(async () => {
    if (!window.confirm('Clear local message cache? This will reload messages from the cloud on next open.')) return;
    setResetStatus('clearing');
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/reset-local', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await res.json();
      setResetStatus(data.ok ? 'cleared' : 'error');
      setTimeout(() => setResetStatus(null), 3000);
      await load();
    } catch {
      setResetStatus('error');
      setTimeout(() => setResetStatus(null), 3000);
    }
  }, [load]);

  return (
    <div className="rounded-xl p-5 space-y-4" style={{ background: '#13131a', border: '1px solid rgba(251,191,36,0.15)' }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AlertTriangle size={14} style={{ color: '#fbbf24' }} />
          <span className="text-xs font-semibold" style={{ color: '#fbbf24' }}>Debug Panel</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg disabled:opacity-50"
            style={{ background: '#1e1e2e', color: '#94a3b8', border: '1px solid #2a2a3e' }}
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button
            onClick={handleReset}
            disabled={resetStatus === 'clearing'}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg disabled:opacity-50"
            style={{ background: 'rgba(239,68,68,0.08)', color: '#f87171', border: '1px solid rgba(239,68,68,0.2)' }}
          >
            <Trash2 size={11} />
            {resetStatus === 'clearing' ? 'Clearing…' : resetStatus === 'cleared' ? 'Cleared ✓' : 'Reset Local Data'}
          </button>
        </div>
      </div>

      {info?.error && (
        <p className="text-xs" style={{ color: '#f87171' }}>Error: {info.error}</p>
      )}

      {info && !info.error && (
        <>
          <section>
            <p className="text-xs font-semibold mb-2" style={{ color: '#475569', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Environment</p>
            <Row label="Platform"       value={info.env?.platform} />
            <Row label="Hostname"       value={info.env?.hostname} mono />
            <Row label="USER_DATA_DIR"  value={info.env?.USER_DATA_DIR} mono warn={!info.env?.USER_DATA_DIR} />
            <Row label="CLOUD_API_URL"  value={info.env?.CLOUD_API_URL} mono warn={!info.env?.CLOUD_API_URL} />
            <Row label="IS_PRODUCTION"  value={String(info.env?.IS_PRODUCTION)} />
            <Row label="Server port"    value={info.env?.serverPort} />
            <Row label="User ID"        value={info.userId} mono warn={!info.userId} />
            <Row label="Device FP"      value={info.deviceFingerprint} mono />
          </section>

          <section>
            <p className="text-xs font-semibold mb-2" style={{ color: '#475569', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Messages</p>
            <Row label="Source"         value={info.messagesSource} warn={info.messagesSource === 'empty-default'} />
            <Row label="File path"      value={info.messagesFile} mono />
            <Row label="2nd Attempt"    value={info.messages?.secondAttemptMessage ? `"${info.messages.secondAttemptMessage.slice(0, 40)}…"` : '(empty)'} warn={!info.messages?.secondAttemptMessage} />
            <Row label="3rd Attempt"    value={info.messages?.thirdAttemptMessage  ? `"${info.messages.thirdAttemptMessage.slice(0, 40)}…"`  : '(empty)'} warn={!info.messages?.thirdAttemptMessage} />
          </section>

          <section>
            <p className="text-xs font-semibold mb-2" style={{ color: '#475569', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Run State</p>
            <Row label="Run state" value={info.runState} />
          </section>
        </>
      )}
    </div>
  );
}
