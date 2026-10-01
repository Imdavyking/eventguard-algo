export type FlightState = 'scheduled' | 'active' | 'landed' | 'cancelled' | 'diverted' | 'unknown';
export type FlightSource = 'aerodatabox' | 'aviationstack';

export interface FlightStatus {
  flight: string;
  date: string;
  state: FlightState;
  departureDelayMin: number;
  /** Minutes late vs the schedule the provider currently reports. Claims re-base this on the policy's original schedule. */
  arrivalDelayMin: number;
  origin: string | null;
  destination: string | null;
  /** ISO-8601 UTC. */
  scheduledDeparture: string | null;
  scheduledArrival: string | null;
  /** Landing time if known, else the provider's revised estimate. ISO-8601 UTC. */
  arrivalActual: string | null;
  source: FlightSource;
  fetchedAt: string;
}

export const FLIGHT_RE = /^[A-Z0-9]{2}\d{1,4}$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeFlight(raw: string | undefined): string | null {
  const f = (raw ?? '').trim().toUpperCase().replace(/\s+/g, '');
  return FLIGHT_RE.test(f) ? f : null;
}

export function validDate(raw: string | undefined): string | null {
  if (!raw || !DATE_RE.test(raw)) return null;
  return Number.isNaN(Date.parse(raw + 'T00:00:00Z')) ? null : raw;
}

/** Thrown when the provider cannot answer (network, quota, bad key). Callers map this to HTTP 502. */
export class ProviderError extends Error {}

export function delayMinutes(scheduled: string | null, actual: string | null): number {
  if (!scheduled || !actual) return 0;
  const s = Date.parse(scheduled);
  const a = Date.parse(actual);
  if (Number.isNaN(s) || Number.isNaN(a)) return 0;
  return Math.max(0, Math.round((a - s) / 60_000));
}

/** Provider times look like "2026-10-05 14:05Z" (AeroDataBox) or ISO with offset (aviationstack). Returns ISO UTC. */
export function toIsoUtc(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  const t = Date.parse(raw.replace(' ', 'T'));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// ---------------------------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------------------------
export type Provider = 'aerodatabox' | 'aviationstack';

export function providerName(): Provider {
  return process.env.FLIGHT_PROVIDER === 'aviationstack' ? 'aviationstack' : 'aerodatabox';
}

/** Returns an error message if the provider isn't configured, else null. Called at startup: no key => no server. */
export function providerConfigError(): string | null {
  if (providerName() === 'aviationstack') {
    return process.env.AVIATIONSTACK_KEY ? null : 'FLIGHT_PROVIDER=aviationstack requires AVIATIONSTACK_KEY';
  }
  return process.env.AERODATABOX_API_KEY ? null : 'AERODATABOX_API_KEY is required (live flight data is mandatory; there is no demo mode)';
}

// 60s cache: the same flight is often hit by quote -> policy -> claim in quick succession, and every call costs money.
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: FlightStatus | null }>();

export async function getFlightStatus(flight: string, date: string): Promise<FlightStatus | null> {
  const k = `${providerName()}|${flight}|${date}`;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = providerName() === 'aviationstack' ? await fetchAviationstack(flight, date) : await fetchAeroDataBox(flight, date);
  cache.set(k, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return value;
}

async function httpJson(url: string, headers: Record<string, string> = {}): Promise<any | null> {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  } catch (e: any) {
    throw new ProviderError(`flight provider unreachable: ${e?.name ?? 'error'}`);
  }
  if (res.status === 204 || res.status === 404) return null; // no such flight on that date
  if (!res.ok) throw new ProviderError(`flight provider HTTP ${res.status}`);
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError('flight provider returned invalid JSON');
  }
}

