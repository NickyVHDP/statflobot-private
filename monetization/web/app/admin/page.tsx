import { createServiceClient } from '@/lib/supabase/server';
import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

export default async function AdminPage() {
  const supabase    = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/auth/sign-in?redirect=/admin');

  const adminEmails = (process.env.ADMIN_EMAILS ?? '').split(',').map(e => e.trim());
  if (!user.email || !adminEmails.includes(user.email)) redirect('/dashboard');

  const svc = createServiceClient();

  const [licensesRes, subsRes] = await Promise.all([
    svc.from('licenses').select('id, license_key, status, plan_code, created_at, profiles!inner(email)').order('created_at', { ascending: false }).limit(100),
    svc.from('subscriptions').select('id, status, stripe_subscription_id, current_period_end, profiles!inner(email)').order('created_at', { ascending: false }).limit(100),
  ]);

  const licenses = licensesRes.data ?? [];
  const subs     = subsRes.data    ?? [];

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <nav className="border-b px-6 py-4 flex items-center gap-4 max-w-6xl mx-auto" style={{ borderColor: 'var(--border)' }}>
        <a href="/" className="text-white font-semibold text-lg tracking-tight">
          Statflo<span style={{ color: 'var(--accent)' }}>Bot</span>
        </a>
        <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(124,58,237,0.2)', color: '#a78bfa' }}>Admin</span>
        <a href="/dashboard" className="ml-auto text-xs text-slate-400 hover:text-white transition-colors">My dashboard</a>
      </nav>

      <main className="max-w-6xl mx-auto px-6 py-10 space-y-10">

        {/* Licenses */}
        <section>
          <h2 className="text-lg font-bold text-white mb-4">Licenses ({licenses.length})</h2>
          <div className="rounded-2xl border overflow-hidden" style={{ borderColor: 'var(--border)' }}>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">License Key</th>
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Created</th>
                </tr>
              </thead>
              <tbody>
                {licenses.map((l: any) => (
                  <tr key={l.id} className="border-b last:border-0" style={{ borderColor: 'var(--border)' }}>
                    <td className="px-4 py-3 text-slate-300">{(l.profiles as any)?.email}</td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-400">{l.license_key}</td>
                    <td className="px-4 py-3 text-slate-300">{l.plan_code}</td>
                    <td className="px-4 py-3">
                      <StatusDot status={l.status} />
                    </td>
                    <td className="px-4 py-3 text-slate-500 text-xs">{new Date(l.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Subscriptions */}
        <section>
          <h2 className="text-lg font-bold text-white mb-4">Subscriptions ({subs.length})</h2>
          <div className="rounded-2xl border overflow-hidden" style={{ borderColor: 'var(--border)' }}>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Stripe Sub ID</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Period End</th>
                </tr>
              </thead>
              <tbody>
                {subs.map((s: any) => (
                  <tr key={s.id} className="border-b last:border-0" style={{ borderColor: 'var(--border)' }}>
                    <td className="px-4 py-3 text-slate-300">{(s.profiles as any)?.email}</td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-400">{s.stripe_subscription_id ?? 'lifetime'}</td>
                    <td className="px-4 py-3"><StatusDot status={s.status} /></td>
                    <td className="px-4 py-3 text-slate-500 text-xs">
                      {s.current_period_end ? new Date(s.current_period_end).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active:   '#86efac', trialing: '#fbbf24', past_due: '#f87171',
    canceled: '#94a3b8', inactive: '#94a3b8', lifetime: '#a78bfa',
    revoked:  '#f87171',
  };
  const color = colors[status] ?? '#94a3b8';
  return (
    <span className="flex items-center gap-1.5">
      <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: color }} />
      <span style={{ color }} className="text-xs">{status}</span>
    </span>
  );
}
