// Obsi Guard: reads a Solana coin on-chain first and pays for a swap quote
// (x402, USDC) only if the coin passes. The user always signs the swap.
import http from 'node:http';
import fs from 'node:fs';
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { createX402Client } from 'x402-solana/client';

const PORT = Number(process.env.PORT || 5610);
const RPC = process.env.SOLANA_RPC || 'https://solana-rpc.publicnode.com';
const API = 'https://hermes.swap.io/v1/swap';
const SOL = 'So11111111111111111111111111111111111111112';
const MAX_PER_CALL = 20000n; // never pays more than $0.02 for one call
const MIN_LIQUIDITY = 10000; // USD
const MAX_TOP10 = 60; // % of supply in personal wallets
const DRY_RUN = process.env.DRY_RUN === '1'; // stops at the 402, pays nothing

// Public demo limits. They reset each hour and protect the agent wallet and the RPC.
const HOUR = 3600000;
const uses = {};
function limit(name, max, message) {
  const now = Date.now();
  uses[name] = (uses[name] || []).filter((t) => now - t < HOUR);
  if (uses[name].length >= max) throw new Error(message);
  uses[name].push(now);
}

const conn = new Connection(RPC, 'confirmed');
const walletPath = process.env.AGENT_WALLET || 'agent-wallet.json';
const agent = fs.existsSync(walletPath)
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, 'utf8'))))
  : null;
const x402 = agent
  ? createX402Client({
      wallet: {
        address: agent.publicKey.toString(),
        signTransaction: async (tx) => {
          tx.sign([agent]);
          return tx;
        },
      },
      network: 'solana',
      amount: MAX_PER_CALL,
      rpcUrl: RPC,
    })
  : null;

