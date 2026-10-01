import test from 'node:test';
import assert from 'node:assert/strict';
import { claimEligible, delayRisk, quotePremium } from './risk.js';
import { parseAeroDataBox, parseAviationstack, rebaseArrivalDelay, delayMinutes, type FlightStatus } from './flights.js';

const base: FlightStatus = {
  flight: 'BA75', date: '2026-10-05', state: 'landed', departureDelayMin: 0, arrivalDelayMin: 0,
  origin: null, destination: null, scheduledDeparture: null, scheduledArrival: null, arrivalActual: null,
  source: 'aerodatabox', fetchedAt: '',
};

test('cancelled flight is certain + eligible', () => {
  const s = { ...base, state: 'cancelled' as const };
  assert.equal(delayRisk(s), 1);
  assert.equal(claimEligible(s).eligible, true);
});
test('120 min arrival delay is eligible, 119 is not (landed)', () => {
  assert.equal(claimEligible({ ...base, arrivalDelayMin: 120 }).eligible, true);
  assert.equal(claimEligible({ ...base, arrivalDelayMin: 119 }).eligible, false);
});
test('in-air flight is never eligible, even if the estimate is already 120+ min late', () => {
  assert.equal(claimEligible({ ...base, state: 'active', arrivalDelayMin: 200 }).eligible, false);
});
test('premium is floored and priced above expected payout', () => {
  assert.ok(quotePremium(0.1, 1) >= 0.05);
  assert.ok(quotePremium(0.2, 1) > 0.2);
});

// ---- provider parsing (fixtures mirror AeroDataBox's flight-status response shape) ----
const adb = (over: any = {}) => ({
  number: 'BA 75', status: 'Arrived', codeshareStatus: 'IsOperator',
  departure: {
    airport: { iata: 'LHR' },
    scheduledTime: { utc: '2026-10-05 08:00Z', local: '2026-10-05 09:00+01:00' },
    runwayTime: { utc: '2026-10-05 08:20Z' },
  },
  arrival: {
    airport: { iata: 'JFK' },
    scheduledTime: { utc: '2026-10-05 16:00Z', local: '2026-10-05 12:00-04:00' },
    runwayTime: { utc: '2026-10-05 18:10Z' },
  },
  ...over,
});

test('aerodatabox: delay is computed from timestamps', () => {
  const s = parseAeroDataBox([adb()], 'BA75', '2026-10-05')!;
  assert.equal(s.state, 'landed');
  assert.equal(s.departureDelayMin, 20);
  assert.equal(s.arrivalDelayMin, 130);
  assert.equal(s.origin, 'LHR');
  assert.equal(s.destination, 'JFK');
  assert.equal(claimEligible(s).eligible, true);
});
test('aerodatabox: empty result is null (flight not found)', () => {
  assert.equal(parseAeroDataBox([], 'BA75', '2026-10-05'), null);
});
test('aerodatabox: uncertain cancellation never pays', () => {
  const s = parseAeroDataBox([adb({ status: 'CanceledUncertain' })], 'BA75', '2026-10-05')!;
  assert.equal(s.state, 'unknown');
  assert.equal(claimEligible(s).eligible, false);
});
test('aerodatabox: operating carrier on the requested date wins over codeshare/other days', () => {
  const other = adb({ codeshareStatus: 'IsCodeshared', status: 'Canceled' });
  const wrongDay = adb({ departure: { ...adb().departure, scheduledTime: { utc: '2026-10-04 08:00Z', local: '2026-10-04 09:00+01:00' } } });
  const s = parseAeroDataBox([other, wrongDay, adb()], 'BA75', '2026-10-05')!;
  assert.equal(s.state, 'landed');
});
test('re-timed schedule cannot erase a claim: delay is re-based on the insured arrival', () => {
  // Airline later re-times scheduled arrival to 18:00, making the provider-reported delay 10 min.
  const retimed = parseAeroDataBox([adb({ arrival: { ...adb().arrival, scheduledTime: { utc: '2026-10-05 18:00Z', local: 'x' } } })], 'BA75', '2026-10-05')!;
  assert.equal(retimed.arrivalDelayMin, 10);
  const rebased = rebaseArrivalDelay(retimed, '2026-10-05T16:00:00.000Z');
  assert.equal(rebased.arrivalDelayMin, 130);
  assert.equal(claimEligible(rebased).eligible, true);
});
test('aviationstack: parses and prefers non-codeshare record on the date', () => {
  const body = { data: [
    { flight_date: '2026-10-05', flight_status: 'cancelled', flight: { codeshared: { airline_iata: 'x' } }, departure: {}, arrival: {} },
    { flight_date: '2026-10-05', flight_status: 'landed', flight: {}, departure: { iata: 'LHR', scheduled: '2026-10-05T08:00:00+00:00', actual: '2026-10-05T08:05:00+00:00' }, arrival: { iata: 'JFK', scheduled: '2026-10-05T16:00:00+00:00', actual: '2026-10-05T18:30:00+00:00' } },
  ] };
  const s = parseAviationstack(body, 'BA75', '2026-10-05')!;
  assert.equal(s.state, 'landed');
  assert.equal(s.arrivalDelayMin, 150);
});
test('delayMinutes never goes negative (early arrival)', () => {
  assert.equal(delayMinutes('2026-10-05T16:00:00Z', '2026-10-05T15:40:00Z'), 0);
});
