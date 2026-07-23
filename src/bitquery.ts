/**
 * Bitquery client — HTTP GraphQL + graphql-ws subscriptions (Arbitrum).
 * Docs: https://docs.bitquery.io/llms-full.txt
 */
import axios, { AxiosRequestConfig } from 'axios';
import { config as loadEnv } from 'dotenv';
import { Logger } from './logger';
import { RateLimiter } from './rateLimiter';

loadEnv();

const logger = new Logger('Bitquery');

export const BITQUERY_HTTP = 'https://streaming.bitquery.io/graphql';
export const BITQUERY_WS = 'wss://streaming.bitquery.io/graphql';
export const UNI_V3_FACTORY_ARBITRUM = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
export const WETH_ARBITRUM = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';

const rateLimiter = new RateLimiter({
  maxRequests: 2,
  windowMs: 1000,
  retryDelayMs: 500,
  maxRetries: 3,
});

export type PoolCreatedEvent = {
  token0: string;
  token1: string;
  fee?: number;
  pool?: string;
  txHash?: string;
  blockTime?: string;
};

export type DexTradeEvent = {
  protocol?: string;
  buyToken?: string;
  sellToken?: string;
  buyAmount?: string;
  sellAmount?: string;
  buyer?: string;
  seller?: string;
  price?: number;
  txHash?: string;
};

export type SlippageLevel = {
  price: string;
  maxAmountIn: string;
  minAmountOut: string;
};

export type PoolSlippage = {
  pool: string;
  currencyA: string;
  currencyB: string;
  slippageBps: number;
  atoB?: SlippageLevel;
  btoA?: SlippageLevel;
  protocol?: string;
};

export type PoolLiquidity = {
  pool: string;
  currencyA: string;
  currencyB: string;
  amountA: string;
  amountB: string;
  atoBPrice?: string;
  btoAPrice?: string;
  protocol?: string;
  txHash?: string;
};

export type Unsubscribe = { unsubscribe: () => void };

function token(): string {
  return process.env.BITQUERY_TOKEN || '';
}

function argAddress(args: Array<{ Name?: string; Value?: { address?: string } }>, name: string): string | undefined {
  const hit = args.find((a) => (a.Name || '').toLowerCase() === name.toLowerCase());
  return hit?.Value?.address;
}

function parsePoolArgs(args: Array<{ Name?: string; Value?: { address?: string; integer?: number; bigInteger?: string } }>): PoolCreatedEvent | null {
  if (!args?.length) return null;
  const token0 = argAddress(args as never, 'token0') || args[0]?.Value?.address;
  const token1 = argAddress(args as never, 'token1') || args[1]?.Value?.address;
  if (!token0 || !token1) return null;
  const feeArg = args.find((a) => (a.Name || '').toLowerCase() === 'fee');
  const pool = argAddress(args as never, 'pool');
  const feeRaw = feeArg?.Value?.integer ?? (feeArg?.Value?.bigInteger ? Number(feeArg.Value.bigInteger) : undefined);
  return { token0, token1, fee: feeRaw, pool };
}

/** Keep only pools that pair with WETH (flash-loan friendly). */
export function isWethPair(token0: string, token1: string, weth = WETH_ARBITRUM): boolean {
  const w = weth.toLowerCase();
  return token0.toLowerCase() === w || token1.toLowerCase() === w;
}

export class BitqueryClient {
  private readonly auth: string;
  private readonly httpUrl: string;
  private readonly wsUrl: string;

  constructor(opts?: { token?: string; httpUrl?: string; wsUrl?: string }) {
    this.auth = opts?.token ?? token();
    this.httpUrl = opts?.httpUrl ?? BITQUERY_HTTP;
    this.wsUrl = opts?.wsUrl ?? BITQUERY_WS;
  }

  get configured(): boolean {
    return Boolean(this.auth);
  }

