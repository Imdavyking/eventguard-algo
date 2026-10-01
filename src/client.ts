// Pays an EventGuard endpoint with USDC. Usage: npm run client -- "<url>"
// Env: CLIENT_MNEMONIC (payer, funded + opted in to USDC), NETWORK=mainnet|testnet
import { config } from 'dotenv';
import algosdk from 'algosdk';
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from '@x402/fetch';
import { toClientAvmSigner, ExactAvmScheme, ALGORAND_MAINNET_CAIP2, ALGORAND_TESTNET_CAIP2 } from '@x402/avm';

config();

const url = process.argv[2];
if (!url || !process.env.CLIENT_MNEMONIC) {
  console.error('usage: CLIENT_MNEMONIC="..." npm run client -- "https://host/v1/quote?flight=BA75&date=2026-10-05"');
  process.exit(1);
}
const network = process.env.NETWORK === 'mainnet' ? ALGORAND_MAINNET_CAIP2 : ALGORAND_TESTNET_CAIP2;

// x402-avm expects base64( 32-byte ed25519 seed + 32-byte public key ), which is algosdk's 64-byte sk.
const sk = algosdk.mnemonicToSecretKey(process.env.CLIENT_MNEMONIC).sk;
const signer = toClientAvmSigner(Buffer.from(sk).toString('base64'));

const client = new x402Client();
client.register(network, new ExactAvmScheme(signer));
const payFetch = wrapFetchWithPayment(fetch, client);

const res = await payFetch(url, { method: 'GET' });
console.log('status:', res.status);
if (res.ok) {
  const settle = new x402HTTPClient(client).getPaymentSettleResponse(n => res.headers.get(n));
  console.log('settlement:', JSON.stringify(settle, null, 2));
}
console.log(JSON.stringify(await res.json(), null, 2));