/** Reads the mint, the largest holders and the liquidity. */
async function readCoin(mintText) {
  const mint = new PublicKey(mintText);
  const info = await conn.getParsedAccountInfo(mint);
  const parsed = info.value?.data?.parsed;
  if (parsed?.type !== 'mint') throw new Error('This address is not a Solana coin.');
  const { mintAuthority, freezeAuthority, supply, decimals } = parsed.info;
  const total = Number(supply) / 10 ** decimals;

  // Program-owned accounts (pools, bonding curves) are not personal wallets.
  // If the holders can't be read, the check fails: unknown is never "safe".
  let top10 = null;
  let counted = 0;
  try {
    const largest = (await conn.getTokenLargestAccounts(mint)).value.slice(0, 20);
    const accounts = await conn.getMultipleParsedAccounts(largest.map((a) => a.address));
    let personal = 0;
    largest.forEach((a, i) => {
      const owner = accounts.value[i]?.data?.parsed?.info?.owner;
      if (!owner || counted >= 10 || !PublicKey.isOnCurve(new PublicKey(owner))) return;
      personal += a.uiAmount || 0;
      counted += 1;
    });
    if (counted && total) top10 = (personal / total) * 100;
  } catch {
    /* too many holders or RPC limit */
  }

  let liquidity = 0;
  let symbol = '';
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintText}`);
    const pairs = ((await r.json()).pairs || []).filter((p) => p.chainId === 'solana');
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    liquidity = pairs[0]?.liquidity?.usd || 0;
    const base = pairs[0]?.baseToken;
    symbol = base?.address === mintText ? base.symbol : pairs[0]?.quoteToken?.symbol || '';
  } catch {
    /* no market data counts as no liquidity */
  }

  const checks = [
    { name: 'Mint authority', ok: !mintAuthority, detail: mintAuthority ? 'Someone can still print more' : 'Revoked' },
    { name: 'Freeze authority', ok: !freezeAuthority, detail: freezeAuthority ? 'Someone can freeze wallets' : 'Revoked' },
    { name: 'Liquidity', ok: liquidity >= MIN_LIQUIDITY, detail: `$${Math.round(liquidity).toLocaleString('en-US')}` },
    { name: 'Top 10 personal wallets', ok: top10 !== null && top10 <= MAX_TOP10, detail: top10 === null ? 'Could not read' : `${top10.toFixed(1)}% of supply` },
  ];
  return { symbol, checks, passed: checks.every((c) => c.ok) };
}

const quoteBody = (mint, lamports, user) => ({
  input: { token: SOL, amount: String(lamports), chainKey: 'sol' },
  output: { token: mint, chainKey: 'sol' },
  userAddress: user,
  slippageBps: 100,
});

/** Reads the price from the 402 reply. This request costs nothing. */
async function priceOf(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r.status !== 402) throw new Error(`Expected 402, got ${r.status}`);
  const d = await r.json();
  const offer = d.accepts.find((a) => a.network === 'solana');
  return { price: Number(offer.maxAmountRequired) / 1e6 };
}

/** Pays through x402 and returns the answer and the payment proof. */
async function paidCall(url, body) {
  const { price } = await priceOf(url, body);
  if (DRY_RUN) return { dryRun: true, price, proof: null, data: null };
  limit('paid', Number(process.env.PAID_PER_HOUR || 5), 'Demo limit reached: the agent has paid for 5 calls this hour. The chain check still works.');
  if (!x402) throw new Error('Agent wallet not found.');
  const r = await x402.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || data?.error || `API answered ${r.status}`);
  let proof = r.headers.get('x-payment-response');
  try {
    const d = JSON.parse(Buffer.from(proof, 'base64').toString('utf8'));
    proof = d.transaction || d.txHash || d.signature || proof;
  } catch {
    /* already plain text */
  }
  return { dryRun: false, price, proof, data };
}

/** Finds the transaction in the API answer, whatever the field or the encoding. */
function readTransaction(answer) {
  const texts = [];
  const walk = (v, path) => {
    if (typeof v === 'string' && v.length > 100) texts.push(v);
    else if (Array.isArray(v) && v.length && v.every((n) => typeof n === 'number')) texts.push(Uint8Array.from(v));
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], `${path}.${k}`);
  };
  walk(answer, '');
  for (const t of texts) {
    const tries = typeof t !== 'string'
      ? [t]
      : [
          () => Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
          () => Buffer.from(t.replace(/^0x/, ''), 'hex'),
          () => bs58.decode(t),
        ];
    for (const attempt of tries) {
      try {
        const bytes = typeof attempt === 'function' ? attempt() : attempt;
        // Only a real transaction goes to the wallet, in the new or the old format.
        try {
          VersionedTransaction.deserialize(bytes);
        } catch {
          Transaction.from(bytes);
        }
        return Buffer.from(bytes).toString('base64');
      } catch {
        /* try the next one */
      }
    }
  }
  const shape = JSON.stringify(answer, (k, v) => (typeof v === 'string' && v.length > 24 ? `<${v.length} chars: ${v.slice(0, 10)}>` : v));
  console.log('build-tx answer:', shape);
  throw new Error(`No transaction found in the API answer: ${shape.slice(0, 300)}`);
}

const quotes = new Map(); // quote id -> quote waiting for the user

const routes = {
  async '/api/check'({ mint, lamports, user }) {
    limit('check', 120, 'Too many checks this hour. Try again later.');
    const coin = await readCoin(mint);
    if (!coin.passed) return { ...coin, spent: 0, quote: null };
    const paid = await paidCall(`${API}/quote`, quoteBody(mint, lamports, user));
    if (paid.dryRun) return { ...coin, spent: 0, dryRun: true, price: paid.price, quote: null };
    const best = paid.data.quotes?.find((q) => q.bestQuote) || paid.data.quotes?.[0];
    if (!best) return { ...coin, spent: paid.price, proof: paid.proof, quote: null };
    const id = crypto.randomUUID();
    quotes.set(id, best);
    return { ...coin, spent: paid.price, proof: paid.proof, quote: { id, route: best.provider?.key || 'best route' } };
  },
  async '/api/build'({ id, user }) {
    const best = quotes.get(id);
    if (!best) throw new Error('This quote expired. Check the coin again.');
    const paid = await paidCall(`${API}/build-tx`, { provider: best.provider.key, userAddress: user, chainKey: 'sol', quoteResponse: best.providerQuote });
    quotes.delete(id);
    return { spent: paid.price, proof: paid.proof, transaction: readTransaction(paid.data) };
  },
  async '/api/rpc'(body) {
    if (body.method !== 'sendTransaction') throw new Error('Only sendTransaction is allowed.');
    limit('send', 30, 'Too many swaps this hour. Try again later.');
    const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  },
};

http
  .createServer(async (req, res) => {
    const send = (code, type, body) => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(body);
    };
    if (req.method === 'GET') return send(200, 'text/html; charset=utf-8', fs.readFileSync('index.html'));
    const route = routes[req.url];
    if (req.method !== 'POST' || !route) return send(404, 'text/plain', 'Not found');
    let text = '';
    for await (const part of req) text += part;
    try {
      send(200, 'application/json', JSON.stringify(await route(JSON.parse(text))));
    } catch (e) {
      send(400, 'application/json', JSON.stringify({ error: e.message }));
    }
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`Obsi Guard on http://localhost:${PORT}${DRY_RUN ? ' (dry run, pays nothing)' : ''}`);
    console.log(agent ? `Agent wallet: ${agent.publicKey}` : 'No agent wallet: paid calls are off');
  });
