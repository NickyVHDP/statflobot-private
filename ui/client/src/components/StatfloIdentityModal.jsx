import { useState } from 'react';
import { User } from 'lucide-react';
import { getAccessToken } from '../lib/cloudApi';

function normalize(raw) {
  return raw.trim().toLowerCase().replace(/@cellularsales\.com$/, '');
}

export default function StatfloIdentityModal({ onSaved, onClose }) {
  const [raw, setRaw]       = useState('');
  const [error, setError]   = useState(null);
  const [loading, setLoading] = useState(false);

  const normalized = normalize(raw);
  const isValid    = normalized.length >= 3 && normalized.includes('.');

  async function handleSubmit(e) {
    e.preventDefault();
    if (!isValid) return;
    console.log(`[IDENTITY_SAVE_CLICK] raw="${raw}" normalized="${normalized}"`);
    setLoading(true);
    setError(null);
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/identity/set', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ raw }),
      });
      const data = await res.json();
      console.log(`[IDENTITY_SAVE_RESPONSE] ok=${res.ok} status=${res.status} identityKey=${data.identityKey ?? 'null'} persisted=${data.persisted ?? 'unknown'} savedPath=${data.savedPath ?? 'none'}`);
      if (res.status === 409) {
        setError(
          `This account is already locked to a different Statflo user` +
          (data.lockedKey ? ` (${data.lockedKey})` : '') +
          `. Contact support to change it.`
        );
        return;
      }
      if (!res.ok) {
        setError(data.error ?? 'Failed to save identity. Try again.');
        return;
      }
      console.log(`[IDENTITY_SAVE_SET_LOCKED_STATE] identityKey=${data.identityKey}`);
      // Write localStorage here regardless of persisted status — guarantees the
      // modal won't re-appear even if the server couldn't write to disk.
      if (data.identityKey) {
        try { localStorage.setItem('statfloIdentityKey', data.identityKey); } catch {}
      }
      onSaved(data.identityKey);
    } catch {
      setError('Network error. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)' }}
    >
      <div
        className="rounded-2xl p-6 w-full max-w-md border mx-4"
        style={{ background: '#13131f', borderColor: 'rgba(255,255,255,0.08)' }}
      >
        <div className="flex items-center gap-3 mb-5">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: 'rgba(99,102,241,0.15)' }}
          >
            <User size={18} style={{ color: '#818cf8' }} />
          </div>
          <div>
            <h2 className="text-base font-semibold text-white">Statflo Username Required</h2>
            <p className="text-xs" style={{ color: '#64748b' }}>Saved once — locked to your account</p>
          </div>
        </div>

        <p className="text-sm mb-5" style={{ color: '#94a3b8' }}>
          Enter your Statflo username to associate this bot with your account.
          This prevents the bot from being shared across different Statflo users.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs mb-1.5 font-medium" style={{ color: '#64748b' }}>
              Statflo Username
            </label>
            <input
              type="text"
              placeholder="first.last or first.last@cellularsales.com"
              value={raw}
              onChange={e => { setRaw(e.target.value); setError(null); }}
              className="w-full rounded-xl px-3 py-2.5 text-sm text-white outline-none border"
              style={{ background: '#0a0a0f', borderColor: 'rgba(255,255,255,0.1)', caretColor: '#818cf8' }}
              autoFocus
              disabled={loading}
            />
            {raw.length > 0 && isValid && (
              <p className="text-xs mt-1.5" style={{ color: '#818cf8' }}>
                Will save as: <strong>{normalized}</strong>
              </p>
            )}
          </div>

          {error && (
            <p
              className="text-xs rounded-xl px-3 py-2.5 border"
              style={{
                color: '#f87171',
                background: 'rgba(248,113,113,0.08)',
                borderColor: 'rgba(248,113,113,0.2)',
              }}
            >
              {error}
            </p>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl text-sm font-medium border transition-colors"
              style={{ borderColor: 'rgba(255,255,255,0.08)', color: '#64748b' }}
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!isValid || loading}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition-colors"
              style={{
                background: isValid && !loading
                  ? 'linear-gradient(135deg, #6366f1, #818cf8)'
                  : 'rgba(99,102,241,0.25)',
                color: isValid && !loading ? 'white' : '#64748b',
                cursor: isValid && !loading ? 'pointer' : 'not-allowed',
              }}
            >
              {loading ? 'Saving…' : 'Save & Continue'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
