# @blind402/client

Client SDK for blind402 - HTTP 402 payments with Solana USDC.

## Installation

```bash
npm install @blind402/client
```

## Usage

### With wallet adapter (recommended)

```javascript
import { Blind402Client } from '@blind402/client';
import { useWallet } from '@solana/wallet-adapter-react';

const client = new Blind402Client({
  rpcUrl: 'https://api.mainnet-beta.solana.com'
});

// In your component
const wallet = useWallet();

const response = await client.request(
  'https://api.example.com/v1/data',
  { method: 'GET' },
  wallet
);

const data = await response.json();
```

### Manual payment flow

```javascript
import { Blind402Client } from '@blind402/client';

const client = new Blind402Client();

// Step 1: Make initial request
const response = await fetch('https://api.example.com/v1/data');

if (Blind402Client.isPaymentRequired(response)) {
  // Step 2: Parse quote
  const quote = await Blind402Client.parseQuote(response);
  
  // Step 3: Pay (with your wallet)
  const signature = await client.pay(quote, wallet);
  
  // Step 4: Retry with proof
  const finalResponse = await fetch('https://api.example.com/v1/data', {
    headers: {
      'X-BLIND402-QUOTE': JSON.stringify(quote),
      'X-BLIND402-PAYMENT': signature,
    }
  });
}
```

## API

### `new Blind402Client(options?)`

Create a new client instance.

- `options.rpcUrl` - Solana RPC URL (default: mainnet)

### `client.request(url, options?, wallet)`

Make a request, automatically paying if 402 is returned.

### `client.pay(quote, wallet)`

Pay a quote directly. Returns transaction signature.

### `Blind402Client.isPaymentRequired(response)`

Check if response is 402.

### `Blind402Client.parseQuote(response)`

Parse quote from 402 response.

## License

MIT

