import { NextResponse } from 'next/server';
import { getPricingWindow } from '@/lib/pricing';

/**
 * GET /api/pricing
 * Returns current pricing window — enforced by backend, not client date logic.
 */
export async function GET() {
  try {
    const pricing = await getPricingWindow();
    return NextResponse.json(pricing);
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to load pricing' }, { status: 500 });
  }
}
