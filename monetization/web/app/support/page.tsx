import SiteNav from '@/components/SiteNav';
import SupportContactForm from '@/components/SupportContactForm';
import SupportFormGate from '@/components/SupportFormGate';
import TallyEmbed from '@/components/TallyEmbed';
import { LifeBuoy, Mail, ExternalLink } from 'lucide-react';

// ── Support form configuration ────────────────────────────────────────────────
//
// SUPPORT_FORM_URL controls which form experience is shown:
//
//   Tally embed  (recommended):
//     1. Go to https://tally.so → create a new form
//     2. Add fields: Name, Email, Subject, Message
//     3. In form settings → Notifications → add nickymccracken159@gmail.com
//     4. In Share → copy the form URL (e.g. https://tally.so/r/YOUR_FORM_ID)
//     5. Add to .env.local:
//          SUPPORT_FORM_URL=https://tally.so/r/YOUR_FORM_ID
//     6. Add to Vercel: Settings → Environment Variables → SUPPORT_FORM_URL
//
//   Other form service (Typeform, Google Forms, etc.):
//     - Set SUPPORT_FORM_URL to the form link; shown as an "Open form" button.
//
//   Not set:
//     - Inline contact form opens the user's email client with fields pre-filled.
//     - Zero setup required — works out of the box.
//
// ─────────────────────────────────────────────────────────────────────────────
const SUPPORT_FORM_URL = process.env.SUPPORT_FORM_URL ?? null;
const SUPPORT_EMAIL    = 'nickymccracken159@gmail.com';

// Detect Tally URLs so we can embed as iframe instead of just linking
const isTally  = !!SUPPORT_FORM_URL && SUPPORT_FORM_URL.includes('tally.so');

export const metadata = {
  title: 'Support — StatfloBot',
  description: 'Get help with StatfloBot — billing, access, and general questions.',
};

export default function SupportPage() {
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <SiteNav />

      <main className="max-w-3xl mx-auto px-6 py-24">

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
            StatfloBot support is handled personally.
          </p>
        </div>

        {/* ── Primary contact section ───────────────────────────────────────── */}
        <div className="space-y-4">

          <SupportFormGate>
            {isTally ? (
              /* ── Tally embedded form ──────────────────────────────────────── */
              <div
                className="rounded-2xl border overflow-hidden"
                style={{ borderColor: 'var(--border)' }}
              >
                <TallyEmbed src={`${SUPPORT_FORM_URL}?transparentBackground=1&hideTitle=1`} />
              </div>

            ) : SUPPORT_FORM_URL ? (
              /* ── External form link (Typeform / Google Forms / etc.) ─────── */
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
                    <p className="text-slate-500 text-xs mt-0.5">Describe your issue — usually a response within 24–48 hours</p>
                  </div>
                </div>
                <ExternalLink size={14} className="text-slate-600 group-hover:text-slate-400 transition-colors shrink-0" />
              </a>

            ) : (
              /* ── Inline contact form (mailto-based, zero backend needed) ─── */
              <div
                className="rounded-2xl border p-6"
                style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
              >
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-sm font-semibold text-white">Send us a message</h2>
                  <span className="text-xs text-slate-500">Usually responds in about 24–48 hours</span>
                </div>
                <SupportContactForm supportEmail={SUPPORT_EMAIL} />
              </div>
            )}
          </SupportFormGate>

          {/* Email always visible as secondary option */}
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
                <p className="text-white font-semibold text-sm">Email directly</p>
                <p className="text-slate-500 text-xs mt-0.5">{SUPPORT_EMAIL}</p>
              </div>
            </div>
            <ExternalLink size={14} className="text-slate-600 group-hover:text-slate-400 transition-colors shrink-0" />
          </a>
        </div>

        {/* Common questions */}
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
              <span><strong className="text-slate-300">Access not activated after payment</strong> — visit your <a href="/dashboard" className="underline hover:text-white transition-colors">dashboard</a> and click &ldquo;Refresh status&rdquo;. If it still shows inactive after 5 minutes, email us.</span>
            </li>
            <li className="flex items-start gap-2">
              <span style={{ color: 'var(--accent-light)' }} className="mt-0.5 shrink-0">·</span>
              <span><strong className="text-slate-300">Cancel your subscription</strong> — sign in and visit the <a href="/dashboard" className="underline hover:text-white transition-colors">dashboard</a>. Click &ldquo;Manage billing&rdquo; to cancel via Stripe. Access continues until the end of your current billing period.</span>
            </li>
            <li className="flex items-start gap-2">
              <span style={{ color: 'var(--accent-light)' }} className="mt-0.5 shrink-0">·</span>
              <span><strong className="text-slate-300">Bot not working or crashing</strong> — include the log output from the StatfloBot app and your OS version (Mac/Windows).</span>
            </li>
          </ul>
        </div>

        <p className="text-center text-xs text-slate-600 mt-8">
          Usually responds in about 24–48 hours · {SUPPORT_EMAIL}
        </p>

      </main>
    </div>
  );
}
