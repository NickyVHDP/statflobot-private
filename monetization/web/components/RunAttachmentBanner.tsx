'use client';

import { useEffect, useState } from 'react';
import { Paperclip, Copy, Check, X } from 'lucide-react';

interface StoredRun {
  id:       string;
  summary:  string;
  subject:  string;
  listName: string | null;
  mode:     string | null;
  status:   string;
}

export default function RunAttachmentBanner() {
  const [run,    setRun]    = useState<StoredRun | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('statflobot_run_log');
      if (raw) setRun(JSON.parse(raw));
    } catch {
      // ignore malformed data
    }
  }, []);

  if (!run) return null;

  async function handleCopy() {
    await navigator.clipboard.writeText(run!.summary);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleDismiss() {
    sessionStorage.removeItem('statflobot_run_log');
    setRun(null);
  }

  return (
    <div
      className="rounded-2xl border p-4 mb-5"
      style={{ background: 'rgba(124,58,237,0.08)', borderColor: 'rgba(124,58,237,0.3)' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 flex-1 min-w-0">
          <Paperclip size={15} style={{ color: '#a78bfa' }} className="shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white">Run log attached</p>
            <p className="text-xs text-slate-400 mt-0.5 truncate">
              {run.listName ?? 'Unknown list'}
              {run.mode ? ` · ${run.mode}` : ''}
              {' · '}
              {run.status}
            </p>
          </div>
        </div>
        <button
          onClick={handleDismiss}
          className="text-slate-500 hover:text-slate-300 transition-colors shrink-0"
          title="Dismiss"
        >
          <X size={14} />
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors"
          style={{
            background:  'rgba(124,58,237,0.12)',
            borderColor: 'rgba(124,58,237,0.35)',
            color:       '#c4b5fd',
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied!' : 'Copy attached log'}
        </button>
        <p className="text-xs text-slate-500">
          Paste the log into the form below so we can investigate.
        </p>
      </div>
    </div>
  );
}
