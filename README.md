# EventGuard

Pay-per-request flight-delay protection on Algorand, settled in USDC over **x402** via the GoPlausible facilitator.
Submitted as a **Composite** entry: five paid endpoints, one `payTo`, one domain.

| Endpoint | Price | What the caller gets |
|---|---|---|
| `GET /v1/quote?flight=BA75&date=YYYY-MM-DD` | $0.01 | Delay/cancellation probability + premium quotes |
| `GET /v1/status?flight=…&date=…` | $0.02 | Normalized live flight status + sha256 digest (+ Algorand ed25519 signature if `ATTESTOR_MNEMONIC` set) |
| `GET /v1/policy/basic?flight=…&date=…&beneficiary=<addr>` | $0.10 | Policy paying 0.50 USDC on cancel / 120+ min late arrival |
| `GET /v1/policy/plus?…` | $0.25 | Same trigger, pays 1.00 USDC |
| `GET /v1/claim?policyId=…` | $0.02 | Checks outcome vs. policy; if eligible and payouts are on, sends USDC to the beneficiary |

Free: `GET /` (service info), `GET /health`.

## Data: live only, no demo mode
Flight status comes from **AeroDataBox** (API.market by default, RapidAPI with `AERODATABOX_VIA=rapidapi`). Delay is **computed** from scheduled vs. landing/revised timestamps rather than trusting a provider "delay" field. `FLIGHT_PROVIDER=aviationstack` is supported as an alternative but needs a paid plan (free tier is HTTP-only, 100 req/month; refused on mainnet over plain HTTP). The server **refuses to start** without a key.

Insurance rules enforced in code:
- Cover is sold only for flights found in the live feed, still `scheduled`, <30 min departure delay, and ≥60 min before departure.
- The insured **scheduled arrival is stored on the policy**; claims measure delay against it, so an airline re-timing a flight can't erase a claim.
- Claims resolve only on a **landed / diverted / cancelled** flight. In-air estimates never pay. An uncertain cancellation never pays.
- Unknown flight => 404 and provider outage => 502, so the payer is not settled for an empty answer.
- Delay basis: landing (runway) time if present, else the provider's revised time.

## Run (testnet first)
```bash
npm install
cp .env.example .env     # set AVM_ADDRESS (USDC-opted-in), AERODATABOX_API_KEY, NETWORK=testnet
npm run dev
CLIENT_MNEMONIC="…" npm run client -- "http://localhost:4021/v1/quote?flight=BA75&date=<a date within 14 days>"
```
Unit tests (`npm test`) cover claim rules, provider parsing and schedule re-basing using fixtures.

## Go to Mainnet (challenge checklist)
1. `NETWORK=mainnet`, `AVM_ADDRESS` = Mainnet account **opted in to USDC (ASA 31566704)**. Never change it afterwards.
2. Deploy to a host with a **persistent disk** (Render, Railway, Fly) — policies are stored in `DATA_DIR/policies.json`. Public HTTPS, **one root domain only**.
3. Pay once on Mainnet: `NETWORK=mainnet CLIENT_MNEMONIC=… npm run client -- "https://YOUR_DOMAIN/v1/quote?flight=BA75&date=2026-10-05"`
4. Confirm USDC landed, then check the endpoints appear in the leaderboard / Bazaar with the global-hackathon filter ON: https://facilitator.goplausible.xyz/dashboard/leaderboards
5. Public GitHub repo → submit to Electric Capital (open-dev-data) → submit the challenge form.

Route descriptions and the `x402-global-challenge` tag are set in `src/index.ts` (`route()`).

## Known limits (be upfront with judges)
- Risk model is a **heuristic**, not actuarial. Cover is micro-scale (≤ $1 payout).
- Payouts are sent from a **server-held treasury**, not a smart contract. `PAYOUTS_ENABLED=false` by default. A contract-escrowed pool is the next step.
- Selling cover that pays on a real-world event is regulated as insurance in many jurisdictions. Get advice before enabling payouts for real users.
- Single data provider: a provider error or wrong record is a wrong claim outcome. A second-source cross-check before paying is the next step.
- Each paid call costs one provider call (60s cache). Check your plan's per-request cost stays under the $0.01 quote price.
- Validation errors return 4xx so the middleware should not settle payment: **verify this on testnet** before relying on it.
- `@x402/*` is pinned to 2.11.0 (the version in the official Algorand tutorial) and `@x402-avm/extensions` to 2.6.1.
