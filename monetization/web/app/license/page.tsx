import SiteNav from '@/components/SiteNav';

export const metadata = { title: 'License — StatfloBot' };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-10">
      <h2 className="text-lg font-semibold text-white mb-3">{title}</h2>
      <div className="text-sm leading-relaxed space-y-3" style={{ color: '#94a3b8' }}>
        {children}
      </div>
    </div>
  );
}

export default function LicensePage() {
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <SiteNav />

      <main className="max-w-3xl mx-auto px-6 pt-20 pb-24">
        <div className="mb-12">
          <p className="text-xs font-medium tracking-widest uppercase mb-3" style={{ color: '#4c1d95' }}>Legal</p>
          <h1 className="text-3xl font-bold text-white mb-2">License Agreement</h1>
          <p className="text-sm" style={{ color: '#475569' }}>Last updated: May 2025</p>
        </div>

        <div
          className="rounded-2xl p-8 border"
          style={{ background: 'rgba(13,10,25,0.6)', borderColor: 'rgba(255,255,255,0.07)' }}
        >

          <Section title="License Grant">
            <p>
              When you purchase a StatfloBot subscription or lifetime license, you receive a limited,
              non-exclusive, non-transferable license to install and use the software on your own devices
              for your own personal or professional use.
            </p>
          </Section>

          <Section title="Restrictions">
            <p>You may not:</p>
            <ul className="list-disc list-inside space-y-1 pl-2">
              <li>Resell, redistribute, or sublicense StatfloBot to any third party</li>
              <li>Reverse engineer, decompile, or attempt to extract source code</li>
              <li>Copy or modify the software beyond normal use</li>
              <li>Share account credentials or license access with others not covered by your plan</li>
            </ul>
            <p className="mt-3">
              The license is issued to the purchasing account only. Multi-seat or team use requires
              separate arrangements.
            </p>
          </Section>

          <Section title="What &quot;Lifetime&quot; Means">
            <p>
              A &quot;Lifetime&quot; license grants you one-time access to StatfloBot for as long as the
              product remains actively maintained and supported. It means no recurring subscription fees
              and access to updates released during the supported period.
            </p>
            <p>
              &quot;Lifetime&quot; does not mean guaranteed-forever compatibility, guaranteed-forever updates,
              or guaranteed-forever operation. StatfloBot depends on third-party platforms that may change
              independently, and long-term compatibility cannot be guaranteed.
            </p>
          </Section>

          <Section title="Updates">
            <p>
              Updates are released at developer discretion, based on compatibility needs, platform changes,
              and product improvements. Updates are not guaranteed at any specific frequency.
            </p>
          </Section>

          <Section title="License Revocation">
            <p>
              Access may be revoked without refund for violations of these terms, including but not limited to:
            </p>
            <ul className="list-disc list-inside space-y-1 pl-2">
              <li>Sharing, reselling, or redistributing your license</li>
              <li>Initiating chargebacks or fraudulent payment disputes</li>
              <li>Abusive behavior toward support</li>
              <li>Any other material violation of these terms</li>
            </ul>
          </Section>

          <Section title="Contact">
            <p>
              Licensing questions?{' '}
              <a href="/support" className="underline underline-offset-2 hover:text-white transition-colors">
                Contact support
              </a>.
            </p>
          </Section>

        </div>

        <div className="mt-8 flex flex-wrap gap-x-4 gap-y-1 text-xs justify-center" style={{ color: '#2d2a3e' }}>
          <a href="/terms" className="hover:text-slate-500 transition-colors">Terms</a>
          <a href="/license" className="hover:text-slate-500 transition-colors">License</a>
          <a href="/privacy" className="hover:text-slate-500 transition-colors">Privacy</a>
          <a href="/support" className="hover:text-slate-500 transition-colors">Support</a>
        </div>
      </main>
    </div>
  );
}
