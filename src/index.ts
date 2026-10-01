import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { HTTPFacilitatorClient } from '@x402/core/server';
import type { ResourceServerExtension } from '@x402/core/types';
import { ExactAvmScheme } from '@x402/avm/exact/server';
import {
  ALGORAND_MAINNET_CAIP2,
  ALGORAND_TESTNET_CAIP2,
  USDC_MAINNET_ASA_ID,
  USDC_TESTNET_ASA_ID,
} from '@x402/avm';
import { declareDiscoveryExtension, bazaarResourceServerExtension } from '@x402-avm/extensions';
import algosdk from 'algosdk';
import { getFlightStatus, normalizeFlight, validDate, rebaseArrivalDelay, providerConfigError, providerName } from './flights.js';
import { claimEligible, delayRisk, quotePremium, TIERS, DELAY_THRESHOLD_MIN } from './risk.js';
import { getPolicy, savePolicy, stats, type Policy } from './store.js';
import { payoutsEnabled, sendUsdc } from './payout.js';
import { attest } from './attest.js';

config();

const payToEnv = process.env.AVM_ADDRESS;
const facilitatorUrl = process.env.FACILITATOR_URL ?? 'https://facilitator.goplausible.xyz';
const mainnet = (process.env.NETWORK ?? 'testnet') === 'mainnet';
if (!payToEnv) {
  console.error('Missing AVM_ADDRESS (the USDC-opted-in address that receives payments)');
  process.exit(1);
}

const payTo: string = payToEnv;
const network = (mainnet ? ALGORAND_MAINNET_CAIP2 : ALGORAND_TESTNET_CAIP2) as `${string}:${string}`;
const asset = mainnet ? USDC_MAINNET_ASA_ID : USDC_TESTNET_ASA_ID;
const providerErr = providerConfigError();
if (providerErr) {
  console.error(providerErr);
  process.exit(1);
}

const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitatorUrl }));
server.register(network, new ExactAvmScheme());
server.registerExtension(bazaarResourceServerExtension as unknown as ResourceServerExtension);

/** One paid route. All routes share the same payTo + domain => a single Composite entry. */
function route(price: string, description: string, example: unknown) {
  return {
    accepts: [
      {
        scheme: 'exact' as const,
        price: `$${price}`,
        network,
        payTo,
        // `tag` is required by the Global x402 Challenge for tracking/attribution.
        extra: { asset, tag: 'x402-global-challenge' },
      },
    ],
    description,
    mimeType: 'application/json',
    extensions: declareDiscoveryExtension({ output: { example } } as any),
  };
}

const app = new Hono();

app.use(
  paymentMiddleware(
    {
      'GET /v1/quote': route(
        '0.01',
        'Flight delay risk for a flight number and date (?flight=BA75&date=2026-10-05): probability of a 2h+ delay or cancellation plus premium quotes for each cover tier',
        { flight: 'BA75', date: '2026-10-05', delayProbability: 0.12, quotes: [{ tier: 'basic', premiumUsd: 0.1, payoutUsd: 0.5 }] },
      ),
      'GET /v1/status': route(
        '0.02',
        'Normalized, hash-attested live flight status (?flight=BA75&date=2026-10-05): state, departure and arrival delay minutes, with a sha256 digest and optional Algorand ed25519 signature',
        { status: { flight: 'BA75', state: 'active', arrivalDelayMin: 25 }, attestation: { digest: '…' } },
      ),
      'GET /v1/policy/basic': route(
        TIERS.basic.premiumUsd,
        `Buy basic flight-delay cover (?flight=BA75&date=2026-10-05&beneficiary=<Algorand address>): pays ${TIERS.basic.payoutUsd} USDC if the flight is cancelled or arrives ${DELAY_THRESHOLD_MIN}+ minutes late`,
        { policyId: 'uuid', tier: 'basic', payoutUsd: 0.5 },
      ),
      'GET /v1/policy/plus': route(
        TIERS.plus.premiumUsd,
        `Buy plus flight-delay cover (?flight=BA75&date=2026-10-05&beneficiary=<Algorand address>): pays ${TIERS.plus.payoutUsd} USDC if the flight is cancelled or arrives ${DELAY_THRESHOLD_MIN}+ minutes late`,
        { policyId: 'uuid', tier: 'plus', payoutUsd: 1 },
      ),
      'GET /v1/claim': route(
        '0.02',
        'Evaluate a policy against the verified flight outcome (?policyId=<id>) and, if eligible, trigger the USDC payout to the policy beneficiary',
        { eligible: true, reason: 'arrival delay 140 min >= 120 min', payout: { txId: '…' } },
      ),
    },
    server,
  ),
);

