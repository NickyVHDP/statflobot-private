import { useState, useEffect, useCallback } from 'react';
import { fetchAccount } from '../lib/cloudApi';

const ACTIVE_STATUSES = new Set(['active', 'trialing', 'lifetime']);
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
 *   refresh        — call to force an immediate re-fetch
 */
export function useSubscription(user) {
  const [account,     setAccount]     = useState(null);
  const [loading,     setLoading]     = useState(false);
  const [backendDown, setBackendDown] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const data = await fetchAccount();   // never throws — returns null on failure
    setAccount(data);
    setBackendDown(data === null);
    setLoading(false);
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

  const isAdmin   = account?.profile?.is_admin === true;
  const subStatus = account?.subscription?.status;
  const licStatus = account?.license?.status;
  const licPlan   = account?.license?.plan;

  // Access granted if:
  //   – admin flag on profile
  //   – subscription status is active/trialing/lifetime
  //   – active lifetime license without a subscription row (one-time purchase)
  const hasAccess = isAdmin
                 || (subStatus && ACTIVE_STATUSES.has(subStatus))
                 || (licStatus === 'active' && licPlan === 'lifetime');

  return { account, hasAccess, isAdmin, backendDown, loading, refresh };
}
