import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface Policy {
  id: string;
  flight: string;
  date: string;
  tier: 'basic' | 'plus';
  beneficiary: string;
  premiumUsd: string;
  /** Scheduled arrival (ISO UTC) at purchase time. Delay is measured against THIS, so re-timing can't erase a claim. */
  insuredScheduledArrival?: string | null;
  payoutUsd: number;
  createdAt: string;
  status: 'active' | 'paying' | 'paid';
  payoutTxId?: string;
  paidAt?: string;
}

const dir = process.env.DATA_DIR ?? './data';
const file = join(dir, 'policies.json');
let cache: Record<string, Policy> | null = null;

function load(): Record<string, Policy> {
  if (cache) return cache;
  mkdirSync(dir, { recursive: true });
  cache = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  return cache!;
}

function persist(): void {
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(cache, null, 2));
  renameSync(tmp, file);
}

export function savePolicy(p: Policy): void {
  load()[p.id] = p;
  persist();
}

export function getPolicy(id: string): Policy | undefined {
  return load()[id];
}

export function stats(): { policies: number; paid: number } {
  const all = Object.values(load());
  return { policies: all.length, paid: all.filter(p => p.status === 'paid').length };
}
