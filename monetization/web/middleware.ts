import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

/** Protect /dashboard and /admin routes — redirect unauthenticated users to /auth/sign-in */
export async function middleware(req: NextRequest) {
  const res = NextResponse.next();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (
          cookiesToSet: Array<{
            name: string;
            value: string;
            options?: Parameters<typeof res.cookies.set>[2];
          }>
        ) => {
          cookiesToSet.forEach(({ name, value, options }) => {
            res.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { pathname } = req.nextUrl;

  if (pathname.startsWith('/dashboard') || pathname.startsWith('/admin')) {
    if (!user) {
      const signIn = req.nextUrl.clone();
      signIn.pathname = '/auth/sign-in';
      signIn.searchParams.set('redirect', pathname);
      return NextResponse.redirect(signIn);
    }

    // Admin guard
    if (pathname.startsWith('/admin')) {
      const adminEmails = (process.env.ADMIN_EMAILS ?? '')
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean);

      if (!user.email || !adminEmails.includes(user.email)) {
        const dash = req.nextUrl.clone();
        dash.pathname = '/dashboard';
        return NextResponse.redirect(dash);
      }
    }
  }

  return res;
}

export const config = {
  matcher: ['/dashboard/:path*', '/admin/:path*'],
};