import algosdk from 'algosdk';
import { USDC_MAINNET_ASA_ID, USDC_TESTNET_ASA_ID } from '@x402/avm';

const isMainnet = (process.env.NETWORK ?? 'testnet') === 'mainnet';
export const USDC_ASA = Number(isMainnet ? USDC_MAINNET_ASA_ID : USDC_TESTNET_ASA_ID);

export const payoutsEnabled = (): boolean =>
  process.env.PAYOUTS_ENABLED === 'true' && !!process.env.TREASURY_MNEMONIC;

/** Sends `usd` USDC (6 decimals) from the treasury to `beneficiary`. Returns the txid. */
export async function sendUsdc(beneficiary: string, usd: number): Promise<string> {
  const algodUrl =
    process.env.ALGOD_URL ??
    (isMainnet ? 'https://mainnet-api.algonode.cloud' : 'https://testnet-api.algonode.cloud');
  const algod = new algosdk.Algodv2('', algodUrl, '');
  const treasury = algosdk.mnemonicToSecretKey(process.env.TREASURY_MNEMONIC!);

  // Beneficiary must be opted in to USDC or the transfer fails; surface that clearly.
  try {
    await algod.accountAssetInformation(beneficiary, USDC_ASA).do();
  } catch {
    throw new Error('beneficiary is not opted in to USDC');
  }

  const suggestedParams = await algod.getTransactionParams().do();
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: treasury.addr,
    receiver: beneficiary,
    amount: BigInt(Math.round(usd * 1_000_000)),
    assetIndex: USDC_ASA,
    suggestedParams,
    note: new TextEncoder().encode('EventGuard claim payout'),
  });
  const { txid } = await algod.sendRawTransaction(txn.signTxn(treasury.sk)).do();
  await algosdk.waitForConfirmation(algod, txid, 4);
  return txid;
}
