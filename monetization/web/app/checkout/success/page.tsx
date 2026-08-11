import Link from 'next/link';
import { CheckCircle } from 'lucide-react';

export const metadata = { title: 'Payment complete — StatfloBot' };

export default async function CheckoutSuccessPage({ searchParams }: { searchParams: Promise<{ plan?: string }> }) {
  const resolvedSearchParams = await searchParams;
  const plan = resolvedSearchParams.plan === 'lifetime' ? 'lifetime access' : 'monthly access';
  return (
    <main className="min-h-screen flex items-center justify-center px-4" style={{ background: 'var(--bg)' }}>
      <section className="w-full max-w-md rounded-2xl border p-8 text-center" style={{ background: 'var(--card)', borderColor: 'rgba(134,239,172,0.25)' }}>
        <CheckCircle className="mx-auto mb-4" size={42} style={{ color: '#86efac' }} />
        <h1 className="text-xl font-bold text-white mb-2">Payment complete</h1>
        <p className="text-sm text-slate-400 leading-relaxed">
          Your {plan} is being activated. Return to the StatfloBot app; it refreshes automatically when the app regains focus.
        </p>
        <p className="text-xs text-slate-500 mt-4">You can safely close this browser tab.</p>
        <Link href="/auth/sign-in" className="inline-block mt-6 text-sm underline" style={{ color: 'var(--accent-light)' }}>
          Also sign in on the website
        </Link>
      </section>
    </main>
  );
}
