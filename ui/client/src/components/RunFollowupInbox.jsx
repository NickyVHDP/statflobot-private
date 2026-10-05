import { useEffect, useMemo, useState } from 'react';
import { Loader2, MessageCircle, Send } from 'lucide-react';
import { fetchRunFollowups, replyToRunFollowup } from '../lib/cloudApi.js';

export default function RunFollowupInbox() {
  const [messages, setMessages] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [sending, setSending] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchRunFollowups()
      .then(data => setMessages(data.messages || []))
      .catch(() => setError('Private run messages are temporarily unavailable.'))
      .finally(() => setLoading(false));
  }, []);

  const threads = useMemo(() => {
    const grouped = new Map();
    for (const message of messages) {
      if (!message.bot_run_id) continue;
      if (!grouped.has(message.bot_run_id)) grouped.set(message.bot_run_id, []);
      grouped.get(message.bot_run_id).push(message);
    }
    return [...grouped.entries()].reverse();
  }, [messages]);

  async function reply(runId) {
    const body = String(drafts[runId] || '').trim();
    if (!body || sending) return;
    setSending(runId);
    setError(null);
    try {
      const result = await replyToRunFollowup(runId, body);
      setMessages(current => [...current, result.message]);
      setDrafts(current => ({ ...current, [runId]: '' }));
    } catch (err) {
      setError(err.message || 'Reply could not be sent.');
    } finally {
      setSending(null);
    }
  }

  if (!loading && threads.length === 0 && !error) return null;

  return (
    <div className="md:col-span-2 rounded-2xl p-6 border" style={{ background: '#13131f', borderColor: 'rgba(167,139,250,0.25)' }}>
      <div className="flex items-center gap-2 mb-4">
        <MessageCircle size={16} style={{ color: '#a78bfa' }} />
        <h2 className="text-sm font-semibold text-white">Run follow-ups from StatfloBot support</h2>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 text-sm" style={{ color: '#64748b' }}><Loader2 size={14} className="animate-spin" /> Checking for messages…</div>
      ) : threads.map(([runId, thread]) => (
        <div key={runId} className="rounded-xl p-4 mb-3 last:mb-0" style={{ background: '#0b0b11', border: '1px solid #232334' }}>
          <div className="text-[10px] mb-3" style={{ color: '#475569' }}>Run {runId.slice(0, 8)} · private conversation</div>
          <div className="space-y-2 mb-3 max-h-44 overflow-y-auto">
            {thread.map(message => (
              <div key={message.id} className="rounded-lg px-3 py-2 text-xs" style={{ background: message.sender_role === 'owner' ? 'rgba(124,58,237,0.14)' : '#171720', color: '#dbeafe' }}>
                <div className="text-[10px] mb-1" style={{ color: '#64748b' }}>{message.sender_role === 'owner' ? 'StatfloBot support' : 'You'} · {new Date(message.created_at).toLocaleString()}</div>
                <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{message.body}</div>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <textarea value={drafts[runId] || ''} onChange={event => setDrafts(current => ({ ...current, [runId]: event.target.value.slice(0, 2000) }))} rows={2} placeholder="Reply with what happened during the run…" className="flex-1 rounded-lg px-3 py-2 text-xs outline-none resize-y" style={{ color: '#e2e8f0', background: '#09090d', border: '1px solid #2a2a3b' }} />
            <button onClick={() => reply(runId)} disabled={!String(drafts[runId] || '').trim() || sending === runId} className="self-end flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs disabled:opacity-40" style={{ color: '#ede9fe', background: '#6d28d9' }}>
              {sending === runId ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Reply
            </button>
          </div>
        </div>
      ))}
      {error && <div className="text-xs mt-2" style={{ color: '#fca5a5' }}>{error}</div>}
    </div>
  );
}