// ---------------------------------------------------------------------------------------------
// AeroDataBox (primary): returns scheduled / revised / runway timestamps, so delay is computed, not trusted.
// Marketplaces: API.market (default) or RapidAPI (AERODATABOX_VIA=rapidapi).
// ---------------------------------------------------------------------------------------------
async function fetchAeroDataBox(flight: string, date: string): Promise<FlightStatus | null> {
  const key = process.env.AERODATABOX_API_KEY!;
  const rapid = process.env.AERODATABOX_VIA === 'rapidapi';
  const base =
    process.env.AERODATABOX_BASE ??
    (rapid ? 'https://aerodatabox.p.rapidapi.com' : 'https://prod.api.market/api/v1/aedbx/aerodatabox');
  const headers: Record<string, string> = rapid
    ? { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com' }
    : { 'x-api-market-key': key };
  const url = `${base}/flights/number/${encodeURIComponent(flight)}/${date}?dateLocalRole=Departure&withAircraftImage=false&withLocation=false`;
  return parseAeroDataBox(await httpJson(url, headers), flight, date);
}

const ADB_ACTIVE = new Set(['Boarding', 'GateClosed', 'Departed', 'EnRoute', 'Approaching']);
const ADB_SCHEDULED = new Set(['Expected', 'CheckIn', 'Delayed']);

export function parseAeroDataBox(body: any, flight: string, date: string): FlightStatus | null {
  const list: any[] = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : [];
  if (list.length === 0) return null;
  // Prefer the operating carrier's record that departs on the requested local date.
  const onDate = list.filter(f => String(f?.departure?.scheduledTime?.local ?? '').startsWith(date));
  const pool = onDate.length ? onDate : list;
  const f = pool.find(x => x?.codeshareStatus === 'IsOperator') ?? pool[0];

  const s = String(f.status ?? 'Unknown');
  const state: FlightState =
    s === 'Canceled' ? 'cancelled'
    : s === 'Arrived' ? 'landed'
    : s === 'Diverted' ? 'diverted'
    : ADB_ACTIVE.has(s) ? 'active'
    : ADB_SCHEDULED.has(s) ? 'scheduled'
    : 'unknown'; // includes CanceledUncertain: never pay on an uncertain cancellation

  const depSched = toIsoUtc(f.departure?.scheduledTime?.utc);
  const depActual = toIsoUtc(f.departure?.runwayTime?.utc ?? f.departure?.revisedTime?.utc);
  const arrSched = toIsoUtc(f.arrival?.scheduledTime?.utc);
  const arrActual = toIsoUtc(f.arrival?.runwayTime?.utc ?? f.arrival?.revisedTime?.utc);

  return {
    flight,
    date,
    state,
    departureDelayMin: delayMinutes(depSched, depActual),
    arrivalDelayMin: delayMinutes(arrSched, arrActual),
    origin: f.departure?.airport?.iata ?? null,
    destination: f.arrival?.airport?.iata ?? null,
    scheduledDeparture: depSched,
    scheduledArrival: arrSched,
    arrivalActual: arrActual,
    source: 'aerodatabox',
    fetchedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------
// aviationstack (alternative). HTTPS and historical flight_date need a PAID plan; the free tier is
// HTTP-only (API key in cleartext) and capped at 100 requests/month, so it is refused in production.
// ---------------------------------------------------------------------------------------------
async function fetchAviationstack(flight: string, date: string): Promise<FlightStatus | null> {
  const key = process.env.AVIATIONSTACK_KEY!;
  const base = process.env.AVIATIONSTACK_BASE ?? 'https://api.aviationstack.com/v1/flights';
  if (!base.startsWith('https://') && process.env.NETWORK === 'mainnet')
    throw new ProviderError('refusing plain-HTTP flight provider on mainnet (paid aviationstack plan required for HTTPS)');
  const url = `${base}?access_key=${encodeURIComponent(key)}&flight_iata=${flight}&flight_date=${date}`;
  const body = await httpJson(url);
  if (body?.error) throw new ProviderError(`flight provider error: ${body.error.code ?? 'unknown'}`);
  return parseAviationstack(body, flight, date);
}

export function parseAviationstack(body: any, flight: string, date: string): FlightStatus | null {
  const list: any[] = Array.isArray(body?.data) ? body.data : [];
  const f = list.find(x => x?.flight_date === date && !x?.flight?.codeshared) ?? list.find(x => x?.flight_date === date);
  if (!f) return null;
  const st = String(f.flight_status ?? '');
  const state: FlightState =
    st === 'scheduled' || st === 'active' || st === 'landed' || st === 'cancelled' || st === 'diverted' ? st : 'unknown';
  const depSched = toIsoUtc(f.departure?.scheduled);
  const arrSched = toIsoUtc(f.arrival?.scheduled);
  const arrActual = toIsoUtc(f.arrival?.actual ?? f.arrival?.estimated);
  const depActual = toIsoUtc(f.departure?.actual ?? f.departure?.estimated);
  return {
    flight,
    date,
    state,
    departureDelayMin: depSched && depActual ? delayMinutes(depSched, depActual) : Number(f.departure?.delay ?? 0) || 0,
    arrivalDelayMin: arrSched && arrActual ? delayMinutes(arrSched, arrActual) : Number(f.arrival?.delay ?? 0) || 0,
    origin: f.departure?.iata ?? null,
    destination: f.arrival?.iata ?? null,
    scheduledDeparture: depSched,
    scheduledArrival: arrSched,
    arrivalActual: arrActual,
    source: 'aviationstack',
    fetchedAt: new Date().toISOString(),
  };
}

/** Delay of a resolved flight measured against an originally insured arrival time (not a later re-timed schedule). */
export function rebaseArrivalDelay(status: FlightStatus, insuredScheduledArrival: string | null): FlightStatus {
  if (!insuredScheduledArrival || !status.arrivalActual) return status;
  return { ...status, arrivalDelayMin: delayMinutes(insuredScheduledArrival, status.arrivalActual) };
}
