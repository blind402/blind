# blind402 Protocol Specification

Version: 1

## Overview

blind402 is an HTTP 402 Payment Required protocol that gates API access behind Solana USDC payments. Clients must pay for each request by submitting a USDC transfer with a memo linking payment to a specific quote.

## HTTP Flow

### Initial Request (No Payment)

Client sends a request to a protected endpoint without payment headers.

**Request:**
```
GET /v1/data HTTP/1.1
Host: example.com
```

**Response:**
```
HTTP/1.1 402 Payment Required
Content-Type: application/json

{
  "quote": { ... },
  "quote_token": "..."
}
```

### Paid Request

Client sends the same request with payment proof headers.

**Request:**
```
GET /v1/data HTTP/1.1
Host: example.com
X-BLIND402-QUOTE: {"quote":{...},"quote_token":"..."}
X-BLIND402-PAYMENT: <solana_transaction_signature>
```

**Response (success):**
```
HTTP/1.1 200 OK
Content-Type: application/json

{ ... protected resource ... }
```

**Response (payment rejected):**
```
HTTP/1.1 402 Payment Required
Content-Type: application/json

{
  "error": "...",
  "quote": { ... },
  "quote_token": "..."
}
```

## Quote Format

The server returns a quote object and an HMAC signature of that object.

```json
{
  "quote": {
    "protocol": "blind402",
    "version": 1,
    "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "recipient": "<merchant_wallet_pubkey>",
    "amount_atomic": 1000,
    "expires_at": 1767426853733,
    "nonce": "uccsgAUvcbbsAWlpPz9cHA",
    "payment_id": "96b73a2d9020ced51595f00eecb3898605efa41a016572d4bb6037e1fb440a46",
    "tier": 0
  },
  "quote_token": "9883c2542ddf24738fa45c5f502890b4a869a95171efa2e16f1dfe9af5cff52e"
}
```

### Quote Fields

| Field | Type | Description |
|-------|------|-------------|
| `protocol` | string | Always `"blind402"` |
| `version` | integer | Protocol version, currently `1` |
| `mint` | string | SPL token mint address (USDC mainnet) |
| `recipient` | string | Merchant wallet public key |
| `amount_atomic` | integer | Payment amount in atomic units (1 USDC = 1,000,000) |
| `expires_at` | integer | Unix timestamp in milliseconds when quote expires |
| `nonce` | string | Base64url-encoded random value, unique per quote |
| `payment_id` | string | SHA-256 hash binding quote to specific request |
| `tier` | integer | Current pricing tier (0-based) |

### Quote Token

The `quote_token` is an HMAC-SHA256 signature of the canonical JSON representation of the quote object. Canonical JSON is produced by sorting object keys alphabetically before serialization.

## Required Headers

### X-BLIND402-QUOTE

The complete JSON response from the 402 response, including both `quote` and `quote_token` fields. Must be sent as a single JSON string.

### X-BLIND402-PAYMENT

The Solana transaction signature (base58-encoded) of the USDC transfer transaction.

## Solana Payment Requirements

### Token

USDC on Solana mainnet.

Mint address: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`

### Destination

Payment must be sent to the merchant's Associated Token Account (ATA) for USDC. The ATA is derived deterministically from:
- Token mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- Owner: merchant wallet public key

### Amount

Transfer amount must be greater than or equal to `quote.amount_atomic`.

### Memo

The transaction must include a memo instruction with the exact value:

```
BLIND402:<payment_id>
```

Where `<payment_id>` is the `payment_id` field from the quote.

Supported memo programs:
- `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` (Memo v2)
- `Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo` (Memo v1)

### Transaction Status

Transaction must be confirmed with at least `confirmed` commitment level.

## Payment Verification Rules

The server verifies payments in the following order:

1. **Quote parsing**: The `X-BLIND402-QUOTE` header must be valid JSON containing `quote` and `quote_token` fields.

2. **Quote signature**: The `quote_token` must match the HMAC-SHA256 of the canonical JSON quote using the server secret.

3. **Quote expiry**: Current time must be before `quote.expires_at`.

4. **Request binding**: The `payment_id` is recomputed from the current request (method, path, query string, body hash, nonce, expires_at). It must match `quote.payment_id`.

5. **Replay protection**: The transaction signature must not have been used before.

6. **Transaction validity**: The Solana transaction must exist and have succeeded (no error in metadata).

7. **Destination verification**: The transfer destination must exactly match the merchant's USDC ATA.

8. **Mint verification**: The destination token account must hold USDC (mint matches expected).

9. **Amount verification**: Transfer amount must be >= `quote.amount_atomic`.

10. **Memo verification**: Transaction memo must exactly match `BLIND402:<payment_id>`.

11. **Timing verification**: If transaction has a block time, it must be before `quote.expires_at`.

## Rate Limiting by Price

The protocol implements rate limiting through exponential price escalation per endpoint.

### Tier Calculation

Each endpoint maintains an independent tier counter. The price for a request is:

```
price = base_price * 2^tier
```

### Tier Escalation

The tier increments by 1 after each successful payment verification.

### Tier Decay

Tiers reset to 0 after 60 seconds of inactivity (no successful payments to that endpoint).

### Example

| Tier | Price (USDC) |
|------|--------------|
| 0 | 0.001 |
| 1 | 0.002 |
| 2 | 0.004 |
| 3 | 0.008 |
| 4 | 0.016 |

## Security Guarantees

### Quote Integrity

Quotes cannot be forged or modified. The HMAC signature using a server-side secret ensures authenticity.

### Request Binding

The `payment_id` cryptographically binds a payment to a specific request (method, path, query, body). A payment for one request cannot be used for a different request.

### Replay Protection

Transaction signatures are tracked in memory for 15 minutes. A signature cannot be reused within this window.

### Destination Verification

Payments are verified against the computed ATA, not a user-supplied address. This prevents redirection attacks.

### Mint Verification

The destination token account is verified to hold USDC, preventing payment with other tokens.

### Timing Bounds

Quotes expire after 60 seconds. Transactions with block times after expiry are rejected.

## Failure Cases

| Error | Cause |
|-------|-------|
| `Invalid quote format` | `X-BLIND402-QUOTE` header is not valid JSON |
| `Missing quote or quote_token` | Required fields missing from quote JSON |
| `Invalid quote signature` | Quote was tampered with or forged |
| `Quote expired` | Current time exceeds `expires_at` |
| `Payment ID mismatch - request differs from quoted request` | Request parameters changed after quote was issued |
| `Transaction already used` | Replay attempt detected |
| `Transaction not found` | Signature does not correspond to a confirmed transaction |
| `Transaction failed` | Transaction exists but failed on-chain |
| `No USDC transfer found` | Transaction does not contain a token transfer instruction |
| `Mint mismatch` | Transfer is not USDC |
| `Invalid payment destination` | Transfer destination is not the merchant's USDC ATA |
| `Insufficient payment amount` | Transfer amount is less than quoted amount |
| `Invalid memo` | Memo missing or does not match expected format |
| `Transaction too late` | Transaction block time exceeds quote expiry |
| `Payment verification failed` | Internal server error during verification |

## Constants

| Constant | Value |
|----------|-------|
| USDC Mint | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| USDC Decimals | 6 |
| Quote TTL | 60 seconds |
| Replay Protection TTL | 15 minutes |
| Tier Decay | 60 seconds |
| Token Program | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |

