import SiteNav from '@/components/SiteNav';
import { LifeBuoy, Mail, ExternalLink } from 'lucide-react';

// SUPPORT_FORM_URL: set this env var to your Tally / Typeform / Google Form URL.
// Falls back to mailto: if not set.
const SUPPORT_FORM_URL = process.env.SUPPORT_FORM_URL ?? null;
const SUPPORT_EMAIL    = 'nickymccracken159@gmail.com';

export const metadata = {
  title: 'Support — StatfloBot',
  description: 'Get help with StatfloBot — billing, access, and general questions.',
};

export default function SupportPage() {
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <SiteNav />

      <main className="max-w-2xl mx-auto px-6 py-24">

        {/* Header */}
        <div className="text-center mb-12">
          <div
            className="inline-flex items-center justify-center w-14 h-14 rounded-2xl mb-5"
            style={{ background: 'rgba(124,58,237,0.15)', color: '#a78bfa' }}
          >
            <LifeBuoy size={26} />
          </div>
          <h1 className="text-3xl font-bold text-white mb-3">How can we help?</h1>
          <p className="text-slate-400 text-base max-w-md mx-auto">
            StatfloBot support is handled personally. Expect a response within 1 business day.
          </p>
        </div>

        {/* Support options */}
        <div className="space-y-4">

          {/* Primary: support form */}
          {SUPPORT_FORM_URL ? (
            <a
              href={SUPPORT_FORM_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between w-full p-5 rounded-2xl border transition-all hover:border-violet-500/50 group"
              style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
            >
              <div className="flex items-center gap-4">
                <div
                  className="flex items-center justify-center w-10 h-10 rounded-xl shrink-0"
                  style={{ background: 'rgba(124,58,237,0.15)', color: '#a78bfa' }}
                >
                  <ExternalLink size={18} />
                </div>
                <div>
                  <p className="text-white font-semibold text-sm">Open support form</p>
                  <p className="text-slate-500 text-xs mt-0.5">Describe your issue — we respond within 1 business day</p>
                </div>
              </div>
              <ExternalLink size={14} className="text-slate-600 group-hover:text-slate-400 transition-colors shrink-0" />
            </a>
          ) : (
            /* Fallback if SUPPORT_FORM_URL is not set */
            <div
              className="p-5 rounded-2xl border"
              style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
            >
              <p className="text-sm text-slate-400">
                A support form is coming soon. In the meantime, please email us directly below.
              </p>
            </div>
          )}

          {/* Email fallback */}
          <a
            href={`mailto:${SUPPORT_EMAIL}?subject=StatfloBot%20Support`}
            className="flex items-center justify-between w-full p-5 rounded-2xl border transition-all hover:border-violet-500/50 group"
            style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
          >
            <div className="flex items-center gap-4">
              <div
                className="flex items-center justify-center w-10 h-10 rounded-xl shrink-0"
                style={{ background: 'rgba(99,102,241,0.1)', color: '#818cf8' }}
              >
                <Mail size={18} />
              </div>
              <div>
                <p className="text-white font-semibold text-sm">Email support</p>
                <p className="text-slate-500 text-xs mt-0.5">{SUPPORT_EMAIL}</p>
              </div>
            </div>
            <ExternalLink size={14} className="text-slate-600 group-hover:text-slate-400 transition-colors shrink-0" />
          </a>

        </div>

        {/* Common topics */}
        <div
          className="mt-10 rounded-2xl p-6 border"
          style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
        >
          <h2 className="text-sm font-semibold text-white mb-4">Common questions</h2>
          <ul className="space-y-3 text-sm text-slate-400">
            <li className="flex items-start gap-2">
              <span style={{ color: 'var(--accent-light)' }} className="mt-0.5 shrink-0">·</span>
              <span><strong className="text-slate-300">Billing or subscription issue</strong> — include your account email and the plan you signed up for.</span>
            </li>
            <li className="flex items-start gap-2">
              <span style={{ color: 'var(--accent-light)' }} className="mt-0.5 shrink-0">·</span>
              <span><strong className="text-slate-300">Access not activated after payment</strong> — visit your <a href="/dashboard" className="underline hover:text-white transition-colors">dashboard</a> and click "Refresh status". If it still shows inactive after 5 minutes, email us.</span>
            </li>
            <li className="flex items-start gap-2">
              <span style={{ color: 'var(--accent-light)' }} className="mt-0.5 shrink-0">·</span>
              <span><strong className="text-slate-300">Cancel your subscription</strong> — sign in and visit the <a href="/dashboard" className="underline hover:text-white transition-colors">dashboard</a>. Click "Manage billing" to cancel via Stripe. Access continues until the end of your current billing period.</span>
            </li>
            <li className="flex items-start gap-2">
              <span style={{ color: 'var(--accent-light)' }} className="mt-0.5 shrink-0">·</span>
              <span><strong className="text-slate-300">Bot not working or crashing</strong> — include the log output from the StatfloBot app and your OS version (Mac/Windows).</span>
            </li>
          </ul>
        </div>

        <p className="text-center text-xs text-slate-600 mt-8">
          Response time: 1 business day · {SUPPORT_EMAIL}
        </p>

      </main>
    </div>
  );
}
