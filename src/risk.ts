import type { FlightStatus } from './flights.js';

export const DELAY_THRESHOLD_MIN = 120;

export interface Tier {
  id: 'basic' | 'plus';
  premiumUsd: string; // must match the x402 route price
  payoutUsd: number;
}

export const TIERS: Record<Tier['id'], Tier> = {
  basic: { id: 'basic', premiumUsd: '0.10', payoutUsd: 0.5 },
  plus: { id: 'plus', premiumUsd: '0.25', payoutUsd: 1.0 },
};

/**
 * Heuristic probability that a flight arrives >= DELAY_THRESHOLD_MIN late or is cancelled.
 * NOT an actuarial model: a flat base rate adjusted by departure hour and live provider signal.
 */
export function delayRisk(status: FlightStatus | null, scheduledHourUtc?: number): number {
  let p = 0.08;
  if (scheduledHourUtc !== undefined) {
    if (scheduledHourUtc >= 16) p += 0.05; // late-day knock-on delays
    else if (scheduledHourUtc <= 8) p -= 0.02;
  }
  if (status) {
    if (status.state === 'cancelled') return 1;
    if (status.arrivalDelayMin >= DELAY_THRESHOLD_MIN) return 1;
    p += Math.min(0.5, status.departureDelayMin / 240);
  }
  return Math.min(1, Math.max(0.02, p));
}

/** Premium = expected payout * loading, floored at the cheapest tier price. */
export function quotePremium(prob: number, payoutUsd: number, loading = 1.35): number {
  const raw = prob * payoutUsd * loading;
  return Math.round(Math.max(0.05, raw) * 100) / 100;
}

/** Pays only on a RESOLVED flight: provider estimates for an in-air flight are not facts. */
export function claimEligible(status: FlightStatus): { eligible: boolean; reason: string } {
  if (status.state === 'cancelled') return { eligible: true, reason: 'flight cancelled' };
  if (status.state !== 'landed' && status.state !== 'diverted')
    return { eligible: false, reason: `flight not yet resolved (state: ${status.state})` };
  if (status.arrivalDelayMin >= DELAY_THRESHOLD_MIN)
    return { eligible: true, reason: `arrival delay ${status.arrivalDelayMin} min >= ${DELAY_THRESHOLD_MIN} min` };
  return { eligible: false, reason: `arrival delay ${status.arrivalDelayMin} min below threshold` };
}
