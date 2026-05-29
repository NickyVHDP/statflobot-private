'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';
import { Menu, X } from 'lucide-react';
import Logo from '@/components/Logo';

/**
 * Top nav for the marketing site.
 * Desktop: Download · Support · Sign in · Get started (or Dashboard / Sign out)
 * Mobile:  Logo + hamburger → dropdown with same links
 */
export default function SiteNav() {
  const [email,     setEmail]     = useState<string | null>(null);
  const [resolved,  setResolved]  = useState(false);
  const [menuOpen,  setMenuOpen]  = useState(false);
  const router   = useRouter();
  const supabase = createClient();

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null);
      setResolved(true);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setEmail(session?.user?.email ?? null);
    });
    return () => subscription.unsubscribe();
  }, []);

  // Close menu on route change / resize to desktop
  useEffect(() => {
    const close = () => setMenuOpen(false);
    window.addEventListener('resize', close);
    return () => window.removeEventListener('resize', close);
  }, []);

  async function handleSignOut() {
    await supabase.auth.signOut();
    setMenuOpen(false);
    router.refresh();
    setEmail(null);
  }

  const isSignedIn = resolved && !!email;

  return (
    <header
      className="sticky top-0 z-50 border-b border-white/5"
      style={{ background: 'rgba(10,10,15,0.95)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}
    >
      {/* ── Main bar ─────────────────────────────────────────────────────── */}
      <div className="max-w-6xl mx-auto px-5 py-4 flex items-center justify-between gap-4">

        {/* Logo */}
        <a href="/" style={{ textDecoration: 'none', flexShrink: 0 }}>
          <Logo height={34} />
        </a>

        {/* Desktop nav — hidden below sm */}
        <div className="hidden sm:flex items-center gap-4" style={{ minHeight: '36px' }}>
          <a href="/download" className="text-sm text-slate-400 hover:text-white transition-colors">
            Download
          </a>
          <a href="/support" className="text-sm text-slate-400 hover:text-white transition-colors">
            Support
          </a>

          {resolved && (
            isSignedIn ? (
              <>
                <a href="/dashboard" className="text-sm text-slate-400 hover:text-white transition-colors">
                  Dashboard
                </a>
                <span className="text-xs text-slate-500 max-w-[140px] truncate hidden md:inline">
                  {email}
                </span>
                <button
                  onClick={handleSignOut}
                  className="text-sm text-slate-400 hover:text-white transition-colors"
                >
                  Sign out
                </button>
              </>
            ) : (
              <>
                <a href="/auth/sign-in" className="text-sm text-slate-400 hover:text-white transition-colors">
                  Sign in
                </a>
                <a
                  href="/auth/sign-up"
                  className="text-sm px-4 py-2 rounded-lg text-white font-medium transition-all hover:opacity-90"
                  style={{ background: 'var(--accent)' }}
                >
                  Get started
                </a>
              </>
            )
          )}
        </div>

        {/* Mobile right side — visible below sm */}
        <div className="flex sm:hidden items-center gap-2">
          {/* Primary CTA always visible on mobile */}
          {resolved && !isSignedIn && (
            <a
              href="/auth/sign-up"
              className="text-xs px-3 py-2 rounded-lg text-white font-medium transition-all"
              style={{ background: 'var(--accent)' }}
            >
              Get started
            </a>
          )}
          {resolved && isSignedIn && (
            <a
              href="/dashboard"
              className="text-xs px-3 py-2 rounded-lg font-medium transition-all"
              style={{ background: 'rgba(255,255,255,0.07)', color: '#e2e8f0', border: '1px solid rgba(255,255,255,0.1)' }}
            >
              Dashboard
            </a>
          )}

          {/* Hamburger */}
          <button
            onClick={() => setMenuOpen(p => !p)}
            className="w-9 h-9 flex items-center justify-center rounded-lg transition-colors"
            style={{ background: menuOpen ? 'rgba(255,255,255,0.08)' : 'transparent', border: '1px solid rgba(255,255,255,0.1)' }}
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          >
            {menuOpen
              ? <X size={17} style={{ color: '#94a3b8' }} />
              : <Menu size={17} style={{ color: '#94a3b8' }} />
            }
          </button>
        </div>
      </div>

      {/* ── Mobile dropdown ───────────────────────────────────────────────── */}
      {menuOpen && (
        <div
          className="sm:hidden border-t"
          style={{ borderColor: 'rgba(255,255,255,0.06)', background: 'rgba(10,10,15,0.98)' }}
        >
          <div className="max-w-6xl mx-auto px-5 py-4 flex flex-col gap-1">
            <a
              href="/download"
              onClick={() => setMenuOpen(false)}
              className="px-3 py-3 rounded-lg text-sm text-slate-300 hover:text-white hover:bg-white/[0.04] transition-colors"
            >
              Download
            </a>
            <a
              href="/support"
              onClick={() => setMenuOpen(false)}
              className="px-3 py-3 rounded-lg text-sm text-slate-300 hover:text-white hover:bg-white/[0.04] transition-colors"
            >
              Support
            </a>

            <div className="my-1 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }} />

            {resolved && (
              isSignedIn ? (
                <>
                  {email && (
                    <p className="px-3 py-1 text-xs truncate" style={{ color: '#475569' }}>{email}</p>
                  )}
                  <a
                    href="/dashboard"
                    onClick={() => setMenuOpen(false)}
                    className="px-3 py-3 rounded-lg text-sm text-slate-300 hover:text-white hover:bg-white/[0.04] transition-colors"
                  >
                    Dashboard
                  </a>
                  <button
                    onClick={handleSignOut}
                    className="text-left px-3 py-3 rounded-lg text-sm text-slate-300 hover:text-white hover:bg-white/[0.04] transition-colors"
                  >
                    Sign out
                  </button>
                </>
              ) : (
                <>
                  <a
                    href="/auth/sign-in"
                    onClick={() => setMenuOpen(false)}
                    className="px-3 py-3 rounded-lg text-sm text-slate-300 hover:text-white hover:bg-white/[0.04] transition-colors"
                  >
                    Sign in
                  </a>
                  <a
                    href="/auth/sign-up"
                    onClick={() => setMenuOpen(false)}
                    className="mt-1 px-3 py-3 rounded-lg text-sm text-white font-medium text-center transition-all"
                    style={{ background: 'var(--accent)' }}
                  >
                    Get started
                  </a>
                </>
              )
            )}
          </div>
        </div>
      )}
    </header>
  );
}
