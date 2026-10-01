// Opts a wallet in to testnet USDC. Usage: CLIENT_MNEMONIC="..." npx tsx src/optin.ts
import algosdk from 'algosdk';
import { config } from 'dotenv';
import { USDC_TESTNET_ASA_ID,USDC_MAINNET_ASA_ID } from '@x402/avm';

config(); // Load environment variables from .env file

const mainnet = (process.env.NETWORK ?? 'testnet') === 'mainnet';

const acct = algosdk.mnemonicToSecretKey(process.env.CLIENT_MNEMONIC!);
const algod = new algosdk.Algodv2('', mainnet ? 'https://mainnet-api.algonode.cloud' : 'https://testnet-api.algonode.cloud', '');

const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
  sender: acct.addr,
  receiver: acct.addr,          // send to yourself
  amount: 0,                    // zero amount = opt-in
  assetIndex: Number(mainnet ? USDC_MAINNET_ASA_ID : USDC_TESTNET_ASA_ID),
  suggestedParams: await algod.getTransactionParams().do(),
});

const { txid } = await algod.sendRawTransaction(txn.signTxn(acct.sk)).do();
await algosdk.waitForConfirmation(algod, txid, 4);
console.log('Opted in to USDC. tx:', txid);