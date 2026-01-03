import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, createTransferInstruction, getAccount } from '@solana/spl-token';
import { readFileSync } from 'fs';

const SERVER_URL = process.env.SERVER_URL || 'https://api.blink402.com';
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const KEYPAIR_PATH = process.env.KEYPAIR_PATH || './test-keypair.json';
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

const connection = new Connection(SOLANA_RPC, 'confirmed');
const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEYPAIR_PATH, 'utf8'))));

async function main() {
  const endpoint = `${SERVER_URL}/v1/data`;
  
  console.log('Step 1: Request protected resource...');
  const initialResponse = await fetch(endpoint);
  
  if (initialResponse.status !== 402) {
    console.log('Unexpected status:', initialResponse.status);
    console.log(await initialResponse.text());
    return;
  }
  
  console.log('Step 2: Got 402, parsing quote...');
  const quoteData = await initialResponse.json();
  const quoteJson = JSON.stringify(quoteData);
  
  console.log('Quote:', JSON.stringify(quoteData.quote, null, 2));
  
  const { quote } = quoteData;
  const merchantWallet = new PublicKey(quote.recipient);
  const amountAtomic = quote.amount_atomic;
  const paymentId = quote.payment_id;
  
  console.log(`Step 3: Paying ${amountAtomic / 1e6} USDC...`);
  
  const senderAta = await getAssociatedTokenAddress(USDC_MINT, keypair.publicKey);
  const recipientAta = await getAssociatedTokenAddress(USDC_MINT, merchantWallet);
  
  const senderAccount = await getAccount(connection, senderAta);
  if (BigInt(senderAccount.amount) < BigInt(amountAtomic)) {
    console.log('Insufficient USDC balance');
    return;
  }
  
  const transferIx = createTransferInstruction(
    senderAta,
    recipientAta,
    keypair.publicKey,
    amountAtomic
  );
  
  const memoProgram = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
  const memoData = Buffer.from(`BLIND402:${paymentId}`, 'utf8');
  const memoIx = {
    keys: [],
    programId: memoProgram,
    data: memoData
  };
  
  const tx = new Transaction().add(transferIx).add(memoIx);
  
  console.log('Step 4: Sending transaction...');
  const signature = await sendAndConfirmTransaction(connection, tx, [keypair], {
    commitment: 'confirmed'
  });
  
  console.log('Step 5: Transaction confirmed:', signature);
  
  console.log('Step 6: Retrying with payment proof...');
  const paidResponse = await fetch(endpoint, {
    headers: {
      'X-BLIND402-QUOTE': quoteJson,
      'X-BLIND402-PAYMENT': signature
    }
  });
  
  console.log('Step 7: Response status:', paidResponse.status);
  const result = await paidResponse.json();
  console.log('Result:', JSON.stringify(result, null, 2));
}

main().catch(console.error);