  async query<T = unknown>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    if (!this.auth) throw new Error('BITQUERY_TOKEN not configured');
    const cfg: AxiosRequestConfig = {
      method: 'post',
      url: this.httpUrl,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.auth}`,
      },
      data: { query, variables },
      maxBodyLength: Infinity,
      timeout: 30_000,
    };
    const res = await rateLimiter.execute(
      () => axios.request(cfg),
      (err) => {
        if (axios.isAxiosError(err)) {
          const s = err.response?.status || 0;
          return s === 429 || s >= 500;
        }
        return false;
      }
    );
    if (res.data?.errors?.length) {
      throw new Error(`Bitquery GraphQL: ${JSON.stringify(res.data.errors)}`);
    }
    return res.data?.data as T;
  }

  /**
   * graphql-ws protocol over native WebSocket.
   * Auth: wss://...?token=... + Sec-WebSocket-Protocol: graphql-ws
   */
  subscribe(
    gql: string,
    onData: (data: unknown) => void,
    onError?: (e: Error) => void,
    variables: Record<string, unknown> = {}
  ): Unsubscribe {
    let active = true;
    let ws: WebSocket | null = null;
    let id = '1';
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    if (!this.auth) {
      const err = new Error('BITQUERY_TOKEN not configured');
      onError?.(err);
      return { unsubscribe: () => undefined };
    }

    const WebSocketClient = globalThis.WebSocket;
    if (!WebSocketClient) {
      const err = new Error('WebSocket unavailable in this runtime');
      onError?.(err);
      return { unsubscribe: () => undefined };
    }

    const connect = () => {
      if (!active) return;
      const url = `${this.wsUrl}?token=${encodeURIComponent(this.auth)}`;
      try {
        ws = new WebSocketClient(url, 'graphql-ws');
      } catch (e) {
        // Some environments reject protocol array form — retry with header-less ctor
        ws = new WebSocketClient(url);
      }

      ws.onopen = () => {
        attempt = 0;
        logger.info('Bitquery WS connected (graphql-ws)');
        ws?.send(JSON.stringify({ type: 'connection_init', payload: {} }));
      };

      ws.onmessage = (event: { data: unknown }) => {
        if (!active) return;
        let msg: { type?: string; id?: string; payload?: { data?: unknown; errors?: unknown } };
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          return;
        }
        switch (msg.type) {
          case 'connection_ack':
            id = String(Date.now());
            ws?.send(
              JSON.stringify({
                type: 'start',
                id,
                payload: { query: gql, variables },
              })
            );
            break;
          case 'data':
          case 'next':
            if (msg.payload?.errors) {
              onError?.(new Error(JSON.stringify(msg.payload.errors)));
            }
            if (msg.payload?.data !== undefined) onData(msg.payload.data);
            break;
          case 'error':
            onError?.(new Error(JSON.stringify(msg.payload ?? msg)));
            break;
          case 'complete':
            logger.info('Bitquery subscription complete');
            break;
          case 'ka':
          case 'ping':
            if (msg.type === 'ping') ws?.send(JSON.stringify({ type: 'pong' }));
            break;
          default:
            break;
        }
      };

      ws.onerror = () => {
        logger.warn('Bitquery WS error');
        onError?.(new Error('Bitquery WebSocket error'));
      };

      ws.onclose = () => {
        if (!active) return;
        const delay = Math.min(30_000, 1000 * 2 ** attempt);
        attempt += 1;
        logger.warn(`Bitquery WS closed; reconnect in ${delay}ms (attempt ${attempt})`);
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return {
      unsubscribe: () => {
        active = false;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        try {
          if (ws && ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'stop', id }));
            ws.close();
          }
        } catch {
          /* ignore */
        }
        ws = null;
      },
    };
  }

  // ── PoolCreated ──────────────────────────────────────────────────────────

  async latestPoolCreated(opts?: {
    factory?: string;
    wethOnly?: boolean;
    limit?: number;
  }): Promise<PoolCreatedEvent[]> {
    const factory = opts?.factory ?? UNI_V3_FACTORY_ARBITRUM;
    const limit = opts?.limit ?? 5;
    const q = `
query LatestPools($factory: String!, $limit: Int!) {
  EVM(network: arbitrum) {
    Events(
      limit: {count: $limit}
      orderBy: {descending: Block_Time}
      where: {
        Log: {
          Signature: {Name: {is: "PoolCreated"}}
          SmartContract: {is: $factory}
        }
      }
    ) {
      Transaction { Hash }
      Block { Time }
      Arguments {
        Name
        Value {
          ... on EVM_ABI_Integer_Value_Arg { integer }
          ... on EVM_ABI_Address_Value_Arg { address }
          ... on EVM_ABI_BigInt_Value_Arg { bigInteger }
        }
      }
    }
  }
}`;
    const data = await this.query<{
      EVM?: { Events?: Array<{ Transaction?: { Hash?: string }; Block?: { Time?: string }; Arguments?: unknown[] }> };
    }>(q, { factory, limit });

    const out: PoolCreatedEvent[] = [];
    for (const ev of data?.EVM?.Events ?? []) {
      const parsed = parsePoolArgs(ev.Arguments as never);
      if (!parsed) continue;
      if (opts?.wethOnly !== false && !isWethPair(parsed.token0, parsed.token1)) continue;
      out.push({
        ...parsed,
        txHash: ev.Transaction?.Hash,
        blockTime: ev.Block?.Time,
      });
    }
    return out;
  }

  subscribePoolCreated(
    onPool: (pool: PoolCreatedEvent) => void,
    opts?: { factory?: string; wethOnly?: boolean; onError?: (e: Error) => void }
  ): Unsubscribe {
    const factory = opts?.factory ?? UNI_V3_FACTORY_ARBITRUM;
    const wethOnly = opts?.wethOnly !== false;
    const gql = `
subscription PoolCreated($factory: String!) {
  EVM(network: arbitrum) {
    Events(
      where: {
        Log: {
          Signature: {Name: {is: "PoolCreated"}}
          SmartContract: {is: $factory}
        }
      }
    ) {
      Transaction { Hash }
      Block { Time }
      Arguments {
        Name
        Value {
          ... on EVM_ABI_Integer_Value_Arg { integer }
          ... on EVM_ABI_Address_Value_Arg { address }
          ... on EVM_ABI_BigInt_Value_Arg { bigInteger }
        }
      }
    }
  }
}`;
    return this.subscribe(
      gql,
      (raw) => {
        const events =
          (raw as { EVM?: { Events?: Array<{ Transaction?: { Hash?: string }; Block?: { Time?: string }; Arguments?: unknown[] }> } })
            ?.EVM?.Events ?? [];
        for (const ev of events) {
          const parsed = parsePoolArgs(ev.Arguments as never);
          if (!parsed) continue;
          if (wethOnly && !isWethPair(parsed.token0, parsed.token1)) {
            logger.info(`skip non-WETH pool ${parsed.token0} / ${parsed.token1}`);
            continue;
          }
          onPool({
            ...parsed,
            txHash: ev.Transaction?.Hash,
            blockTime: ev.Block?.Time,
          });
        }
      },
      opts?.onError,
      { factory }
    );
  }

  // ── DEX trades ───────────────────────────────────────────────────────────

  subscribeDexTrades(
    onTrade: (t: DexTradeEvent) => void,
    opts?: {
      token?: string;
      pairBase?: string;
      pairQuote?: string;
      onError?: (e: Error) => void;
    }
  ): Unsubscribe {
    // Prefer chain DEXTrades cube for pool-side Buy/Sell detail.
    let filter = '';
    if (opts?.token) {
      filter = `where: {any: [
        {Trade: {Buy: {Currency: {SmartContract: {is: "${opts.token}"}}}}},
        {Trade: {Sell: {Currency: {SmartContract: {is: "${opts.token}"}}}}}
      ]}`;
    } else if (opts?.pairBase && opts?.pairQuote) {
      filter = `where: {
        Trade: {
          Sell: {Currency: {SmartContract: {is: "${opts.pairBase}"}}}
          Buy: {Currency: {SmartContract: {is: "${opts.pairQuote}"}}}
        }
      }`;
    }
    const gql = `
subscription DexTrades {
  EVM(network: arbitrum) {
    DEXTrades${filter ? `(${filter})` : ''} {
      Transaction { Hash }
      Trade {
        Dex { ProtocolName ProtocolFamily }
        Buy {
          Amount Buyer
          Currency { SmartContract Symbol }
          Price
        }
        Sell {
          Amount Seller
          Currency { SmartContract Symbol }
          Price
        }
      }
    }
  }
}`;
    return this.subscribe(
      gql,
      (raw) => {
        const trades =
          (raw as { EVM?: { DEXTrades?: Array<Record<string, unknown>> } })?.EVM?.DEXTrades ?? [];
        for (const row of trades) {
          const trade = row.Trade as {
            Dex?: { ProtocolName?: string };
            Buy?: { Amount?: string; Buyer?: string; Currency?: { SmartContract?: string }; Price?: number };
            Sell?: { Amount?: string; Seller?: string; Currency?: { SmartContract?: string }; Price?: number };
          };
          const tx = row.Transaction as { Hash?: string } | undefined;
          onTrade({
            protocol: trade?.Dex?.ProtocolName,
            buyToken: trade?.Buy?.Currency?.SmartContract,
            sellToken: trade?.Sell?.Currency?.SmartContract,
            buyAmount: trade?.Buy?.Amount,
            sellAmount: trade?.Sell?.Amount,
            buyer: trade?.Buy?.Buyer,
            seller: trade?.Sell?.Seller,
            price: trade?.Buy?.Price ?? trade?.Sell?.Price,
            txHash: tx?.Hash,
          });
        }
      },
      opts?.onError
    );
  }

  // ── Slippage / depth ───────────────────────────────────────────────────

  async poolSlippage(pool: string, limit = 8): Promise<PoolSlippage[]> {
    const q = `
query PoolSlippage($pool: String!, $limit: Int!) {
  EVM(network: arbitrum) {
    DEXPoolSlippages(
      where: {Price: {Pool: {SmartContract: {is: $pool}}}}
      limit: {count: $limit}
      orderBy: {descending: Block_Time}
    ) {
      Price {
        SlippageBasisPoints
        AtoB { Price MinAmountOut MaxAmountIn }
        BtoA { Price MinAmountOut MaxAmountIn }
        Pool {
          SmartContract
          CurrencyA { SmartContract }
          CurrencyB { SmartContract }
        }
        Dex { ProtocolName }
      }
    }
  }
}`;
    const data = await this.query<{
      EVM?: {
        DEXPoolSlippages?: Array<{
          Price?: {
            SlippageBasisPoints?: number | string;
            AtoB?: { Price?: string; MinAmountOut?: string; MaxAmountIn?: string };
            BtoA?: { Price?: string; MinAmountOut?: string; MaxAmountIn?: string };
            Pool?: {
              SmartContract?: string;
              CurrencyA?: { SmartContract?: string };
              CurrencyB?: { SmartContract?: string };
            };
            Dex?: { ProtocolName?: string };
          };
        }>;
      };
    }>(q, { pool, limit });

    return (data?.EVM?.DEXPoolSlippages ?? []).map((row) => {
      const p = row.Price;
      const mapLvl = (l?: { Price?: string; MinAmountOut?: string; MaxAmountIn?: string }) =>
        l
          ? {
              price: String(l.Price ?? ''),
              maxAmountIn: String(l.MaxAmountIn ?? '0'),
              minAmountOut: String(l.MinAmountOut ?? '0'),
            }
          : undefined;
      return {
        pool: p?.Pool?.SmartContract ?? pool,
        currencyA: p?.Pool?.CurrencyA?.SmartContract ?? '',
        currencyB: p?.Pool?.CurrencyB?.SmartContract ?? '',
        slippageBps: Number(p?.SlippageBasisPoints ?? 0),
        atoB: mapLvl(p?.AtoB),
        btoA: mapLvl(p?.BtoA),
        protocol: p?.Dex?.ProtocolName,
      };
    });
  }

  /**
   * Best-effort max input for borrow token at a target slippage (default 50 bps).
   * Returns null if Bitquery has no row or tokens don't match pool orientation.
   */
  async maxInputAtSlippage(
    pool: string,
    tokenIn: string,
    targetSlippageBps = 50
  ): Promise<string | null> {
    try {
      const rows = await this.poolSlippage(pool, 20);
      if (!rows.length) return null;
      const tIn = tokenIn.toLowerCase();
      // Prefer exact bps match; else nearest <= target; else smallest bps row.
      const scored = [...rows].sort((a, b) => {
        const da = Math.abs(a.slippageBps - targetSlippageBps);
        const db = Math.abs(b.slippageBps - targetSlippageBps);
        return da - db;
      });
      const best = scored[0];
      const aIsIn = best.currencyA.toLowerCase() === tIn;
      const bIsIn = best.currencyB.toLowerCase() === tIn;
      if (aIsIn && best.atoB?.maxAmountIn) return best.atoB.maxAmountIn;
      if (bIsIn && best.btoA?.maxAmountIn) return best.btoA.maxAmountIn;
      // fallback: larger of the two maxes
      const a = best.atoB?.maxAmountIn;
      const b = best.btoA?.maxAmountIn;
      if (a && b) return BigInt(a) > BigInt(b) ? a : b;
      return a ?? b ?? null;
    } catch (e) {
      logger.warn(
        `maxInputAtSlippage failed: ${e instanceof Error ? e.message : String(e)}`
      );
      return null;
    }
  }

  async poolLiquidity(pool: string, limit = 3): Promise<PoolLiquidity[]> {
    const q = `
query PoolLiq($pool: String!, $limit: Int!) {
  EVM(network: arbitrum) {
    DEXPoolEvents(
      limit: {count: $limit}
      orderBy: {descending: Block_Time}
      where: {PoolEvent: {Pool: {SmartContract: {is: $pool}}}}
    ) {
      Transaction { Hash }
      PoolEvent {
        AtoBPrice
        BtoAPrice
        Dex { ProtocolName }
        Liquidity { AmountCurrencyA AmountCurrencyB }
        Pool {
          SmartContract
          CurrencyA { SmartContract }
          CurrencyB { SmartContract }
        }
      }
    }
  }
}`;
    const data = await this.query<{
      EVM?: {
        DEXPoolEvents?: Array<{
          Transaction?: { Hash?: string };
          PoolEvent?: {
            AtoBPrice?: string;
            BtoAPrice?: string;
            Dex?: { ProtocolName?: string };
            Liquidity?: { AmountCurrencyA?: string; AmountCurrencyB?: string };
            Pool?: {
              SmartContract?: string;
              CurrencyA?: { SmartContract?: string };
              CurrencyB?: { SmartContract?: string };
            };
          };
        }>;
      };
    }>(q, { pool, limit });

    return (data?.EVM?.DEXPoolEvents ?? []).map((row) => {
      const pe = row.PoolEvent;
      return {
        pool: pe?.Pool?.SmartContract ?? pool,
        currencyA: pe?.Pool?.CurrencyA?.SmartContract ?? '',
        currencyB: pe?.Pool?.CurrencyB?.SmartContract ?? '',
        amountA: String(pe?.Liquidity?.AmountCurrencyA ?? '0'),
        amountB: String(pe?.Liquidity?.AmountCurrencyB ?? '0'),
        atoBPrice: pe?.AtoBPrice !== undefined ? String(pe.AtoBPrice) : undefined,
        btoAPrice: pe?.BtoAPrice !== undefined ? String(pe.BtoAPrice) : undefined,
        protocol: pe?.Dex?.ProtocolName,
        txHash: row.Transaction?.Hash,
      };
    });
  }

  /**
   * Resolve Uniswap V3 pool address for a token pair via factory getPool on-chain
   * is preferred; this uses latest PoolCreated involving both tokens when known.
   */
  async findRecentWethPools(limit = 10): Promise<PoolCreatedEvent[]> {
    return this.latestPoolCreated({ wethOnly: true, limit });
  }
}

export const bitquery = new BitqueryClient();
export default bitquery;
