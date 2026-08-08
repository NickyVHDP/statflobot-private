import Link from 'next/link';

/**
 * Landing page after an email confirmation link completes.
 *
 * Reached from /auth/callback when the confirmation used the implicit flow
 * (the desktop app), where the tokens live in the URL fragment and the server
 * cannot read them. The account is already confirmed at this point — the user
 * just needs to know that and where to go next.
 */
export default function EmailVerifiedPage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: 'var(--bg)' }}>
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <a href="/" className="text-white font-semibold text-xl tracking-tight">
            Statflo<span style={{ color: 'var(--accent)' }}>Bot</span>
          </a>
        </div>

        <div
          className="rounded-2xl p-8 border text-center"
          style={{ background: 'var(--card)', borderColor: 'rgba(134,239,172,0.25)' }}
        >
          <div
            className="mx-auto mb-4 flex items-center justify-center rounded-full"
            style={{ width: 48, height: 48, background: 'rgba(134,239,172,0.12)' }}
            aria-hidden="true"
          >
            <span style={{ color: '#86efac', fontSize: 24, lineHeight: 1 }}>✓</span>
          </div>

          <h1 className="text-lg font-bold text-white mb-2">Email verified</h1>
          <p className="text-sm text-slate-400 mb-6" style={{ lineHeight: 1.6 }}>
            Your account is confirmed. Sign in with your email and password to continue.
          </p>

          <Link
            href="/auth/sign-in"
            className="block w-full py-3 rounded-xl text-white font-semibold text-sm transition-opacity hover:opacity-90"
            style={{ background: 'var(--accent)' }}
          >
            Go to sign in
          </Link>

          <p className="text-xs text-slate-500 mt-4">
            Using the desktop app? You can close this tab and sign in there.
          </p>
        </div>
      </div>
    </div>
  );
}
