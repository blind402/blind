import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';

// =====================
// CONFIGURATION
// =====================

const PORT = process.env.PORT || 3000;
const SERVER_SECRET = process.env.SERVER_SECRET || crypto.randomBytes(32).toString('hex');
const MERCHANT_WALLET = process.env.MERCHANT_WALLET || 'YOUR_MERCHANT_WALLET_ADDRESS';
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;

// Base prices per endpoint (in USDC)
const ENDPOINT_PRICES = {
  'GET:/v1/data': 0.001
};

// Quote TTL
const QUOTE_TTL_MS = 60 * 1000;

// Replay protection TTL
const REPLAY_TTL_MS = 15 * 60 * 1000;

// =====================
// REPLAY PROTECTION CACHE
// =====================

const usedSignatures = new Map();

function isSignatureUsed(signature) {
  cleanupExpired();
  return usedSignatures.has(signature);
}

function markSignatureUsed(signature) {
  usedSignatures.set(signature, Date.now() + REPLAY_TTL_MS);
}

function cleanupExpired() {
  const now = Date.now();
  for (const [sig, expiry] of usedSignatures) {
    if (expiry < now) {
      usedSignatures.delete(sig);
    }
  }
}

// =====================
// TIER TRACKING (in-memory per endpoint)
// =====================

const tierMap = new Map();
const TIER_DECAY_MS = 60 * 1000;

function getTier(endpoint) {
  cleanupTiers();
  const entry = tierMap.get(endpoint);
  if (!entry) return 0;
  return entry.tier;
}

function incrementTier(endpoint) {
  const current = getTier(endpoint);
  tierMap.set(endpoint, { tier: current + 1, expires: Date.now() + TIER_DECAY_MS });
}

function cleanupTiers() {
  const now = Date.now();
  for (const [key, val] of tierMap) {
    if (val.expires < now) {
      tierMap.delete(key);
    }
  }
}

// =====================
// HELPERS
// =====================

