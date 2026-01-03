import { PublicKey, Transaction } from '@solana/web3.js';

export interface Blind402Quote {
  payment_id: string;
  amount_usdc: number;
  recipient: string;
  expires_at: number;
  hmac: string;
}

export interface WalletAdapter {
  publicKey: PublicKey | null;
  signTransaction(transaction: Transaction): Promise<Transaction>;
}

export interface Blind402ClientOptions {
  rpcUrl?: string;
}

export class Blind402Client {
  constructor(options?: Blind402ClientOptions);
  
  /**
   * Make a request to a blind402-protected endpoint
   * Automatically handles 402 responses by prompting payment
   */
  request(url: string, options?: RequestInit, wallet?: WalletAdapter): Promise<Response>;
  
  /**
   * Pay a blind402 quote directly
   */
  pay(quote: Blind402Quote, wallet: WalletAdapter): Promise<string>;
  
  /**
   * Check if a response is 402 Payment Required
   */
  static isPaymentRequired(response: Response): boolean;
  
  /**
   * Parse quote from 402 response
   */
  static parseQuote(response: Response): Promise<Blind402Quote>;
}

