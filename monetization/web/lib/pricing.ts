import { createServiceClient } from './supabase/server';

export interface EarlyBirdStatus {
  cap:                  number;
  sold:                 number;
  remaining:            number;
  isEarlyBirdAvailable: boolean;
}

export interface PricingWindow {
  isEarlyAdopter:        boolean;
  daysRemaining:         number | null;
  monthly_price_cents:   number;
  lifetime_price_cents:  number;
  lifetime_plan_code:    'lifetime_early' | 'lifetime_standard';
  lifetime_plan_name:    string;
  earlyBird:             EarlyBirdStatus;
}

const EARLY_BIRD_CAP = 10;

/**
 * Standalone early-bird status from the early_bird_sales table.
 * Used by /api/early-bird and embedded in getPricingWindow.
 */
export async function getEarlyBirdStatus(): Promise<EarlyBirdStatus> {
  const supabase = createServiceClient();
  const { count } = await supabase
    .from('early_bird_sales')
    .select('*', { count: 'exact', head: true });

  const sold      = count ?? 0;
  const remaining = Math.max(0, EARLY_BIRD_CAP - sold);
  return { cap: EARLY_BIRD_CAP, sold, remaining, isEarlyBirdAvailable: remaining > 0 };
}

/**
 * Reads pricing_config and early_bird_sales from Supabase.
 * isEarlyAdopter is true only when BOTH the date window is active AND seats remain.
 *
 * BACKEND-ONLY. Frontend receives results from GET /api/pricing or /api/early-bird.
 */
export async function getPricingWindow(): Promise<PricingWindow> {
  const supabase = createServiceClient();

  const [{ data: cfg }, { count: earlyBirdCount }] = await Promise.all([
    supabase.from('pricing_config').select('*').eq('id', 1).single(),
    supabase.from('early_bird_sales').select('*', { count: 'exact', head: true }),
  ]);

  const launchDate        = cfg?.launch_date ? new Date(cfg.launch_date) : new Date();
  const earlyDays         = cfg?.early_adopter_days ?? 90;
  const earlyPriceCents   = cfg?.early_lifetime_price_cents ?? 5000;
  const stdPriceCents     = cfg?.standard_lifetime_price_cents ?? 10000;
  const monthlyPriceCents = cfg?.monthly_price_cents ?? 1000;

  const now         = new Date();
  const daysSince   = Math.floor((now.getTime() - launchDate.getTime()) / 86_400_000);
  const isDateEarly = daysSince < earlyDays;

  const sold      = earlyBirdCount ?? 0;
  const remaining = Math.max(0, EARLY_BIRD_CAP - sold);
  const earlyBird: EarlyBirdStatus = {
    cap: EARLY_BIRD_CAP,
    sold,
    remaining,
    isEarlyBirdAvailable: remaining > 0,
  };

  // Both conditions must hold: within the date window AND seats available
  const isEarly  = isDateEarly && earlyBird.isEarlyBirdAvailable;
  const daysLeft = isEarly ? earlyDays - daysSince : null;

  return {
    isEarlyAdopter:       isEarly,
    daysRemaining:        daysLeft,
    monthly_price_cents:  monthlyPriceCents,
    lifetime_price_cents: isEarly ? earlyPriceCents : stdPriceCents,
    lifetime_plan_code:   isEarly ? 'lifetime_early' : 'lifetime_standard',
    lifetime_plan_name:   isEarly ? 'Lifetime Early Adopter' : 'Lifetime Standard',
    earlyBird,
  };
}
