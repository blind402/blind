const { Connection, PublicKey, Transaction, TransactionInstruction } = require('@solana/web3.js');
const { getAssociatedTokenAddress, createTransferInstruction, getAccount } = require('@solana/spl-token');

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

class Blind402Client {
  constructor(options = {}) {
    this.rpcUrl = options.rpcUrl || 'https://api.mainnet-beta.solana.com';
    this.connection = new Connection(this.rpcUrl, 'confirmed');
  }

  /**
   * Make a request to a blind402-protected endpoint
   * @param {string} url - The API endpoint URL
   * @param {object} options - Fetch options (method, headers, body, etc.)
   * @param {object} wallet - Wallet adapter with publicKey and signTransaction
   * @returns {Promise<Response>} - The API response
   */
  async request(url, options = {}, wallet) {
    // First request - expect 402
    const initialResponse = await fetch(url, options);
    
    if (initialResponse.status !== 402) {
      return initialResponse;
    }

    // Parse quote from 402 response
    const quote = await initialResponse.json();
    
    if (!quote.payment_id || !quote.amount_usdc || !quote.recipient) {
      throw new Error('Invalid quote format');
    }

    // Pay and get signature
    const signature = await this.pay(quote, wallet);

    // Retry with payment proof
    const retryHeaders = {
      ...options.headers,
      'X-BLIND402-QUOTE': JSON.stringify(quote),
      'X-BLIND402-PAYMENT': signature,
    };

    return fetch(url, { ...options, headers: retryHeaders });
  }

  /**
   * Pay a blind402 quote
   * @param {object} quote - The quote from 402 response
   * @param {object} wallet - Wallet adapter with publicKey and signTransaction
   * @returns {Promise<string>} - Transaction signature
   */
  async pay(quote, wallet) {
    if (!wallet.publicKey) {
      throw new Error('Wallet not connected');
    }

    const { payment_id, amount_usdc, recipient } = quote;
    const amountLamports = Math.round(amount_usdc * 1_000_000);

    const usdcMint = new PublicKey(USDC_MINT);
    const recipientPubkey = new PublicKey(recipient);

    // Get token accounts
    const senderAta = await getAssociatedTokenAddress(usdcMint, wallet.publicKey);
    const recipientAta = await getAssociatedTokenAddress(usdcMint, recipientPubkey);

    // Build transaction
    const transaction = new Transaction();

    // Add memo instruction
    const memo = `BLIND402:${payment_id}`;
    transaction.add(
      new TransactionInstruction({
        keys: [],
        programId: new PublicKey(MEMO_PROGRAM_ID),
        data: Buffer.from(memo, 'utf-8'),
      })
    );

    // Add transfer instruction
    transaction.add(
      createTransferInstruction(senderAta, recipientAta, wallet.publicKey, amountLamports)
    );

    // Get recent blockhash
    const { blockhash } = await this.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = wallet.publicKey;

    // Sign and send
    const signed = await wallet.signTransaction(transaction);
    const signature = await this.connection.sendRawTransaction(signed.serialize());
    
    // Wait for confirmation
    await this.connection.confirmTransaction(signature, 'confirmed');

    return signature;
  }

  /**
   * Check if a response is a 402 payment required
   * @param {Response} response - Fetch response
   * @returns {boolean}
   */
  static isPaymentRequired(response) {
    return response.status === 402;
  }

  /**
   * Parse quote from 402 response
   * @param {Response} response - 402 response
   * @returns {Promise<object>} - Quote object
   */
  static async parseQuote(response) {
    if (response.status !== 402) {
      throw new Error('Response is not 402 Payment Required');
    }
    return response.json();
  }
}

module.exports = { Blind402Client };