function base64urlEncode(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function generateNonce() {
  return base64urlEncode(crypto.randomBytes(16));
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmacSign(data) {
  return crypto.createHmac('sha256', SERVER_SECRET).update(data).digest('hex');
}

function canonicalJson(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

function computePaymentId(method, path, query, bodyHash, nonce, expiresAt) {
  const data = `${method}${path}${query}${bodyHash}${nonce}${expiresAt}`;
  return sha256(data);
}

function getBodyHash(body) {
  if (!body || Object.keys(body).length === 0) {
    return sha256('');
  }
  return sha256(JSON.stringify(body));
}

// =====================
// QUOTE GENERATION
// =====================

function generateQuote(req) {
  const method = req.method;
  const path = req.path;
  const query = req.originalUrl.includes('?') ? req.originalUrl.split('?')[1] : '';
  const bodyHash = getBodyHash(req.body);
  
  const nonce = generateNonce();
  const expiresAt = Date.now() + QUOTE_TTL_MS;
  const paymentId = computePaymentId(method, path, query, bodyHash, nonce, expiresAt);
  
  const endpointKey = `${method}:${path}`;
  const basePrice = ENDPOINT_PRICES[endpointKey] || 0.001;
  const tier = getTier(endpointKey);
  const price = basePrice * Math.pow(2, tier);
  const amountAtomic = Math.ceil(price * Math.pow(10, USDC_DECIMALS));
  
  const payload = {
    protocol: 'blind402',
    version: 1,
    mint: USDC_MINT,
    recipient: MERCHANT_WALLET,
    amount_atomic: amountAtomic,
    expires_at: expiresAt,
    nonce: nonce,
    payment_id: paymentId,
    tier: tier
  };
  
  const quoteToken = hmacSign(canonicalJson(payload));
  
  return { quote: payload, quote_token: quoteToken };
}

// =====================
// SOLANA TRANSACTION PARSER
// =====================

const connection = new Connection(SOLANA_RPC, 'confirmed');

function extractMemoFromInstruction(ix) {
  if (typeof ix.parsed === 'string') {
    return ix.parsed.trim();
  } else if (ix.parsed?.info?.memo) {
    return String(ix.parsed.info.memo).trim();
  } else if (ix.parsed?.memo) {
    return String(ix.parsed.memo).trim();
  } else if (ix.data) {
    return String(ix.data).trim();
  }
  return null;
}

function extractMemo(tx) {
  const instructions = tx.transaction.message.instructions;
  for (const ix of instructions) {
    if (ix.programId.toString() === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' ||
        ix.programId.toString() === 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo') {
      const memo = extractMemoFromInstruction(ix);
      if (memo) return memo;
    }
  }
  const innerInstructions = tx.meta?.innerInstructions || [];
  for (const inner of innerInstructions) {
    for (const ix of inner.instructions) {
      if (ix.programId?.toString() === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' ||
          ix.programId?.toString() === 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo') {
        const memo = extractMemoFromInstruction(ix);
        if (memo) return memo;
      }
    }
  }
  return null;
}

async function parseUsdcTransfer(txSignature) {
  const tx = await connection.getParsedTransaction(txSignature, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed'
  });
  
  if (!tx) {
    return { valid: false, error: 'Transaction not found' };
  }
  
  if (tx.meta?.err) {
    return { valid: false, error: 'Transaction failed' };
  }
  
  const blockTime = tx.blockTime ? tx.blockTime * 1000 : null;
  
  // Find USDC transfer
  let transferInfo = null;
  const instructions = tx.transaction.message.instructions;
  
  for (const ix of instructions) {
    if (ix.programId.toString() === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
      if (ix.parsed?.type === 'transfer' || ix.parsed?.type === 'transferChecked') {
        transferInfo = ix.parsed.info;
        break;
      }
    }
  }
  
  if (!transferInfo) {
    // Check inner instructions
    const innerInstructions = tx.meta?.innerInstructions || [];
    for (const inner of innerInstructions) {
      for (const ix of inner.instructions) {
        if (ix.programId?.toString() === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
          if (ix.parsed?.type === 'transfer' || ix.parsed?.type === 'transferChecked') {
            transferInfo = ix.parsed.info;
            break;
          }
        }
      }
      if (transferInfo) break;
    }
  }
  
  if (!transferInfo) {
    return { valid: false, error: 'No USDC transfer found' };
  }
  
  const destination = transferInfo.destination;
  
  const destAccountInfo = await connection.getParsedAccountInfo(new PublicKey(destination));
  const destMint = destAccountInfo.value?.data?.parsed?.info?.mint;
  if (destMint !== USDC_MINT) {
    return { valid: false, error: 'Mint mismatch' };
  }
  
  const memo = extractMemo(tx);
  
  const amount = parseInt(transferInfo.amount || transferInfo.tokenAmount?.amount || '0');
  
  const mint = transferInfo.mint || null;
  
  return {
    valid: true,
    destination,
    amount,
    mint,
    memo,
    blockTime
  };
}

// =====================
// PAYMENT VERIFICATION
// =====================

async function verifyPayment(req, quoteStr, txSignature) {
  // Parse quote
  let quoteData;
  try {
    quoteData = JSON.parse(quoteStr);
  } catch (e) {
    return { valid: false, error: 'Invalid quote format' };
  }
  
  const { quote, quote_token } = quoteData;
  
  if (!quote || !quote_token) {
    return { valid: false, error: 'Missing quote or quote_token' };
  }
  
  // Verify HMAC
  const expectedToken = hmacSign(canonicalJson(quote));
  if (quote_token !== expectedToken) {
    return { valid: false, error: 'Invalid quote signature' };
  }
  
  // Check expiry
  if (Date.now() > quote.expires_at) {
    return { valid: false, error: 'Quote expired' };
  }
  
  // Recompute payment_id
  const method = req.method;
  const path = req.path;
  const query = req.originalUrl.includes('?') ? req.originalUrl.split('?')[1] : '';
  const bodyHash = getBodyHash(req.body);
  
  const computedPaymentId = computePaymentId(
    method, path, query, bodyHash,
    quote.nonce, quote.expires_at
  );
  
  if (computedPaymentId !== quote.payment_id) {
    return { valid: false, error: 'Payment ID mismatch - request differs from quoted request' };
  }
  
  // Check replay
  if (isSignatureUsed(txSignature)) {
    return { valid: false, error: 'Transaction already used' };
  }
  
  // Parse and verify transaction
  const txInfo = await parseUsdcTransfer(txSignature);
  
  if (!txInfo.valid) {
    return { valid: false, error: txInfo.error };
  }
  
  // Verify destination is merchant's ATA
  const merchantAta = await getAssociatedTokenAddress(
    new PublicKey(USDC_MINT),
    new PublicKey(MERCHANT_WALLET)
  );
  if (txInfo.destination !== merchantAta.toBase58()) {
    return { valid: false, error: 'Invalid payment destination' };
  }
  
  // Verify amount
  if (txInfo.amount < quote.amount_atomic) {
    return { valid: false, error: 'Insufficient payment amount' };
  }
  
  // Verify memo
  const expectedMemo = `BLIND402:${quote.payment_id}`;
  if (txInfo.memo !== expectedMemo) {
    return { valid: false, error: 'Invalid memo' };
  }
  
  // Verify blocktime
  if (txInfo.blockTime && txInfo.blockTime > quote.expires_at) {
    return { valid: false, error: 'Transaction too late' };
  }
  
  // Mark signature as used
  markSignatureUsed(txSignature);
  
  // Increment tier after successful payment
  const endpointKey = `${method}:${path}`;
  incrementTier(endpointKey);
  
  return { valid: true };
}

// =====================
// MIDDLEWARE
// =====================

function blind402Middleware(req, res, next) {
  const quoteHeader = req.headers['x-blind402-quote'];
  const paymentHeader = req.headers['x-blind402-payment'];
  
  if (!quoteHeader || !paymentHeader) {
    // No payment - return 402 with quote
    const quoteData = generateQuote(req);
    return res.status(402).json(quoteData);
  }
  
  // Verify payment
  verifyPayment(req, quoteHeader, paymentHeader)
    .then(result => {
      if (!result.valid) {
        return res.status(402).json({ error: result.error, ...generateQuote(req) });
      }
      next();
    })
    .catch(err => {
      console.error('Payment verification error:', err);
      res.status(500).json({ error: 'Payment verification failed' });
    });
}

// =====================
// EXPRESS APP
// =====================

const app = express();

app.use(express.json());

// Protected route
app.get('/v1/data', blind402Middleware, (req, res) => {
  res.json({
    success: true,
    data: {
      timestamp: Date.now(),
      message: 'This is protected data'
    }
  });
});

// Health check (unprotected)
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`blind402 server running on port ${PORT}`);
  console.log(`Merchant wallet: ${MERCHANT_WALLET}`);
  console.log(`USDC Mint: ${USDC_MINT}`);
});

