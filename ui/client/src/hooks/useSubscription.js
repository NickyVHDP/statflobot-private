import { useState, useEffect, useCallback } from 'react';
import { fetchAccount } from '../lib/cloudApi';
import { supabase } from '../lib/supabase';

// Paid-only: 'trialing' never grants access. Kept out of this set so the
// legacy fallback below (used only when the server omits hasAccess) matches the
// server's own rule in ui/server/index.js.
const ACTIVE_STATUSES = new Set(['active', 'lifetime']);
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;  // re-check every 5 minutes

/**
 * useSubscription — fetches and maintains subscription/account state.
 *
 * Only fires when `user` is non-null.
 *
 * Returns:
 *   account        — { profile, license, subscription, devices } | null
 *   hasAccess      — true if subscription allows running the bot
 *   backendDown    — true when VITE_CLOUD_API_URL is unset or unreachable
 *   loading        — true during initial fetch
 *   refresh        — force an immediate re-fetch; returns { hasAccess, isAdmin } or null on backend-down
 */
export function useSubscription(user) {
  const [account,     setAccount]     = useState(null);
  const [loading,     setLoading]     = useState(false);
  const [backendDown, setBackendDown] = useState(false);

  // refresh returns { hasAccess, isAdmin } on success, null when backend is unreachable
  const refresh = useCallback(async () => {
    if (!user) return null;
    console.log('[ACCESS_REFRESH_START]');
    setLoading(true);
    const data = await fetchAccount();   // never throws — returns null on failure

    if (data?._authExpired === true) {
      console.warn('[ACCOUNT_SESSION_EXPIRED] cloud rejected the saved session — signing out locally');
      setAccount(null);
      setBackendDown(false);
      setLoading(false);
      await supabase?.auth.signOut({ scope: 'local' }).catch(() => {});
      return { authExpired: true, hasAccess: false, isAdmin: false };
    }

    if (data !== null) {
      setAccount(data);
      setBackendDown(false);
      const isAdminFlag = data?.profile?.is_admin === true;
      // Use server's hasAccess as primary signal (includes Stripe sync + period_end check)
      const serverHasAccess = typeof data?.hasAccess === 'boolean' ? data.hasAccess : null;
      const subStatus = data?.subscription?.status ?? 'none';
      const licStatus = data?.license?.status ?? 'none';
      const computedHasAccess = isAdminFlag || serverHasAccess === true || false;
      // accessIssue explains a repairable denial (e.g. a paid customer whose
      // subscription record failed to persist) so the caller can offer a repair
      // path instead of a paywall.
      const accessIssue = data?.accessIssue ?? null;
      console.log(`[ACCESS_REFRESH_RESULT] hasAccess=${computedHasAccess} serverHasAccess=${serverHasAccess} subStatus=${subStatus} licStatus=${licStatus} accessIssue=${accessIssue?.code ?? 'none'}`);
      setLoading(false);
      return { hasAccess: computedHasAccess, isAdmin: isAdminFlag, accessIssue };
    } else {
      // Backend temporarily down — preserve last known account so access is not lost
      console.log('[ACCOUNT_LOAD_FAIL_KEEPING_LAST_GOOD] backend unreachable — preserving last known account');
      console.log('[LICENSE_ACCESS_PRESERVED] last known account/license retained until real unauthorized response');
      setBackendDown(true);
      setLoading(false);
      return null;
    }
  }, [user]);

  // Fetch on mount and whenever user changes
  useEffect(() => {
    if (!user) {
      setAccount(null);
      setBackendDown(false);
      return;
    }
    refresh();

    // Periodic re-validation
    const interval = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [user, refresh]);

  // Refresh on window focus and document visibility — catches returning from billing portal
  // or switching back to the app after subscription changes in browser
  useEffect(() => {
    if (!user) return;
    const onFocus = () => refresh();
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [user, refresh]);

  const isAdmin   = account?.profile?.is_admin === true;
  const subStatus = account?.subscription?.status;
  const licStatus = account?.license?.status;

  // Use server's hasAccess as primary signal; fall back to raw field checks only when absent
  // (e.g. older server versions that don't return hasAccess)
  const serverHasAccess = typeof account?.hasAccess === 'boolean' ? account.hasAccess : null;
  const hasAccess = isAdmin
    || serverHasAccess === true
    || (serverHasAccess === null && subStatus && ACTIVE_STATUSES.has(subStatus))
    || (serverHasAccess === null && licStatus === 'active');

  return { account, hasAccess, isAdmin, backendDown, loading, refresh };
}
