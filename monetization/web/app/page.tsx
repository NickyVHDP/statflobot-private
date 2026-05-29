import { getPricingWindow } from '@/lib/pricing';
import PricingCard from '@/components/PricingCard';
import EarlyBirdSpots from '@/components/EarlyBirdSpots';
import SiteNav from '@/components/SiteNav';
import FeatureCarousel from '@/components/FeatureCarousel';
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
        <section className="max-w-6xl mx-auto px-6 pt-24 pb-14 text-center">
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

          <p className="text-lg max-w-xl mx-auto mb-8 leading-relaxed" style={{ color: '#94a3b8' }}>
            Open the app, sign into Statflo, pick your attempt list, and let it run.
            Stop whenever you want.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <a
              href="/auth/sign-up"
              className="px-6 py-3 rounded-xl text-white font-semibold text-sm transition-all hover:opacity-90"
              style={{ background: 'linear-gradient(135deg, #6366f1, #818cf8)', boxShadow: '0 0 24px rgba(99,102,241,0.25)' }}
            >
              Get Started
            </a>
            <a
              href="#how-it-works"
              className="px-6 py-3 rounded-xl text-sm font-medium transition-all border"
              style={{ background: 'transparent', color: '#94a3b8', borderColor: 'rgba(255,255,255,0.1)' }}
            >
              See How It Works
            </a>
          </div>
        </section>

        {/* ── Product Preview ───────────────────────────────────────────────── */}
        <section className="max-w-5xl mx-auto px-6 pb-24">
          <p className="text-center text-xs font-medium tracking-widest uppercase mb-4" style={{ color: '#334155' }}>
            What you actually use
          </p>
          <div
            className="rounded-2xl border overflow-hidden"
            style={{
              borderColor: 'rgba(124,58,237,0.2)',
              background: 'rgba(13,13,20,0.8)',
              boxShadow: '0 0 60px rgba(124,58,237,0.08), 0 1px 3px rgba(0,0,0,0.5)',
            }}
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
              style={{ borderColor: 'rgba(255,255,255,0.05)', background: 'rgba(0,0,0,0.3)' }}
            >
              <p className="text-sm" style={{ color: '#475569' }}>
                Pick an attempt, start the run, log into Statflo, and monitor everything from one app window.
              </p>
            </div>
          </div>
        </section>

        {/* ── How It Works ──────────────────────────────────────────────────── */}
        <section id="how-it-works" className="max-w-6xl mx-auto px-6 pb-28">
          <div className="text-center mb-14">
            <p className="text-xs font-medium tracking-widest uppercase mb-3" style={{ color: '#4c1d95' }}>Process</p>
            <h2 className="text-3xl font-bold text-white">How it works</h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              {
                step: '01',
                icon: <FileText size={16} />,
                title: 'Pick your attempt',
                body: 'Choose 1st, 2nd, or 3rd attempt and confirm your saved message.',
              },
              {
                step: '02',
                icon: <Zap size={16} />,
                title: 'Launch the run',
                body: 'Start the bot from the dashboard. It opens the embedded Statflo browser.',
              },
              {
                step: '03',
                icon: <MonitorDot size={16} />,
                title: 'Log in',
                body: 'Sign into Statflo/Okta normally when prompted.',
              },
              {
                step: '04',
                icon: <MousePointerClick size={16} />,
                title: 'Watch or stop anytime',
                body: 'Monitor the run from the dashboard and stop it anytime.',
              },
            ].map(({ step, icon, title, body }, i) => (
              <div
                key={step}
                className="rounded-2xl p-5 border flex flex-col gap-4 relative overflow-hidden"
                style={{
                  background: 'rgba(15,12,28,0.6)',
                  borderColor: 'rgba(124,58,237,0.15)',
                  backdropFilter: 'blur(8px)',
                }}
              >
                {/* connector line */}
                {i < 3 && (
                  <div
                    className="absolute top-7 -right-px hidden lg:block"
                    style={{ width: '100%', height: 1, background: 'linear-gradient(90deg, rgba(124,58,237,0.2), transparent)', left: '60%' }}
                  />
                )}
                <div className="flex items-start justify-between">
                  <div
                    className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                    style={{ background: 'rgba(124,58,237,0.15)', border: '1px solid rgba(124,58,237,0.25)', color: '#a78bfa' }}
                  >
                    {icon}
                  </div>
                  <span className="text-2xl font-black leading-none" style={{ color: 'rgba(124,58,237,0.15)', letterSpacing: '-0.05em' }}>
                    {step}
                  </span>
                </div>
                <div>
                  <h3 className="text-white font-semibold text-sm mb-1.5">{title}</h3>
                  <p className="text-sm leading-relaxed" style={{ color: '#64748b' }}>{body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── Feature Carousel ─────────────────────────────────────────────── */}
        <section className="max-w-6xl mx-auto px-6 pb-28">
          <div className="text-center mb-14">
            <p className="text-xs font-medium tracking-widest uppercase mb-3" style={{ color: '#4c1d95' }}>Capabilities</p>
            <h2 className="text-3xl font-bold text-white mb-3">Built around real Statflo work</h2>
            <p className="text-sm max-w-md mx-auto" style={{ color: '#475569' }}>
              Every feature exists because a rep needed it.
            </p>
          </div>
          <FeatureCarousel />
        </section>

        {/* ── Pricing ───────────────────────────────────────────────────────── */}
        <section className="max-w-6xl mx-auto px-6 pb-24">
          {canceledCheckout && (
            <p className="text-center text-sm mb-8" style={{ color: '#94a3b8' }}>
              Checkout was canceled — no charge was made.
            </p>
          )}

          <div className="text-center mb-12">
            <p className="text-xs font-medium tracking-widest uppercase mb-3" style={{ color: '#4c1d95' }}>Pricing</p>
            <h2 className="text-3xl font-bold text-white mb-3">Simple pricing</h2>
            <p className="max-w-md mx-auto text-sm" style={{ color: '#64748b' }}>
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
                originalPriceCents={pricing.isEarlyAdopter ? 10000 : undefined}
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

          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 mt-10 text-xs" style={{ color: '#334155' }}>
            <span>Secure payment via Stripe</span>
            <span aria-hidden>·</span>
            <a href="/terms" className="hover:text-slate-400 transition-colors">Terms</a>
            <span aria-hidden>·</span>
            <a href="/license" className="hover:text-slate-400 transition-colors">License</a>
            <span aria-hidden>·</span>
            <a href="/privacy" className="hover:text-slate-400 transition-colors">Privacy</a>
            <span aria-hidden>·</span>
            <a href="/support" className="hover:text-slate-400 transition-colors">Support</a>
            <span aria-hidden>·</span>
            <a href="/download" className="hover:text-slate-400 transition-colors">Free installer for Mac &amp; Windows</a>
          </div>

          {/* Platform compatibility disclosure */}
          <details className="group max-w-xl mx-auto mt-8">
            <summary
              className="flex items-center justify-center gap-1.5 cursor-pointer text-xs select-none list-none [&::-webkit-details-marker]:hidden"
              style={{ color: '#2d2a3e' }}
            >
              <span>Platform Compatibility &amp; Support</span>
              <ChevronDown
                size={12}
                className="transition-transform duration-200 group-open:rotate-180"
                style={{ color: '#2d2a3e' }}
              />
            </summary>
            <div
              className="mt-3 px-5 py-4 rounded-xl text-xs leading-relaxed"
              style={{
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid rgba(255,255,255,0.05)',
                color: '#3d3a50',
              }}
            >
              StatfloBot is a third-party desktop tool that automates workflows within Statflo.
              Like all software that integrates with external platforms, it depends on
              Statflo&apos;s interface and authentication systems remaining consistent.
              Platform updates, authentication changes, or access restrictions introduced by
              Statflo or its providers may affect compatibility or require updates on our end.
              We maintain StatfloBot on a best-effort basis and aim to support it for as long
              as reasonably possible. The built-in reporting tools are there to help diagnose
              issues quickly. Continuous or indefinite operation cannot be guaranteed, which is
              standard for any third-party integration software.
            </div>
          </details>
        </section>

        {/* ── FAQ ───────────────────────────────────────────────────────────── */}
        <section className="max-w-2xl mx-auto px-6 pt-16 pb-24">
          <div className="text-center mb-12">
            <p className="text-xs font-medium tracking-widest uppercase mb-3" style={{ color: '#4c1d95' }}>FAQ</p>
            <h2 className="text-3xl font-bold text-white">Questions</h2>
          </div>

          <div className="flex flex-col gap-1.5">
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
              {
                q: 'Will StatfloBot work forever?',
                a: "StatfloBot is built to be maintained and improved for the long term. That said, it relies on third-party platforms — Statflo and its authentication systems — that can change independently. Updates are provided on a best-effort basis, and significant platform changes or access restrictions can affect compatibility or update timelines. The built-in log and report tools are there specifically to help diagnose issues and support ongoing maintenance. The goal is to keep StatfloBot running and improving for as long as reasonably possible.",
              },
            ].map(({ q, a }) => (
              <details
                key={q}
                className="group rounded-xl border overflow-hidden"
                style={{ borderColor: 'rgba(255,255,255,0.07)' }}
              >
                <summary
                  className="flex items-center justify-between px-5 py-4 cursor-pointer text-sm font-medium text-white list-none [&::-webkit-details-marker]:hidden transition-colors"
                  style={{ background: 'rgba(255,255,255,0.03)' }}
                >
                  <span>{q}</span>
                  <ChevronDown
                    size={15}
                    className="flex-shrink-0 ml-4 transition-transform duration-200 group-open:rotate-180"
                    style={{ color: '#475569' }}
                  />
                </summary>
                <div
                  className="px-5 py-4 text-sm leading-relaxed"
                  style={{ background: 'rgba(0,0,0,0.2)', borderTop: '1px solid rgba(255,255,255,0.06)', color: '#94a3b8' }}
                >
                  {a}
                </div>
              </details>
            ))}
          </div>
        </section>

      </main>
    </div>
  );
}
