import SiteNav from '@/components/SiteNav';

export const metadata = { title: 'Privacy Policy — StatfloBot' };

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

export default function PrivacyPage() {
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <SiteNav />

      <main className="max-w-3xl mx-auto px-6 pt-20 pb-24">
        <div className="mb-12">
          <p className="text-xs font-medium tracking-widest uppercase mb-3" style={{ color: '#4c1d95' }}>Legal</p>
          <h1 className="text-3xl font-bold text-white mb-2">Privacy Policy</h1>
          <p className="text-sm" style={{ color: '#475569' }}>Last updated: May 2025</p>
        </div>

        <div
          className="rounded-2xl p-8 border"
          style={{ background: 'rgba(13,10,25,0.6)', borderColor: 'rgba(255,255,255,0.07)' }}
        >

          <Section title="How StatfloBot Works">
            <p>
              StatfloBot is a local desktop application. The core automation — navigating Statflo and
              sending messages — runs entirely on your machine. Your Statflo session stays inside the
              embedded app window and does not pass through any StatfloBot servers.
            </p>
          </Section>

          <Section title="Credentials & Login">
            <p>
              You sign into Statflo and Okta directly through the embedded browser inside the app —
              the same way you normally would. StatfloBot does not collect, intercept, or store your
              Statflo or Okta credentials.
            </p>
          </Section>

          <Section title="Account & License Data">
            <p>
              StatfloBot requires a user account to manage licensing and authentication. Account data
              (email address, license status, payment status) is stored securely through our backend
              infrastructure. Payment processing is handled by Stripe — we do not store payment card data.
            </p>
          </Section>

          <Section title="Support Reports & Logs">
            <p>
              The app includes built-in tools to generate run logs and support reports. These are only
              sent if you choose to send them. Logs may contain operational details about the run — such as
              timing, step results, or error messages — to help with debugging. Review the contents before
              sending if you have concerns about what they contain.
            </p>
          </Section>

          <Section title="Data We Do Not Sell">
            <p>
              We do not sell, rent, or share your personal data with third parties for marketing purposes.
            </p>
          </Section>

          <Section title="Third-Party Services">
            <p>The following third-party services are used:</p>
            <ul className="list-disc list-inside space-y-1 pl-2">
              <li><strong className="text-slate-300">Stripe</strong> — payment processing</li>
              <li><strong className="text-slate-300">Supabase</strong> — account and license data storage</li>
            </ul>
            <p className="mt-3">
              Each of these services has its own privacy policy governing their use of data.
            </p>
          </Section>

          <Section title="Contact">
            <p>
              Privacy questions?{' '}
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
