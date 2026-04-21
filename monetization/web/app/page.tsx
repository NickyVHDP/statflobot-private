import { getPricingWindow } from '@/lib/pricing';
import PricingCard from '@/components/PricingCard';
import EarlyBirdSpots from '@/components/EarlyBirdSpots';
import SiteNav from '@/components/SiteNav';
import { Zap, ShieldCheck, Clock } from 'lucide-react';

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

      {/* Nav */}
      <SiteNav />

      <main className="max-w-6xl mx-auto px-6 py-24">

        {/* Hero */}
        <div className="text-center mb-20">
          <div
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium mb-6 border"
            style={{ background: 'rgba(124,58,237,0.1)', borderColor: 'rgba(124,58,237,0.3)', color: '#a78bfa' }}
          >
            <Zap size={12} />
            Automate your Statflo outreach
          </div>

          <h1 className="text-5xl font-bold text-white mb-6 leading-tight tracking-tight">
            Send smarter.<br />
            <span
              className="bg-clip-text text-transparent"
              style={{ backgroundImage: 'linear-gradient(135deg, #7c3aed, #818cf8)' }}
            >
              Save hours every week.
            </span>
          </h1>

          <p className="text-slate-400 text-lg max-w-xl mx-auto mb-8">
            StatfloBot automates 1st, 2nd, and 3rd Attempt outreach directly inside
            your Statflo account — running locally on your machine, using your own session.
          </p>

          {/* Hero CTAs */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <a
              href="/auth/sign-up"
              className="px-6 py-3 rounded-xl text-white font-semibold text-sm transition-all"
              style={{ background: 'linear-gradient(135deg, #6366f1, #818cf8)' }}
            >
              Get started — from $10/mo
            </a>
            <a
              href="/download"
              className="px-6 py-3 rounded-xl text-sm font-medium transition-all border"
              style={{ background: 'transparent', color: '#94a3b8', borderColor: 'rgba(255,255,255,0.1)' }}
            >
              Download the app
            </a>
          </div>
        </div>

        {/* Features row */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-20">
          {[
            { icon: <Zap size={18} />, title: 'Fully automated', body: 'Smart list navigation, message sending, and DNC logging — all hands-free inside your own Statflo session.' },
            { icon: <ShieldCheck size={18} />, title: 'Safe & private', body: 'Delay profiles, dry-run mode, and error recovery built in. Your Statflo credentials never leave your machine.' },
            { icon: <Clock size={18} />, title: 'Runs on your machine', body: 'Install free, then sign in and activate a plan to unlock the bot. Runs locally on your Mac or PC — no cloud browser. Your Statflo credentials never leave your machine.' },
          ].map(({ icon, title, body }) => (
            <div
              key={title}
              className="rounded-2xl p-5 border"
              style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
            >
              <div className="mb-3" style={{ color: 'var(--accent-light)' }}>{icon}</div>
              <h3 className="text-white font-semibold mb-1">{title}</h3>
              <p className="text-slate-400 text-sm leading-relaxed">{body}</p>
            </div>
          ))}
        </div>

        {/* Canceled notice */}
        {canceledCheckout && (
          <p className="text-center text-sm text-slate-400 mb-8">
            Checkout was canceled — no charge was made.
          </p>
        )}

        {/* Pricing */}
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold text-white mb-3">Simple pricing</h2>
          {pricing.isEarlyAdopter && pricing.daysRemaining !== null && (
            <p className="text-sm font-medium" style={{ color: '#fbbf24' }}>
              Early adopter pricing ends in {pricing.daysRemaining} day
              {pricing.daysRemaining !== 1 ? 's' : ''}
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-3xl mx-auto">
          <PricingCard
            planCode="monthly"
            name="Monthly"
            priceCents={pricing.monthly_price_cents}
            billingType="monthly"
            features={[
              'Full 1st / 2nd / 3rd Attempt automation',
              'Local dashboard included',
              'Up to 2 registered devices',
              'Cancel any time',
            ]}
          />
          <div>
            <PricingCard
              planCode={pricing.lifetime_plan_code}
              name={pricing.lifetime_plan_name}
              priceCents={pricing.lifetime_price_cents}
              billingType="lifetime"
              featured
              badge={pricing.isEarlyAdopter ? 'Best value' : undefined}
              features={[
                'Everything in Monthly',
                'Pay once, use forever',
                'Up to 2 registered devices',
                'All future updates included',
              ]}
            />
            <EarlyBirdSpots initialData={pricing.earlyBird} />
          </div>
        </div>

        <p className="text-center text-xs text-slate-500 mt-10">
          Secure payment via Stripe · Support via email · Bot runs locally on your machine
        </p>

        <div className="text-center mt-6">
          <a href="/download" className="text-xs text-slate-600 hover:text-slate-400 transition-colors">
            Free installer for Mac &amp; Windows →
          </a>
        </div>
      </main>
    </div>
  );
}
