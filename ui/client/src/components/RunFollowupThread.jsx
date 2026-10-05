import { useEffect, useMemo, useState } from 'react';
import { Loader2, MessageCircle, Send } from 'lucide-react';
import {
  fetchAdminRunFollowup,
  fetchRunFollowups,
  replyToRunFollowup,
  sendAdminRunFollowup,
} from '../lib/cloudApi.js';

function dateLabel(value) {
  return value ? new Date(value).toLocaleString() : 'this run';
}

function suggestedMessage(run) {
  const name = run.lockedUsername || run.actorName || 'there';
  return `Hi ${name} — I’m following up on your ${dateLabel(run.created_at)} StatfloBot run, which recorded ${run.sent_count || 0} sent and ${run.skipped_count || 0} skipped. Do you remember what you saw during the run? If you’re not sure, please install the latest update and try one more run. If it happens again, reply here and I’ll review the new run so I can fix it correctly for you.`;
}

export default function RunFollowupThread({ run, owner = false }) {
  const [messages, setMessages] = useState([]);
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const hasThread = messages.length > 0;
  const draft = useMemo(() => owner && run ? suggestedMessage(run) : '', [owner, run]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setBody('');
    const request = owner ? fetchAdminRunFollowup(run.id) : fetchRunFollowups();
    request.then(data => {
      if (cancelled) return;
      const next = owner
        ? (data.messages || [])
        : (data.messages || []).filter(message => message.bot_run_id === run.id);
      setMessages(next);
    }).catch(() => {
      if (!cancelled) setError('The private conversation is temporarily unavailable.');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [owner, run.id]);

  async function send() {
    const trimmed = body.trim();
    if (!trimmed || sending) return;
    if (owner && !window.confirm(`Send this private question to ${run.lockedUsername || run.actorEmail || 'this user'}?`)) return;
    setSending(true);
    setError(null);
    try {
      const result = owner
        ? await sendAdminRunFollowup(run.id, trimmed)
        : await replyToRunFollowup(run.id, trimmed);
      setMessages(current => [...current, result.message]);
      setBody('');
    } catch (err) {
      setError(err.message || 'The message could not be sent.');
    } finally {
      setSending(false);
    }
  }

  if (!owner && !loading && !hasThread) return null;

  return (
    <div className="rounded-lg p-3" style={{ background: 'rgba(99,102,241,0.07)', border: '1px solid rgba(99,102,241,0.20)' }}>
      <div className="flex items-center gap-2 mb-2">
        <MessageCircle size={13} style={{ color: '#a78bfa' }} />
        <span className="text-[11px] font-semibold" style={{ color: '#c4b5fd' }}>
          {owner ? 'Private run follow-up' : 'Message from StatfloBot support'}
        </span>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 text-xs" style={{ color: '#64748b' }}><Loader2 size={12} className="animate-spin" /> Loading conversation…</div>
      ) : (
        <>
          {messages.length > 0 && (
            <div className="space-y-2 mb-3 max-h-48 overflow-y-auto">
              {messages.map(message => {
                const mine = owner ? message.sender_role === 'owner' : message.sender_role === 'customer';
                return (
                  <div key={message.id} className="rounded-lg px-3 py-2 text-xs" style={{ marginLeft: mine ? 20 : 0, marginRight: mine ? 0 : 20, background: mine ? 'rgba(124,58,237,0.16)' : '#15151f', color: '#dbeafe' }}>
                    <div className="text-[10px] mb-1" style={{ color: '#64748b' }}>{message.sender_role === 'owner' ? 'StatfloBot support' : 'Customer'} · {dateLabel(message.created_at)}</div>
                    <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{message.body}</div>
                  </div>
                );
              })}
            </div>
          )}
          {owner && !hasThread && (
            <button type="button" onClick={() => setBody(draft)} className="text-[11px] mb-2" style={{ color: '#a78bfa' }}>Use suggested question for this run</button>
          )}
          <textarea
            value={body}
            onChange={event => setBody(event.target.value.slice(0, 2000))}
            placeholder={owner ? 'Write a private question for this user…' : 'Reply with what happened during the run…'}
            rows={owner && !hasThread ? 5 : 3}
            className="w-full rounded-lg px-3 py-2 text-xs outline-none resize-y"
            style={{ color: '#e2e8f0', background: '#09090d', border: '1px solid #2a2a3b' }}
          />
          <div className="flex items-center justify-between gap-3 mt-2">
            <span className="text-[10px]" style={{ color: '#475569' }}>{body.length}/2000 · Only this account and the owner can see this thread.</span>
            <button onClick={send} disabled={!body.trim() || sending} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs disabled:opacity-40" style={{ color: '#ede9fe', background: '#6d28d9' }}>
              {sending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} {owner ? 'Send question' : 'Send reply'}
            </button>
          </div>
          {error && <div className="text-[11px] mt-2" style={{ color: '#fca5a5' }}>{error}</div>}
        </>
      )}
    </div>
  );
}
