import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';

/**
 * useAuth — tracks the Supabase session.
 *
 * Returns:
 *   user         — Supabase user object (null if signed out)
 *   loading      — true during initial session check
 *   signOut      — async function to sign out
 */
export function useAuth() {
  const [user,    setUser]    = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }

    // Get the current session immediately
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });

    // Listen for auth state changes (sign in / sign out / token refresh)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      // Notify Electron main process of auth state (for native menu / dock updates)
      window.electron?.notifyAuthChange(!!session?.user);
    });

    return () => subscription.unsubscribe();
  }, []);

  async function signOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
  }

  return { user, loading, signOut };
}
