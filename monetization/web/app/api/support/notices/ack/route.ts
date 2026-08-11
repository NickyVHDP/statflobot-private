import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';
import { isValidReportReference } from '@/lib/supportReports';

/**
 * POST /api/support/notices/ack   body: { reference }
 *
 * Marks a resolution notice as seen so it does not reappear on this or any
 * other computer the customer signs into.
 *
 * Idempotent, and deliberately opaque: an unknown reference, another account's
 * reference, and an already-acknowledged reference all return the same 200. A
 * distinguishable response would turn this endpoint into an existence oracle
 * for other customers' report references.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Request body was not valid JSON.' }, { status: 400 });
  }

  const reference = String(body?.reference ?? '').trim();
  if (!isValidReportReference(reference)) {
    return NextResponse.json({ ok: false, error: 'A valid report reference is required.' }, { status: 400 });
  }

  const svc = createServiceClient();
  const { error } = await svc
    .from('support_reports')
    .update({ acknowledged_at: new Date().toISOString() })
    .eq('user_id', user.id)
    .eq('reference', reference)
    .eq('status', 'resolved')
    .is('acknowledged_at', null);

  if (error) {
    // A failed ack must be retriable, so this is the one case that is not 200.
    console.error(`[api/support/notices/ack] update failed userId=${user.id}: ${error.message}`);
    return NextResponse.json({ ok: false, error: 'Could not save your acknowledgement.' }, { status: 500 });
  }

  console.log(`[SUPPORT_NOTICE_ACKNOWLEDGED] user=${user.id} ref=${reference}`);
  return NextResponse.json({ ok: true, acknowledged: true });
}
