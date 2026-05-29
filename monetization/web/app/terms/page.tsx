import SiteNav from '@/components/SiteNav';

export const metadata = { title: 'Terms of Use — StatfloBot' };

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

export default function TermsPage() {
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <SiteNav />

      <main className="max-w-3xl mx-auto px-6 pt-20 pb-24">
        <div className="mb-12">
          <p className="text-xs font-medium tracking-widest uppercase mb-3" style={{ color: '#4c1d95' }}>Legal</p>
          <h1 className="text-3xl font-bold text-white mb-2">Terms of Use</h1>
          <p className="text-sm" style={{ color: '#475569' }}>Last updated: May 2025</p>
        </div>

        <div
          className="rounded-2xl p-8 border"
          style={{ background: 'rgba(13,10,25,0.6)', borderColor: 'rgba(255,255,255,0.07)' }}
        >

          <Section title="About StatfloBot">
            <p>
              StatfloBot is an independent third-party desktop automation tool. It is not affiliated with,
              endorsed by, sponsored by, or officially connected to Statflo, Verizon, Cellular Sales, Okta,
              or any related companies. All trademarks are property of their respective owners.
            </p>
          </Section>

          <Section title="Third-Party Platform Dependency">
            <p>
              StatfloBot automates workflows within the Statflo platform using your existing login credentials.
              It depends on Statflo&apos;s interface, authentication systems, and other third-party platforms
              remaining consistent. These systems may change, update, or restrict access without notice.
            </p>
            <p>
              Updates, compatibility fixes, and bug fixes are provided on a best-effort basis only.
              Continuous operation, permanent compatibility, uninterrupted access, or indefinite maintenance
              are not guaranteed.
            </p>
            <p>
              If Statflo or related systems update in a way that breaks automation, the ability to resolve it
              may depend on available logs, user-submitted reports, screenshots, and continued developer access.
              Loss of developer platform access or testing access may affect troubleshooting speed, update quality,
              or the ability to restore compatibility.
            </p>
          </Section>

          <Section title="Product Changes & Discontinuation">
            <p>
              StatfloBot may be modified, paused, discontinued, or sunsetted at any time. While the intent is
              to maintain and improve the product for as long as reasonably possible, no guarantee of continued
              availability is made.
            </p>
          </Section>

          <Section title="Your Responsibilities">
            <p>
              You are responsible for ensuring that your use of StatfloBot complies with your employer&apos;s
              policies, Statflo&apos;s terms of service, any applicable carrier or platform policies, and all
              applicable laws and regulations. You assume full responsibility for using automation tools within
              your own Statflo account and workflow.
            </p>
          </Section>

          <Section title="No Warranties">
            <p>
              StatfloBot is provided &quot;as is&quot; and &quot;as available&quot; without warranties of any kind,
              either express or implied. We make no warranty that the software will be error-free, uninterrupted,
              or compatible with any particular platform version.
            </p>
          </Section>

          <Section title="Limitation of Liability">
            <p>
              To the fullest extent permitted by law, the maximum liability of StatfloBot and its developer
              for any claim arising from your use of the product is limited to the amount you paid for the
              product. We are not liable for indirect, incidental, or consequential damages of any kind.
            </p>
          </Section>

          <Section title="Refund Policy">
            <p>
              Refund requests are evaluated on a case-by-case basis. If you experience a significant technical
              issue that cannot be resolved, please reach out to support within 14 days of purchase.
              Refunds are not guaranteed but are considered in good faith. This policy may be updated.
            </p>
          </Section>

          <Section title="Contact">
            <p>
              Questions about these terms?{' '}
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
