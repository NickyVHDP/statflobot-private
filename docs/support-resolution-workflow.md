# Support resolution workflow

This feature keeps diagnostic logs private while giving a customer a clear end
to their support request.

1. A signed-in customer submits a report. The existing support email still
   carries the diagnostic log; the cloud stores only ticket and attachment
   metadata, never the log body.
2. The owner reviews the report under the desktop Admin panel.
3. Publish and verify the desktop release containing the fix.
4. Set `PUBLIC_APP_VERSION` in the Vercel production environment to that exact
   released version and redeploy the web service.
5. In the Admin panel, enter the customer-safe explanation and released version,
   then choose **Resolve & notify customer**.
6. The server verifies that `fixed_in_version <= PUBLIC_APP_VERSION`, records
   the resolution, sends one idempotent branded email to the verified account
   email, and queues one private in-app notice.

`SUPPORT_CUSTOMER_EMAIL_MODE=dry-run` is an emergency production kill switch.
Outside production, customer resolution email defaults to dry-run. Tests and
local development must never set it to `live`.

The Supabase migration must be applied before deploying the web routes. Deploy
the web service before publishing the desktop build so old clients can continue
submitting reports while new clients gain notices. Do not resolve a report until
the fixed desktop release is public and `PUBLIC_APP_VERSION` is current.
