import { NextResponse } from 'next/server';
import { getEarlyBirdStatus } from '@/lib/pricing';

/**
 * GET /api/early-bird
 * Returns real-time early-bird seat availability.
 * Read-only — no auth required.
 */
export async function GET() {
  const status = await getEarlyBirdStatus();
  return NextResponse.json(status, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
