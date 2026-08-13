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
          {/* Keep in sync with TERMS_VERSION in monetization/web/lib/referrals.ts —
              that value is recorded in Stripe metadata with every lifetime purchase. */}
          <p className="text-sm" style={{ color: '#475569' }}>Last updated: August 12, 2026</p>
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

          <Section title="Lifetime Purchases Are Final">
            <p>
              Lifetime purchases are final and non-refundable, except where a refund is required by
              applicable law. You are asked to confirm this before payment, and the confirmation is
              recorded with your order.
            </p>
            <p>
              This does not limit any rights you may have under consumer protection law, and it does not
              affect your ability to raise a concern with us, with your bank, or with your card issuer.
              Nothing in these terms prevents you from disputing a charge.
            </p>
            <p>
              If StatfloBot is not working for you, please contact support before anything else — we will
              make a genuine effort to resolve technical problems, and that support commitment stands
              regardless of the refund policy above.
            </p>
          </Section>

          <Section title="Monthly Subscriptions">
            <p>
              Monthly subscriptions are unchanged: you may cancel at any time from the billing portal, and
              access continues until the end of the period you have already paid for. The final-sale policy
              above applies only to one-time lifetime purchases.
            </p>
          </Section>

          <Section title="Referral Program">
            <p>
              Lifetime customers may receive a single referral code. Codes are issued only to accounts with a
              verified, active lifetime purchase, and each eligible customer may hold one code.
            </p>
            <p>
              A referral code must be applied before a new customer&apos;s lifetime checkout begins. Codes
              cannot be applied afterwards, cannot be added to a completed purchase, and cannot be applied
              retroactively for any reason. Referral codes apply to lifetime purchases only and have no
              effect on monthly subscriptions.
            </p>
            <p>
              A referral is eligible only when the referred customer is new — with no prior monthly or
              lifetime purchase — and is not the referrer themselves. Each eligible completed lifetime
              purchase earns the reward rate shown in the referrer&apos;s account when that purchase
              completes. Referred customers do not receive a discount.
            </p>
            <p>
              Reward rates are based on qualified, non-reversed referrals and the verified lifetime plan
              purchased. While early-adopter pricing is active, referrals 1–3 earn $10.00 each, 4–5 earn
              $15.00 each, and referral 6 and later earn $20.00 each. At standard lifetime pricing,
              referrals 1–3 earn $15.00 each, 4–5 earn $20.00 each, and referral 6 and later earn $25.00
              each. A reward is also limited to 40% of the referred lifetime purchase&apos;s net product
              amount after discounts and excluding tax or shipping, and no individual reward can exceed
              $25.00. The exact reward is locked when the purchase completes and prior rewards are never
              retroactively repriced. A refund
              or chargeback lowers the qualified count used for future rewards but does not rewrite
              earlier reward amounts.
            </p>
            <p>
              Rewards are held for 30 days after the referred purchase before becoming payable. If a referred
              purchase is refunded or charged back, the associated reward is reversed. If the reward had
              already been paid out, the reversal is applied against future rewards.
            </p>
            <p>
              Approved payouts use payout details you provide directly through Stripe&apos;s hosted onboarding.
              We never collect or store your bank details. The minimum eligible payout is $10.00. Payouts are not
              automatic: every one is reviewed and approved by a person before it is sent, and we do not
              commit to a fixed payment schedule.
            </p>
            <p>
              If someone applies your code at checkout, your dashboard shows that a referral was started and
              whether it has been paid for. It never shows who the customer is — not their name, email or
              account. Applying a code earns nothing on its own; a reward exists only once the referred
              purchase is completed and paid.
            </p>
            <p>
              Referral rewards may be taxable income. You are responsible for any tax you owe and for determining
              the applicable reporting or payment requirements. We may request tax information or report amounts
              when the law requires it.
            </p>
            <p>
              We may withhold or reverse rewards, and disable a referral code, where we identify self-referral,
              duplicate or fabricated accounts, or other abuse of the program. The referral program may be
              changed or discontinued at any time; rewards already earned and eligible at that point remain
              payable.
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
