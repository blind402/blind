# blind402

blind402 is an HTTP 402 Payment Required implementation for Node.js. It gates API access behind Solana USDC micropayments. Clients pay per request by submitting a USDC transfer with a memo that binds the payment to a specific API call.

The protocol requires no accounts, no API keys, and no authentication. Payment is the only requirement for access. The server does not store or track user identity.

## How It Works

1. Client requests a protected endpoint
2. Server responds with HTTP 402 and a payment quote
3. Client transfers USDC on Solana with a memo containing the payment ID
4. Client retries the request with the quote and transaction signature in headers
5. Server verifies the payment on-chain and returns the protected resource

## Requirements

- Node.js 18+
- Solana wallet with USDC
- Solana RPC endpoint

## Installation

```bash
npm install
```

## Configuration

Create a `.env` file:

```
PORT=8000
SOLANA_RPC=https://api.mainnet-beta.solana.com
MERCHANT_WALLET=<your_solana_wallet_pubkey>
```

## Running the Server

```bash
node index.js
```

The server exposes:
- `GET /v1/data` - Protected endpoint (requires payment)
- `GET /health` - Health check (no payment required)

## Running the Client

The example client requires a Solana keypair file with USDC balance.

```bash
KEYPAIR_PATH=./keypair.json node client.js
```

Environment variables:
- `SERVER_URL` - API endpoint (default: `https://api.blink402.com`)
- `SOLANA_RPC` - Solana RPC URL
- `KEYPAIR_PATH` - Path to Solana keypair JSON file

## Protocol Specification

See [PROTOCOL.md](./PROTOCOL.md) for the complete protocol specification.

## Privacy

blind402 stores no user identity. There are no accounts, sessions, cookies, or tracking. The only data retained is transaction signatures for replay protection, which expire after 15 minutes.

