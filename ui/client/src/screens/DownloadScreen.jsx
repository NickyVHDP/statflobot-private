import { useState } from 'react';
import { Monitor, Apple, Download, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { fetchDownloadUrl } from '../lib/cloudApi.js';

function DownloadButton({ platform, icon: Icon, label, sub }) {
  const [status, setStatus] = useState('idle'); // idle | loading | done | error
  const [errorMsg, setErrorMsg] = useState('');

  const handleClick = async () => {
    if (status === 'loading') return;
    setStatus('loading');
    setErrorMsg('');
    try {
      const url = await fetchDownloadUrl(platform);
      const a = document.createElement('a');
      a.href = url;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setStatus('done');
      setTimeout(() => setStatus('idle'), 3500);
    } catch (err) {
      setErrorMsg(err.message ?? 'Download failed');
      setStatus('error');
      setTimeout(() => setStatus('idle'), 4000);
    }
  };

  const isLoading = status === 'loading';
  const isDone    = status === 'done';
  const isError   = status === 'error';

  return (
    <button
      onClick={handleClick}
      disabled={isLoading}
      className="w-full flex items-center gap-4 px-6 py-5 rounded-2xl transition-all duration-150 text-left"
      style={{
        background:  isError ? 'rgba(239,68,68,0.08)' : isDone ? 'rgba(34,197,94,0.08)' : 'rgba(99,102,241,0.08)',
        border:      `1px solid ${isError ? 'rgba(239,68,68,0.3)' : isDone ? 'rgba(34,197,94,0.3)' : 'rgba(99,102,241,0.2)'}`,
        cursor:      isLoading ? 'wait' : 'pointer',
        opacity:     isLoading ? 0.8 : 1,
      }}
      onMouseEnter={(e) => {
        if (!isLoading && !isDone && !isError) {
          e.currentTarget.style.background   = 'rgba(99,102,241,0.14)';
          e.currentTarget.style.borderColor  = 'rgba(99,102,241,0.4)';
        }
      }}
      onMouseLeave={(e) => {
        if (!isLoading && !isDone && !isError) {
          e.currentTarget.style.background   = 'rgba(99,102,241,0.08)';
          e.currentTarget.style.borderColor  = 'rgba(99,102,241,0.2)';
        }
      }}
    >
      {/* Icon */}
      <div
        className="flex-shrink-0 w-12 h-12 rounded-xl flex items-center justify-center"
        style={{ background: isError ? 'rgba(239,68,68,0.12)' : isDone ? 'rgba(34,197,94,0.12)' : 'rgba(99,102,241,0.12)' }}
      >
        {isLoading ? (
          <Loader2 size={22} className="animate-spin" style={{ color: '#818cf8' }} />
        ) : isDone ? (
          <CheckCircle2 size={22} style={{ color: '#22c55e' }} />
        ) : isError ? (
          <AlertCircle size={22} style={{ color: '#ef4444' }} />
        ) : (
          <Icon size={22} style={{ color: '#818cf8' }} />
        )}
      </div>

      {/* Label */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold" style={{ color: isError ? '#f87171' : isDone ? '#4ade80' : '#e2e8f0' }}>
          {isLoading ? 'Preparing download…' : isDone ? 'Download starting…' : isError ? 'Download failed' : label}
        </p>
        <p className="text-xs mt-0.5" style={{ color: isError ? '#f87171' : '#475569' }}>
          {isError ? errorMsg : isDone ? 'Check your Downloads folder' : sub}
        </p>
      </div>

      {!isLoading && !isDone && !isError && (
        <Download size={16} style={{ color: '#475569', flexShrink: 0 }} />
      )}
    </button>
  );
}

export default function DownloadScreen() {
  return (
    <main className="flex-1 flex items-start justify-center px-4 py-12">
      <div className="w-full max-w-lg">
        {/* Header */}
        <div className="text-center mb-10">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{ background: 'linear-gradient(135deg, #4f46e5, #6366f1)', boxShadow: '0 0 40px rgba(99,102,241,0.3)' }}
          >
            <Download size={28} className="text-white" />
          </div>
          <h1 className="text-xl font-bold mb-2" style={{ color: '#f1f5f9' }}>
            Download StatfloBot
          </h1>
          <p className="text-sm" style={{ color: '#64748b' }}>
            Desktop app for Mac and Windows. An active subscription is required.
          </p>
        </div>

        {/* Mac section */}
        <p className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: '#334155' }}>
          Mac
        </p>
        <div className="flex flex-col gap-3 mb-6">
          <DownloadButton
            platform="mac-apple-silicon"
            icon={Apple}
            label="Download for Mac — Apple Silicon"
            sub="M1 / M2 / M3 / M4 · macOS 12 or later · .dmg"
          />
          <DownloadButton
            platform="mac-intel"
            icon={Apple}
            label="Download for Mac — Intel"
            sub="Older Intel Macs · macOS 12 or later · .dmg"
          />
        </div>

        {/* Windows section */}
        <p className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: '#334155' }}>
          Windows
        </p>
        <div className="flex flex-col gap-3">
          <DownloadButton
            platform="windows"
            icon={Monitor}
            label="Download for Windows"
            sub="Windows 10 or later · .exe installer"
          />
        </div>

        <p className="text-center text-xs mt-8" style={{ color: '#1e293b' }}>
          Not sure which Mac? Apple menu → About This Mac → check for Apple M1/M2/M3/M4 or Intel.
        </p>
      </div>
    </main>
  );
}
