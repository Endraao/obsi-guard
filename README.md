# Obsi Guard

Most trading agents pay for data before they know a coin is safe. Obsi Guard reads the coin on Solana first and pays for a swap quote only if it passes. You sign every swap in your own wallet.

## How it works

1. You connect a Solana wallet (MetaMask, Phantom or any Wallet Standard wallet) and paste a coin address.
2. Obsi Guard checks the chain: mint authority, freeze authority, liquidity and how much the top 10 personal wallets hold.
3. If any check fails, or can't be read, it stops and spends nothing.
4. If the coin passes, the agent calls the Swap.io Agent API. The API answers `402 Payment Required`, the agent pays in USDC through x402, repeats the request and gets the best route.
5. When you ask for the swap, the agent builds an unsigned transaction. You review and sign it in your wallet.

## Why Solana

Each quote costs about $0.003 and settles on-chain in seconds. Paying per call only works when payments are this fast and this cheap.

## Safety limits

- The agent never holds your funds and never signs your swap.
- One API call can't cost more than $0.02.
- Passing the checks does not make a coin safe. This is not financial advice.

## Run it

Requires Node.js 22 or newer.

```bash
npm install
```

Create a `.env` file with your own RPC:

```text
SOLANA_RPC=https://your-rpc-url
```

Put the agent wallet in `agent-wallet.json` (a small test wallet holding USDC), then start:

```bash
node --env-file=.env server.mjs
```

Open http://localhost:5610. To test without paying, start with `DRY_RUN=1`.

## Proof

Paid x402 call to the Swap.io Agent API: https://solscan.io/tx/2b1NRgCjDF6vodsgFvwqnppunpJgpuN7EjyjT5FChZEUNKoZEHePPZeG7st5GhkTGLytqHaD3oT1sDx3aPYAjoTh

Full run on mainnet, built by the agent and signed by the user: https://solscan.io/tx/5T3n8iUgf13PEJPtXB7GHo5a8t4LTD1yLs1PH3U7LQLXknaUhzii6kYQ3jgauu5JkirKnG3ZCYEkAoQpP5UnpPT7

## License

MIT
