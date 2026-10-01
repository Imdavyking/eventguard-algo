import { createHash } from 'node:crypto';
import algosdk from 'algosdk';

export interface Attestation {
  digest: string; // sha256 over canonical JSON of the status payload
  signer?: string; // Algorand address of the attestor
  signature?: string; // base64 ed25519 signature over the digest bytes
}

export function attest(payload: unknown): Attestation {
  const digest = createHash('sha256').update(JSON.stringify(payload)).digest();
  const out: Attestation = { digest: digest.toString('hex') };
  const m = process.env.ATTESTOR_MNEMONIC;
  if (m) {
    const acct = algosdk.mnemonicToSecretKey(m);
    out.signer = String(acct.addr);
    out.signature = Buffer.from(algosdk.signBytes(digest, acct.sk)).toString('base64');
  }
  return out;
}
