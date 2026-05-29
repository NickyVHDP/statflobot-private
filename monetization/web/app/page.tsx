import { getPricingWindow } from '@/lib/pricing';
import PricingCard from '@/components/PricingCard';
import EarlyBirdSpots from '@/components/EarlyBirdSpots';
import SiteNav from '@/components/SiteNav';
import Image from 'next/image';
import { Zap, ChevronDown, MousePointerClick, MonitorDot, FileText } from 'lucide-react';

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

        {/* ── Hero ──────────────────────────────────────────────────────────── */}
        <section className="max-w-6xl mx-auto px-6 pt-24 pb-16 text-center">
          <div
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium mb-6 border"
            style={{ background: 'rgba(124,58,237,0.1)', borderColor: 'rgba(124,58,237,0.3)', color: '#a78bfa' }}
          >
            <Zap size={12} />
            Built for Statflo outreach reps
          </div>

          <h1 className="text-4xl sm:text-5xl font-bold text-white mb-5 leading-tight tracking-tight">
            The desktop app for{' '}
            <span
              className="bg-clip-text text-transparent"
              style={{ backgroundImage: 'linear-gradient(135deg, #7c3aed, #818cf8)' }}
            >
              repetitive Statflo outreach.
            </span>
          </h1>

          <p className="text-slate-400 text-lg max-w-xl mx-auto mb-8 leading-relaxed">
            Open the app, sign into Statflo, pick your attempt list, and let it run.
            Stop whenever you want.
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

        {/* ── Product Preview ───────────────────────────────────────────────── */}
        <section className="max-w-5xl mx-auto px-6 pb-20">
          <p className="text-center text-xs font-medium tracking-widest uppercase mb-4" style={{ color: '#475569' }}>
            What you actually use
          </p>
          <div
            className="rounded-2xl border overflow-hidden"
            style={{ borderColor: 'rgba(124,58,237,0.25)', background: 'rgba(13,13,20,0.8)' }}
          >
            {/* v=2 busts Vercel's image optimization cache after screenshot update */}
            <Image
              src="/app-preview.png?v=2"
              alt="StatfloBot showing the embedded Statflo browser, run controls on the left, and live bot status"
              width={3418}
              height={2016}
              className="w-full h-auto block"
              priority
              unoptimized
            />
            <div
              className="px-6 py-4 border-t text-center"
              style={{ borderColor: 'rgba(255,255,255,0.06)' }}
            >
              <p className="text-sm" style={{ color: '#64748b' }}>
                Pick an attempt, start the run, log into Statflo, and monitor everything from one app window.
              </p>
            </div>
          </div>
        </section>

        {/* ── How It Works ──────────────────────────────────────────────────── */}
        <section id="how-it-works" className="max-w-6xl mx-auto px-6 pb-20">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-white mb-3">How it works</h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {[
              {
                step: '1',
                icon: <FileText size={18} />,
                title: 'Pick your attempt',
                body: 'Choose 1st, 2nd, or 3rd attempt and confirm your saved message.',
              },
              {
                step: '2',
                icon: <Zap size={18} />,
                title: 'Launch the run',
                body: 'Start the bot from the dashboard. It opens the embedded Statflo browser.',
              },
              {
                step: '3',
                icon: <MonitorDot size={18} />,
                title: 'Log in',
                body: 'Sign into Statflo/Okta normally when prompted.',
              },
              {
                step: '4',
                icon: <MousePointerClick size={18} />,
                title: 'Watch or stop anytime',
                body: 'Monitor the run from the dashboard and stop it anytime.',
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

        {/* ── Built around real Statflo work ───────────────────────────────── */}
        <section className="max-w-6xl mx-auto px-6 pb-20">
          <div className="text-center mb-10">
            <h2 className="text-3xl font-bold text-white mb-3">Built around real Statflo work</h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              {
                title: 'Stop repetitive clicking',
                body: 'Run outreach without manually opening account after account.',
              },
              {
                title: 'Keep your login familiar',
                body: 'Same Statflo/Okta login you already use — just inside a dedicated app window.',
              },
              {
                title: 'Save your messaging',
                body: 'Write your 2nd and 3rd attempt messages once. Reuse them every shift.',
              },
              {
                title: 'Stay in control',
                body: 'Start or stop the run from the same screen. No buried settings.',
              },
              {
                title: 'See what happened',
                body: 'Quick access to recent runs and anything that needs a second look.',
              },
              {
                title: 'Runs on your machine',
                body: 'No cloud session. No third-party access to your Statflo account.',
              },
            ].map(({ title, body }) => (
              <div
                key={title}
                className="rounded-2xl p-5 border"
                style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
              >
                <h3 className="text-white font-semibold text-sm mb-2">{title}</h3>
                <p className="text-slate-400 text-sm leading-relaxed">{body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── FAQ ───────────────────────────────────────────────────────────── */}
        <section className="max-w-3xl mx-auto px-6 pb-20">
          <div className="text-center mb-10">
            <h2 className="text-3xl font-bold text-white mb-3">Questions</h2>
          </div>

          <div className="flex flex-col gap-2">
            {[
              {
                q: 'Does this use my existing Statflo login?',
                a: 'Yes — same credentials, same Okta flow, just inside a dedicated app window. Nothing changes about how you sign in.',
              },
              {
                q: 'Do I need technical experience?',
                a: "No. Download the installer, sign into StatfloBot, and it's ready to use.",
              },
              {
                q: 'Can I stop a run mid-session?',
                a: "Yes. There's a Stop button on the main screen. It stops immediately.",
              },
              {
                q: 'Does this run in a browser or a separate app?',
                a: "It's a desktop app with Statflo running inside it — not a browser extension, not a tab. Your Statflo session stays inside the app window.",
              },
              {
                q: 'Can I customize 2nd and 3rd attempt messages?',
                a: "Yes. Write them once and they're saved. Edit them any time from the same screen.",
              },
              {
                q: 'What happens if something errors?',
                a: "The app keeps a log of recent runs. If something looks off, you can pull a quick report or reach out to support.",
              },
              {
                q: 'Is it cloud hosted?',
                a: "No. It runs locally on your Mac or PC. Your Statflo credentials never leave your machine.",
              },
              {
                q: 'Are updates included?',
                a: 'Yes, while your subscription is active. Lifetime plan includes all future updates.',
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

        {/* ── Pricing ───────────────────────────────────────────────────────── */}
        <section className="max-w-6xl mx-auto px-6 pb-20">
          {canceledCheckout && (
            <p className="text-center text-sm text-slate-400 mb-8">
              Checkout was canceled — no charge was made.
            </p>
          )}

          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-white mb-3">Pricing</h2>
            <p className="text-slate-400 max-w-md mx-auto">
              Monthly if you want to try it. Lifetime if you know you&apos;ll use it.
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
                note="Everyone Mode messages every eligible line on a client — exclusive to Lifetime."
              />
              <EarlyBirdSpots initialData={pricing.earlyBird} />
            </div>
          </div>

          <p className="text-center text-xs text-slate-500 mt-10">
            Secure payment via Stripe ·{' '}
            <a href="/support" className="hover:text-slate-300 transition-colors underline underline-offset-2">
              Support
            </a>{' '}
            · Runs locally on your machine
          </p>

          <div className="text-center mt-6">
            <a href="/download" className="text-xs text-slate-600 hover:text-slate-400 transition-colors">
              Free installer for Mac &amp; Windows →
            </a>
          </div>
        </section>

        {/* ── Final CTA ─────────────────────────────────────────────────────── */}
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
            <p className="text-slate-400 mb-8 max-w-sm mx-auto">
              Most reps say they feel the difference after the first run.
            </p>
            <a
              href="/auth/sign-up"
              className="inline-block px-8 py-3.5 rounded-xl text-white font-semibold text-sm transition-all hover:opacity-90"
              style={{ background: 'linear-gradient(135deg, #6366f1, #818cf8)' }}
            >
              Get Started
            </a>
          </div>
        </section>

      </main>
    </div>
  );
}