// ---- Free routes (not payment-gated) ----
app.get('/', c =>
  c.json({
    name: 'EventGuard',
    description: 'Pay-per-request flight delay protection on Algorand, settled in USDC via x402.',
    network: mainnet ? 'algorand-mainnet' : 'algorand-testnet',
    dataProvider: providerName(),
    payouts: payoutsEnabled() ? 'on' : 'off',
    endpoints: {
      'GET /v1/quote': '$0.01',
      'GET /v1/status': '$0.02',
      'GET /v1/policy/basic': `$${TIERS.basic.premiumUsd}`,
      'GET /v1/policy/plus': `$${TIERS.plus.premiumUsd}`,
      'GET /v1/claim': '$0.02',
    },
    stats: stats(),
  }),
);
app.get('/health', c => c.json({ ok: true }));

// ---- Paid handlers. Validation failures return 4xx so the middleware should not settle payment. ----
function parseFlightQuery(c: any) {
  const flight = normalizeFlight(c.req.query('flight'));
  const date = validDate(c.req.query('date'));
  return { flight, date };
}

app.get('/v1/quote', async c => {
  const { flight, date } = parseFlightQuery(c);
  if (!flight || !date) return c.json({ error: 'flight (e.g. BA75) and date (YYYY-MM-DD) are required' }, 400);
  let status;
  try {
    status = await getFlightStatus(flight, date);
  } catch (e) {
    return c.json({ error: 'flight data provider unavailable' }, 502);
  }
  // Unknown flights are 404 so the caller is not charged for an empty answer.
  if (!status) return c.json({ error: 'flight not found for that date' }, 404);
  const prob = delayRisk(status);
  return c.json({
    flight,
    date,
    delayProbability: Math.round(prob * 1000) / 1000,
    thresholdMin: DELAY_THRESHOLD_MIN,
    model: 'heuristic-v1 (not actuarial)',
    dataSource: status.source,
    quotes: Object.values(TIERS).map(t => ({
      tier: t.id,
      payoutUsd: t.payoutUsd,
      fairPremiumUsd: quotePremium(prob, t.payoutUsd),
      listedPremiumUsd: Number(t.premiumUsd),
      buy: `/v1/policy/${t.id}`,
    })),
  });
});

app.get('/v1/status', async c => {
  const { flight, date } = parseFlightQuery(c);
  if (!flight || !date) return c.json({ error: 'flight (e.g. BA75) and date (YYYY-MM-DD) are required' }, 400);
  let status;
  try {
    status = await getFlightStatus(flight, date);
  } catch (e) {
    return c.json({ error: 'flight data provider unavailable' }, 502);
  }
  if (!status) return c.json({ error: 'flight not found' }, 404);
  return c.json({ status, attestation: attest(status) });
});

const MIN_LEAD_MS = 60 * 60_000;

