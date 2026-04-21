import { Apple, Monitor, Download, ShieldCheck, Cpu, Globe } from 'lucide-react';

export const metadata = {
  title: 'Download StatfloBot — Free installer for Mac & Windows',
  description: 'Download the StatfloBot desktop app. Free to install. Sign in and activate a plan to run the bot.',
};

// ── Platform config ────────────────────────────────────────────────────────────
// Links point to /api/download?platform=... which issues a 302 redirect to
// the correct GitHub Release asset. No auth required.
const PLATFORMS = [
  {
    id:    'mac-apple-silicon',
    label: 'Mac — Apple Silicon',
    sub:   'M1 / M2 / M3 / M4  ·  macOS 12 or later  ·  .dmg',
    hint:  'Not sure? Apple menu → About This Mac. Look for "Apple M" in the chip line.',
    Icon:  Apple,
  },
  {
    id:    'mac-intel',
    label: 'Mac — Intel',
    sub:   'Older Intel Macs  ·  macOS 12 or later  ·  .dmg',
    hint:  'Processor says "Intel Core" in About This Mac.',
    Icon:  Apple,
  },
  {
    id:    'windows',
    label: 'Windows',
    sub:   'Windows 10 or later  ·  .exe installer',
    hint:  null,
    Icon:  Monitor,
  },
];

// ── Components ─────────────────────────────────────────────────────────────────

function DownloadCard({ platform }: { platform: typeof PLATFORMS[0] }) {
  const { id, label, sub, hint, Icon } = platform;

  return (
    <a
      href={`/api/download?platform=${id}`}
      className="group flex items-center gap-4 px-6 py-5 rounded-2xl border transition-all duration-150 text-left no-underline bg-[rgba(99,102,241,0.06)] border-[rgba(99,102,241,0.18)] hover:bg-[rgba(99,102,241,0.12)] hover:border-[rgba(99,102,241,0.4)]"
    >
      <div
        className="flex-shrink-0 w-12 h-12 rounded-xl flex items-center justify-center"
        style={{ background: 'rgba(99,102,241,0.12)' }}
      >
        <Icon size={22} style={{ color: '#818cf8' }} />
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold" style={{ color: '#e2e8f0' }}>{label}</p>
        <p className="text-xs mt-0.5" style={{ color: '#475569' }}>{sub}</p>
        {hint && (
          <p className="text-xs mt-1" style={{ color: '#334155' }}>{hint}</p>
        )}
      </div>

      <Download size={16} style={{ color: '#475569', flexShrink: 0 }} />
    </a>
  );
}

function FactRow({ icon: Icon, text }: { icon: React.ElementType; text: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <Icon size={14} style={{ color: '#818cf8', marginTop: 2, flexShrink: 0 }} />
      <p className="text-sm leading-relaxed" style={{ color: '#94a3b8' }}>{text}</p>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function DownloadPage() {
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>

      {/* Nav */}
      <nav className="border-b border-white/5 px-6 py-4 flex items-center justify-between max-w-6xl mx-auto">
        <a href="/" className="text-white font-semibold text-lg tracking-tight" style={{ textDecoration: 'none' }}>
          Statflo<span style={{ color: 'var(--accent)' }}>Bot</span>
        </a>
        <div className="flex items-center gap-3">
          <a href="/download" className="text-sm font-medium transition-colors" style={{ color: '#818cf8', textDecoration: 'none' }}>
            Download
          </a>
          <a href="/auth/sign-in" className="text-sm text-slate-400 hover:text-white transition-colors" style={{ textDecoration: 'none' }}>
            Sign in
          </a>
          <a
            href="/auth/sign-up"
            className="text-sm px-4 py-2 rounded-lg text-white font-medium transition-all"
            style={{ background: 'var(--accent)', textDecoration: 'none' }}
          >
            Get started
          </a>
        </div>
      </nav>

      <main className="max-w-3xl mx-auto px-6 py-20">

        {/* Header */}
        <div className="text-center mb-14">
          <div
            className="inline-flex w-16 h-16 rounded-2xl items-center justify-center mb-6"
            style={{ background: 'linear-gradient(135deg, #4f46e5, #6366f1)', boxShadow: '0 0 40px rgba(99,102,241,0.3)' }}
          >
            <Download size={28} color="white" />
          </div>

          <h1 className="text-4xl font-bold text-white mb-4 tracking-tight">
            Download StatfloBot
          </h1>
          <p className="text-slate-400 text-lg max-w-xl mx-auto leading-relaxed">
            Free to download and install. Sign in and activate a plan to unlock the bot.
          </p>
        </div>

        {/* Download cards */}
        <section className="mb-10">
          <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: '#334155' }}>
            Mac
          </p>
          <div className="flex flex-col gap-3 mb-8">
            <DownloadCard platform={PLATFORMS[0]} />
            <DownloadCard platform={PLATFORMS[1]} />
          </div>

          <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: '#334155' }}>
            Windows
          </p>
          <div className="flex flex-col gap-3">
            <DownloadCard platform={PLATFORMS[2]} />
          </div>
        </section>

        {/* How it works */}
        <div
          className="rounded-2xl p-6 border mb-10"
          style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.07)' }}
        >
          <h2 className="text-sm font-semibold text-white mb-4">How it works</h2>
          <div className="flex flex-col gap-3">
            <FactRow icon={Download}    text="The installer is free — download and install with no account required." />
            <FactRow icon={ShieldCheck} text="Open the app, create a free account, and subscribe to unlock the bot." />
            <FactRow icon={Cpu}         text="The bot runs locally on your machine using your own Statflo login session." />
            <FactRow icon={Globe}       text="Your account, billing, and license are managed securely online. Your Statflo credentials never leave your machine." />
          </div>
        </div>

        {/* CTA */}
        <div className="text-center">
          <p className="text-sm text-slate-500 mb-4">
            Don&apos;t have an account yet?
          </p>
          <a
            href="/auth/sign-up"
            className="inline-block px-8 py-3 rounded-xl text-white font-semibold text-sm transition-all"
            style={{ background: 'linear-gradient(135deg, #6366f1, #818cf8)', textDecoration: 'none' }}
          >
            Create a free account
          </a>
          <p className="text-xs mt-4" style={{ color: '#334155' }}>
            Secure payment via Stripe · Cancel monthly plans any time
          </p>
        </div>
      </main>
    </div>
  );
}
