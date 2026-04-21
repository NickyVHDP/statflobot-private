import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { type NextRequest } from 'next/server';

/**
 * Resolve the authenticated user from an API request.
 *
 * Priority:
 *   1. Authorization: Bearer <JWT>  — used by the desktop-app Express proxy
 *   2. Cookie-based session          — used by the web browser
 *
 * The service-role client is used to verify the JWT because it can call
 * auth.getUser(token) without needing browser cookies.
 */
export async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get('authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (token) {
    const svc = createServiceClient();
    const { data: { user } } = await svc.auth.getUser(token);
    if (user) return user;
    // Token present but invalid — don't fall through to cookies
    return null;
  }

  // No bearer token — try cookie-based session (web browser)
  const cookieClient = createClient();
  const { data: { user } } = await cookieClient.auth.getUser();
  return user ?? null;
}

/** Server-component / route-handler Supabase client (uses user's session cookie). */
export function createClient() {
  const cookieStore = cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(
          cookiesToSet: Array<{
            name: string;
            value: string;
            options?: Parameters<typeof cookieStore.set>[2];
          }>
        ) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Ignored in Server Components where cookies are read-only.
          }
        },
      },
    }
  );
}

/** Service-role client for privileged server operations (API routes only). */
export function createServiceClient() {
  const { createClient: _create } = require('@supabase/supabase-js');

  return _create(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { persistSession: false },
    }
  );
}