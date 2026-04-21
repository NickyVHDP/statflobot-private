import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { MessageSquare, Save, RotateCcw, Copy, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { getAccessToken } from '../lib/cloudApi.js';

const DEFAULT_MESSAGES = {
  secondAttemptMessage: '',
  thirdAttemptMessage: '',
};

function FieldLabel({ children }) {
  return (
    <label
      className="block text-xs font-medium mb-1.5"
      style={{ color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em' }}
    >
      {children}
    </label>
  );
}

export default function MessageEditor({ runState }) {
  const [saved, setSaved] = useState(DEFAULT_MESSAGES);
  const [draft, setDraft] = useState(DEFAULT_MESSAGES);
  const [saveStatus, setSaveStatus] = useState(null); // null | 'saving' | 'saved' | 'error'
  const [loadError, setLoadError] = useState(false);

  const isDirty =
    draft.secondAttemptMessage !== saved.secondAttemptMessage ||
    draft.thirdAttemptMessage !== saved.thirdAttemptMessage;

  const secondEmpty = draft.secondAttemptMessage.trim().length === 0;
  const thirdEmpty = draft.thirdAttemptMessage.trim().length === 0;

  // Load this user's messages on mount
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const token = await getAccessToken();
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const r = await fetch('/api/messages', { headers });
        if (!mounted) return;
        if (!r.ok) {
          console.warn('[MessageEditor] GET /api/messages returned', r.status, '— keeping defaults');
          if (mounted) setLoadError(true);
          return;
        }
        const data = await r.json();
        // Guard: only apply if the response has the expected shape
        if (typeof data.secondAttemptMessage !== 'string' || typeof data.thirdAttemptMessage !== 'string') {
          console.warn('[MessageEditor] unexpected response shape:', data);
          if (mounted) setLoadError(true);
          return;
        }
        console.log('[DEBUG_MESSAGES_CONTENT] loaded secondAttempt=' +
          (data.secondAttemptMessage ? 'YES' : 'EMPTY') +
          ' thirdAttempt=' + (data.thirdAttemptMessage ? 'YES' : 'EMPTY'));
        if (mounted) { setSaved(data); setDraft(data); }
      } catch {
        if (mounted) setLoadError(true);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const handleSave = useCallback(async () => {
    if (secondEmpty || thirdEmpty) return;
    setSaveStatus('saving');
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          secondAttemptMessage: draft.secondAttemptMessage,
          thirdAttemptMessage: draft.thirdAttemptMessage,
        }),
      });
      if (!res.ok) throw new Error('Save failed');
      const data = await res.json();
      setSaved({ secondAttemptMessage: data.secondAttemptMessage, thirdAttemptMessage: data.thirdAttemptMessage });
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(null), 2500);
    } catch {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus(null), 3000);
    }
  }, [draft, secondEmpty, thirdEmpty]);

  const handleReset = useCallback(() => {
    setDraft(saved);
  }, [saved]);

  const handleCopy2to3 = useCallback(() => {
    setDraft((prev) => ({ ...prev, thirdAttemptMessage: prev.secondAttemptMessage }));
  }, []);

  return (
    <div
      className="rounded-xl p-5 flex flex-col gap-5"
      style={{ background: '#13131a', border: '1px solid #1e1e2e' }}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <MessageSquare size={15} className="text-indigo-400" />
            <h2 className="text-sm font-semibold" style={{ color: '#f1f5f9' }}>Attempt Messages</h2>
            {isDirty && (
              <span
                className="text-xs px-1.5 py-0.5 rounded font-medium"
                style={{ background: 'rgba(251,191,36,0.12)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.25)' }}
              >
                Unsaved
              </span>
            )}
          </div>
          <p className="text-xs mt-0.5" style={{ color: '#64748b' }}>
            Messages sent for 2nd and 3rd Attempt runs
          </p>
        </div>

        <button
          onClick={handleCopy2to3}
          title="Copy 2nd message to 3rd"
          className="shrink-0 text-xs px-2.5 py-1.5 rounded-lg transition-all duration-150 flex items-center gap-1.5"
          style={{
            background: 'rgba(99,102,241,0.10)',
            border: '1px solid rgba(99,102,241,0.25)',
            color: '#818cf8',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(99,102,241,0.18)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(99,102,241,0.10)'; }}
        >
          <Copy size={11} />
          Copy 2nd → 3rd
        </button>
      </div>

      {loadError && (
        <div
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs"
          style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: '#f87171' }}
        >
          <AlertCircle size={13} />
          Could not load saved messages. Showing defaults.
        </div>
      )}

      {/* 2nd Attempt */}
      <div>
        <FieldLabel>2nd Attempt</FieldLabel>
        <div className="relative">
          <textarea
            value={draft.secondAttemptMessage}
            onChange={(e) => setDraft((prev) => ({ ...prev, secondAttemptMessage: e.target.value }))}
            rows={4}
            className="w-full rounded-lg px-3 py-2.5 text-xs leading-relaxed resize-none transition-colors duration-150 outline-none"
            style={{
              background: '#0a0a0f',
              border: `1px solid ${secondEmpty ? 'rgba(239,68,68,0.5)' : '#1e1e2e'}`,
              color: '#e2e8f0',
              fontFamily: 'inherit',
            }}
            onFocus={(e) => { if (!secondEmpty) e.target.style.borderColor = '#4f46e5'; }}
            onBlur={(e) => { e.target.style.borderColor = secondEmpty ? 'rgba(239,68,68,0.5)' : '#1e1e2e'; }}
            placeholder="Enter the message for 2nd Attempt runs…"
          />
        </div>
        <AnimatePresence>
          {secondEmpty && (
            <motion.p
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mt-1 text-xs flex items-center gap-1"
              style={{ color: '#f87171' }}
            >
              <AlertCircle size={11} />
              Message cannot be empty — runs will be blocked
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      {/* 3rd Attempt */}
      <div>
        <FieldLabel>3rd Attempt</FieldLabel>
        <div className="relative">
          <textarea
            value={draft.thirdAttemptMessage}
            onChange={(e) => setDraft((prev) => ({ ...prev, thirdAttemptMessage: e.target.value }))}
            rows={4}
            className="w-full rounded-lg px-3 py-2.5 text-xs leading-relaxed resize-none transition-colors duration-150 outline-none"
            style={{
              background: '#0a0a0f',
              border: `1px solid ${thirdEmpty ? 'rgba(239,68,68,0.5)' : '#1e1e2e'}`,
              color: '#e2e8f0',
              fontFamily: 'inherit',
            }}
            onFocus={(e) => { if (!thirdEmpty) e.target.style.borderColor = '#4f46e5'; }}
            onBlur={(e) => { e.target.style.borderColor = thirdEmpty ? 'rgba(239,68,68,0.5)' : '#1e1e2e'; }}
            placeholder="Enter the message for 3rd Attempt runs…"
          />
        </div>
        <AnimatePresence>
          {thirdEmpty && (
            <motion.p
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mt-1 text-xs flex items-center gap-1"
              style={{ color: '#f87171' }}
            >
              <AlertCircle size={11} />
              Message cannot be empty — runs will be blocked
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      {/* Action row */}
      <div className="flex items-center gap-3 pt-1">
        <motion.button
          whileHover={!secondEmpty && !thirdEmpty ? { scale: 1.02 } : {}}
          whileTap={!secondEmpty && !thirdEmpty ? { scale: 0.98 } : {}}
          onClick={handleSave}
          disabled={saveStatus === 'saving' || secondEmpty || thirdEmpty}
          className="flex items-center justify-center gap-1.5 py-2 px-4 rounded-lg text-xs font-semibold transition-all duration-150"
          style={{
            background: secondEmpty || thirdEmpty
              ? 'rgba(99,102,241,0.2)'
              : 'linear-gradient(135deg, #4f46e5, #6366f1)',
            color: secondEmpty || thirdEmpty ? '#6366f180' : 'white',
            cursor: secondEmpty || thirdEmpty ? 'not-allowed' : 'pointer',
          }}
        >
          {saveStatus === 'saving' ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Save size={13} />
          )}
          {saveStatus === 'saving' ? 'Saving…' : 'Save Changes'}
        </motion.button>

        <button
          onClick={handleReset}
          className="flex items-center gap-1.5 py-2 px-3 rounded-lg text-xs font-medium transition-all duration-150"
          style={{ color: '#64748b' }}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#94a3b8'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = '#64748b'; }}
        >
          <RotateCcw size={12} />
          Reset to Default
        </button>

        <AnimatePresence>
          {saveStatus === 'saved' && (
            <motion.span
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0 }}
              className="ml-auto flex items-center gap-1.5 text-xs"
              style={{ color: '#34d399' }}
            >
              <CheckCircle2 size={13} />
              Saved
            </motion.span>
          )}
          {saveStatus === 'error' && (
            <motion.span
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0 }}
              className="ml-auto flex items-center gap-1.5 text-xs"
              style={{ color: '#f87171' }}
            >
              <AlertCircle size={13} />
              Save failed
            </motion.span>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
