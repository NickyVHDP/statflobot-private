import { getPricingWindow } from '@/lib/pricing';
import PricingCard from '@/components/PricingCard';
import EarlyBirdSpots from '@/components/EarlyBirdSpots';
import SiteNav from '@/components/SiteNav';
import Image from 'next/image';
import { Zap, ShieldCheck, CheckCircle, ChevronDown, Clock, MousePointerClick, MonitorDot, FileText } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function LandingPage({
  searchParams,
}: {
  searchParams: { checkout?: string };
}) {
  const pricing = await getPricingWindow();
  const canceledCheckout = searchParams.checkout === 'canceled';

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <SiteNav />

      <main>

        {/* ── 1. Hero ──────────────────────────────────────────────────────────── */}
        <section className="max-w-6xl mx-auto px-6 pt-24 pb-16 text-center">
          <div
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium mb-6 border"
            style={{ background: 'rgba(124,58,237,0.1)', borderColor: 'rgba(124,58,237,0.3)', color: '#a78bfa' }}
          >
            <Zap size={12} />
            Built for Statflo outreach reps
          </div>

          <h1 className="text-4xl sm:text-5xl font-bold text-white mb-6 leading-tight tracking-tight">
            Automate Statflo outreach<br />
            <span
              className="bg-clip-text text-transparent"
              style={{ backgroundImage: 'linear-gradient(135deg, #7c3aed, #818cf8)' }}
            >
              without living inside Statflo.
            </span>
          </h1>

          <p className="text-slate-400 text-lg max-w-2xl mx-auto mb-8 leading-relaxed">
            StatfloBot helps reps launch structured 1st, 2nd, and 3rd attempt outreach runs from a
            simple desktop app, while keeping the browser session embedded and easy to monitor.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <a
              href="/auth/sign-up"
              className="px-6 py-3 rounded-xl text-white font-semibold text-sm transition-all hover:opacity-90"
              style={{ background: 'linear-gradient(135deg, #6366f1, #818cf8)' }}
            >
              Get Started
            </a>
            <a
              href="#how-it-works"
              className="px-6 py-3 rounded-xl text-sm font-medium transition-all border hover:border-white/20"
              style={{ background: 'transparent', color: '#94a3b8', borderColor: 'rgba(255,255,255,0.1)' }}
            >
              See How It Works
            </a>
          </div>
        </section>

        {/* ── 2. Product Preview ───────────────────────────────────────────────── */}
        <section className="max-w-5xl mx-auto px-6 pb-20">
          <div
            className="rounded-2xl border overflow-hidden"
            style={{ borderColor: 'rgba(124,58,237,0.25)', background: 'rgba(13,13,20,0.8)' }}
          >
            <Image
              src="/app-preview.png"
              alt="StatfloBot running with embedded Statflo/Okta login, run controls on the left, and bot status at the top"
              width={3418}
              height={2016}
              className="w-full h-auto block"
              priority
            />
            <div
              className="px-6 py-4 border-t text-center"
              style={{ borderColor: 'rgba(255,255,255,0.06)' }}
            >
              <p className="text-sm" style={{ color: '#94a3b8' }}>
                StatfloBot runs inside a secure embedded browser, so reps can log in normally and
                monitor the run from one clean dashboard.
              </p>
            </div>
          </div>
        </section>

        {/* ── 3. How It Works ──────────────────────────────────────────────────── */}
        <section id="how-it-works" className="max-w-6xl mx-auto px-6 pb-20">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-white mb-3">How it works</h2>
            <p className="text-slate-400">Four simple steps from install to running outreach.</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {[
              {
                step: '1',
                icon: <MonitorDot size={18} />,
                title: 'Log in normally',
                body: 'Open the app and sign into Statflo/Okta inside the embedded browser — the same way you always do.',
              },
              {
                step: '2',
                icon: <FileText size={18} />,
                title: 'Choose your attempt list',
                body: 'Pick 1st, 2nd, or 3rd Attempt. Save your preferred messages for repeat use.',
              },
              {
                step: '3',
                icon: <Zap size={18} />,
                title: 'Start the run',
                body: 'StatfloBot launches the workflow, opens accounts, and follows the selected outreach process.',
              },
              {
                step: '4',
                icon: <MousePointerClick size={18} />,
                title: 'Monitor and stop anytime',
                body: 'Watch the status live, stop the run anytime, and review recent run logs if needed.',
              },
            ].map(({ step, icon, title, body }) => (
              <div
                key={step}
                className="rounded-2xl p-5 border flex flex-col gap-3"
                style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
              >
                <div className="flex items-center gap-3">
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
                    style={{ background: 'rgba(124,58,237,0.18)', color: '#a78bfa', border: '1px solid rgba(124,58,237,0.3)' }}
                  >
                    {step}
                  </div>
                  <span style={{ color: '#818cf8' }}>{icon}</span>
                </div>
                <h3 className="text-white font-semibold text-sm">{title}</h3>
                <p className="text-slate-400 text-sm leading-relaxed">{body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── 4. What It Helps With ────────────────────────────────────────────── */}
        <section className="max-w-6xl mx-auto px-6 pb-20">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-white mb-3">What StatfloBot helps with</h2>
            <p className="text-slate-400 max-w-xl mx-auto">
              Everything you need to run structured outreach — nothing you don&apos;t.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              {
                title: '1st Attempt workflows',
                body: 'Automates your full 1st Attempt outreach list without manual clicking through each account.',
                color: '#818cf8',
                bg: 'rgba(99,102,241,0.08)',
                border: 'rgba(99,102,241,0.2)',
              },
              {
                title: '2nd & 3rd Attempt messages',
                body: 'Loads your saved message templates and sends follow-up messages on the right attempt lists.',
                color: '#818cf8',
                bg: 'rgba(99,102,241,0.08)',
                border: 'rgba(99,102,241,0.2)',
              },
              {
                title: 'Embedded browser login',
                body: 'Sign into Statflo/Okta through the app — no external browser window or screen-sharing needed.',
                color: '#a78bfa',
                bg: 'rgba(124,58,237,0.08)',
                border: 'rgba(124,58,237,0.2)',
              },
              {
                title: 'Saved message templates',
                body: 'Write your messages once, save them, and reuse them every run without re-typing.',
                color: '#34d399',
                bg: 'rgba(52,211,153,0.07)',
                border: 'rgba(52,211,153,0.18)',
              },
              {
                title: 'Run controls and stop button',
                body: 'The rep stays in control — pause or stop a run at any time from the dashboard.',
                color: '#34d399',
                bg: 'rgba(52,211,153,0.07)',
                border: 'rgba(52,211,153,0.18)',
              },
              {
                title: 'Recent run history',
                body: 'Review what ran, when, and any issues from the last session without needing to dig through logs.',
                color: '#fbbf24',
                bg: 'rgba(251,191,36,0.06)',
                border: 'rgba(251,191,36,0.18)',
              },
            ].map(({ title, body, color, bg, border }) => (
              <div
                key={title}
                className="rounded-2xl p-5 border"
                style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
              >
                <div
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold mb-3"
                  style={{ background: bg, color, border: `1px solid ${border}` }}
                >
                  <CheckCircle size={11} />
                  Included
                </div>
                <h3 className="text-white font-semibold text-sm mb-1.5">{title}</h3>
                <p className="text-slate-400 text-sm leading-relaxed">{body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── 5. What It Does NOT Do ───────────────────────────────────────────── */}
        <section className="max-w-3xl mx-auto px-6 pb-20">
          <div
            className="rounded-2xl p-8 border"
            style={{ background: 'rgba(134,239,172,0.04)', borderColor: 'rgba(134,239,172,0.14)' }}
          >
            <div className="flex items-center gap-3 mb-4">
              <ShieldCheck size={20} style={{ color: '#86efac' }} />
              <h2 className="text-lg font-bold text-white">Designed for responsible use</h2>
            </div>
            <p className="text-slate-300 leading-relaxed text-sm">
              StatfloBot is not a spam tool. It does not bypass login, does not scrape private systems
              outside the user&apos;s access, and does not remove the rep from responsibility. It is designed
              to help reps execute their normal Statflo workflow more consistently — with the same
              controls and accountability as doing it manually.
            </p>
          </div>
        </section>

        {/* ── 6. FAQ ───────────────────────────────────────────────────────────── */}
        <section className="max-w-3xl mx-auto px-6 pb-20">
          <div className="text-center mb-10">
            <h2 className="text-3xl font-bold text-white mb-3">Common questions</h2>
          </div>

          <div className="flex flex-col gap-2">
            {[
              {
                q: 'Do I still log into Statflo normally?',
                a: 'Yes. You log in through the embedded browser just like you normally would.',
              },
              {
                q: 'Does the bot run inside the app?',
                a: 'Yes. The goal is for the workflow to run inside the StatfloBot desktop app, not in a random browser popup.',
              },
              {
                q: 'Can I stop a run?',
                a: 'Yes. The dashboard includes a Stop button so the rep stays in control.',
              },
              {
                q: 'Can I edit my 2nd and 3rd attempt messages?',
                a: 'Yes. Messages can be edited and saved in the app.',
              },
              {
                q: 'Is this meant for mass blasting?',
                a: 'No. It is designed for structured outreach workflows where the rep controls the run and message setup.',
              },
              {
                q: 'What happens if something fails?',
                a: 'The app keeps recent run logs and includes a simple report option so issues can be reviewed.',
              },
              {
                q: 'Do I need coding knowledge?',
                a: 'No. The app is built to be used from a simple dashboard.',
              },
              {
                q: 'Is this for Cellular Sales / Verizon reps?',
                a: 'The app is designed around the Statflo workflow used by reps, especially attempt-list outreach.',
              },
            ].map(({ q, a }) => (
              <details
                key={q}
                className="group rounded-xl border overflow-hidden"
                style={{ borderColor: 'var(--border)' }}
              >
                <summary
                  className="flex items-center justify-between px-5 py-4 cursor-pointer text-sm font-medium text-white list-none [&::-webkit-details-marker]:hidden hover:bg-white/[0.02] transition-colors"
                  style={{ background: 'var(--card)' }}
                >
                  <span>{q}</span>
                  <ChevronDown
                    size={16}
                    className="flex-shrink-0 ml-4 transition-transform duration-200 group-open:rotate-180"
                    style={{ color: '#64748b' }}
                  />
                </summary>
                <div
                  className="px-5 py-4 text-sm leading-relaxed text-slate-400"
                  style={{ background: 'var(--surface)', borderTop: '1px solid var(--border)' }}
                >
                  {a}
                </div>
              </details>
            ))}
          </div>
        </section>

        {/* ── 7. Pricing ───────────────────────────────────────────────────────── */}
        <section className="max-w-6xl mx-auto px-6 pb-20">
          {canceledCheckout && (
            <p className="text-center text-sm text-slate-400 mb-8">
              Checkout was canceled — no charge was made.
            </p>
          )}

          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-white mb-3">Simple pricing</h2>
            <p className="text-slate-400 max-w-lg mx-auto">
              No hidden fees. Cancel anytime on monthly. Lifetime includes all future updates and priority support.
            </p>
            {pricing.isEarlyAdopter && pricing.daysRemaining !== null && (
              <p className="text-sm font-medium mt-3" style={{ color: '#fbbf24' }}>
                Early adopter pricing ends in {pricing.daysRemaining} day
                {pricing.daysRemaining !== 1 ? 's' : ''}
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-3xl mx-auto">
            <PricingCard
              planCode="monthly"
              name="Monthly"
              subtitle="Best for trying StatfloBot"
              priceCents={pricing.monthly_price_cents}
              billingType="monthly"
              features={[
                'Full 1st / 2nd / 3rd Attempt automation',
                'Embedded browser login included',
                'Saved message templates',
                'Recent run logs',
                'Cancel any time',
              ]}
            />
            <div>
              <PricingCard
                planCode={pricing.lifetime_plan_code}
                name={pricing.lifetime_plan_name}
                subtitle="Never pay monthly again"
                priceCents={pricing.lifetime_price_cents}
                billingType="lifetime"
                featured
                badge={pricing.isEarlyAdopter ? 'Early adopter pricing' : 'Best value'}
                features={[
                  'Everything in Monthly',
                  'One-time payment — lifetime access',
                  'All future updates included',
                  'Exclusive Everyone Mode included',
                ]}
                note="Everyone Mode helps message every eligible line on a client automatically — exclusive to Lifetime."
              />
              <EarlyBirdSpots initialData={pricing.earlyBird} />
            </div>
          </div>

          <p className="text-center text-xs text-slate-500 mt-10">
            Secure payment via Stripe ·{' '}
            <a href="/support" className="hover:text-slate-300 transition-colors underline underline-offset-2">
              Support
            </a>{' '}
            · Bot runs locally on your machine
          </p>

          <div className="text-center mt-6">
            <a href="/download" className="text-xs text-slate-600 hover:text-slate-400 transition-colors">
              Free installer for Mac &amp; Windows →
            </a>
          </div>
        </section>

        {/* ── 8. Final CTA ─────────────────────────────────────────────────────── */}
        <section className="max-w-6xl mx-auto px-6 pb-24">
          <div
            className="rounded-2xl p-12 text-center border"
            style={{
              background: 'linear-gradient(135deg, rgba(124,58,237,0.12), rgba(79,70,229,0.06))',
              borderColor: 'rgba(124,58,237,0.22)',
            }}
          >
            <h2 className="text-3xl font-bold text-white mb-4">
              Spend less time clicking and more time selling.
            </h2>
            <p className="text-slate-400 mb-8 max-w-md mx-auto leading-relaxed">
              Join reps who run their Statflo outreach in a fraction of the time.
            </p>
            <a
              href="/auth/sign-up"
              className="inline-block px-8 py-3.5 rounded-xl text-white font-semibold text-sm transition-all hover:opacity-90"
              style={{ background: 'linear-gradient(135deg, #6366f1, #818cf8)' }}
            >
              Start Using StatfloBot
            </a>
          </div>
        </section>

      </main>
    </div>
  );
}
