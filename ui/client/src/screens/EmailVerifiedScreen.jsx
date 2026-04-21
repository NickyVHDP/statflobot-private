import { CheckCircle, Zap } from 'lucide-react';

/**
 * EmailVerifiedScreen
 *
 * Shown at /auth/verified after the user clicks the Supabase confirmation link.
 * Supabase redirects to:
 *   http://localhost:5173/auth/verified   (local dev)
 *   https://<your-domain>/auth/verified   (production)
 *
 * The user clicks "Go to Login" to navigate back to the root, which renders
 * the normal auth flow.
 */
export default function EmailVerifiedScreen() {
  function goToLogin() {
    // Replace history entry so the back button doesn't loop here
    window.location.replace('/');
  }

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center px-4"
      style={{ background: '#0a0a0f' }}
    >
      {/* Logo */}
      <div
        className="w-14 h-14 rounded-2xl flex items-center justify-center mb-6"
        style={{ background: 'linear-gradient(135deg, #6366f1, #818cf8)', boxShadow: '0 0 40px rgba(99,102,241,0.35)' }}
      >
        <Zap size={28} className="text-white" />
      </div>

      {/* Card */}
      <div
        className="w-full max-w-sm rounded-2xl p-8 border text-center"
        style={{ background: '#13131f', borderColor: 'rgba(255,255,255,0.07)' }}
      >
        <div
          className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4"
          style={{ background: 'rgba(134,239,172,0.1)' }}
        >
          <CheckCircle size={28} style={{ color: '#86efac' }} />
        </div>

        <h1 className="text-lg font-bold text-white mb-2">Email verified</h1>
        <p className="text-sm mb-6" style={{ color: '#94a3b8' }}>
          Your account is ready. Please log in to continue.
        </p>

        <button
          onClick={goToLogin}
          className="w-full py-3 rounded-xl text-white font-semibold text-sm transition-all"
          style={{ background: 'linear-gradient(135deg, #6366f1, #818cf8)' }}
        >
          Go to Login
        </button>
      </div>

      <p className="text-xs mt-6" style={{ color: '#334155' }}>
        AutoCloser · Secure login powered by Supabase
      </p>
    </div>
  );
}