function buyHandler(tierId: 'basic' | 'plus') {
  return async (c: any) => {
    const { flight, date } = parseFlightQuery(c);
    const beneficiary = c.req.query('beneficiary') ?? '';
    if (!flight || !date) return c.json({ error: 'flight and date are required' }, 400);
    if (!algosdk.isValidAddress(beneficiary)) return c.json({ error: 'beneficiary must be a valid Algorand address' }, 400);

    // Block adverse selection: no cover once the flight is already in trouble or past departure.
    const now = Date.now();
    const dayStart = Date.parse(date + 'T00:00:00Z');
    if (dayStart < now - 24 * 3600_000 || dayStart > now + 14 * 24 * 3600_000)
      return c.json({ error: 'cover is available for flights from today up to 14 days ahead' }, 400);
    let status;
    try {
      status = await getFlightStatus(flight, date);
    } catch {
      return c.json({ error: 'flight data provider unavailable' }, 502);
    }
    // Never sell cover on a flight we can't verify: that would be insuring a flight that may not exist.
    if (!status || !status.scheduledArrival || !status.scheduledDeparture)
      return c.json({ error: 'flight not found in the schedule feed for that date' }, 404);
    if (status.state !== 'scheduled' || status.departureDelayMin >= 30)
      return c.json({ error: `flight not eligible for new cover (state: ${status.state}, departure delay ${status.departureDelayMin} min)` }, 409);
    if (Date.parse(status.scheduledDeparture) - now < MIN_LEAD_MS)
      return c.json({ error: 'cover must be bought at least 60 minutes before scheduled departure' }, 409);

    const tier = TIERS[tierId];
    const policy: Policy = {
      id: randomUUID(),
      flight,
      date,
      tier: tierId,
      beneficiary,
      premiumUsd: tier.premiumUsd,
      payoutUsd: tier.payoutUsd,
      createdAt: new Date().toISOString(),
      status: 'active',
      insuredScheduledArrival: status.scheduledArrival,
    };
    savePolicy(policy);
    return c.json({
      policyId: policy.id,
      tier: tierId,
      flight,
      date,
      beneficiary,
      payoutUsd: tier.payoutUsd,
      trigger: `cancelled or arrival delay >= ${DELAY_THRESHOLD_MIN} min`,
      claim: `/v1/claim?policyId=${policy.id}`,
      route: `${status.origin ?? '?'}-${status.destination ?? '?'}`,
      insuredScheduledArrival: status.scheduledArrival,
      dataSource: status.source,
    });
  };
}
app.get('/v1/policy/basic', buyHandler('basic'));
app.get('/v1/policy/plus', buyHandler('plus'));

app.get('/v1/claim', async c => {
  const policy = getPolicy(c.req.query('policyId') ?? '');
  if (!policy) return c.json({ error: 'policy not found' }, 404);
  if (policy.status === 'paid')
    return c.json({ eligible: true, alreadyPaid: true, payout: { txId: policy.payoutTxId, paidAt: policy.paidAt } });
  if (policy.status === 'paying') return c.json({ error: 'payout in progress' }, 409);

  let status;
  try {
    status = await getFlightStatus(policy.flight, policy.date);
  } catch {
    return c.json({ error: 'flight data provider unavailable' }, 502);
  }
  if (!status) return c.json({ error: 'flight data not found' }, 404);

  // Measure against the arrival time that was insured, not whatever the airline has re-timed it to since.
  const resolved = rebaseArrivalDelay(status, policy.insuredScheduledArrival ?? null);
  const verdict = claimEligible(resolved);
  const base = { policyId: policy.id, ...verdict, status: resolved, attestation: attest(resolved) };
  if (!verdict.eligible) return c.json(base);

  if (!payoutsEnabled())
    return c.json({ ...base, payout: { sent: false, reason: 'payouts disabled on this deployment' } });

  policy.status = 'paying';
  savePolicy(policy);
  try {
    const txId = await sendUsdc(policy.beneficiary, policy.payoutUsd);
    policy.status = 'paid';
    policy.payoutTxId = txId;
    policy.paidAt = new Date().toISOString();
    savePolicy(policy);
    return c.json({ ...base, payout: { sent: true, txId, amountUsd: policy.payoutUsd, to: policy.beneficiary } });
  } catch (e: any) {
    policy.status = 'active';
    savePolicy(policy);
    return c.json({ ...base, payout: { sent: false, reason: String(e?.message ?? e) } }, 502);
  }
});

const port = Number(process.env.PORT ?? 4021);
serve({ fetch: app.fetch, port }, () =>
  console.log(`EventGuard x402 server on :${port} (${mainnet ? 'MAINNET' : 'testnet'}, data: ${providerName()}, payouts ${payoutsEnabled() ? 'ON' : 'off'})`),
);
