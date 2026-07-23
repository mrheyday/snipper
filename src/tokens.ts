import { Token } from '@uniswap/sdk-core';
import { Signer, BigNumber, BigNumberish, Contract, providers } from 'ethers';
import { CHAIN_ID } from './config';
import { Provider } from '@ethersproject/providers';
import axios, { AxiosRequestConfig } from 'axios';
import { config as loadEnvironmentVariables } from 'dotenv';
import { validateAndChecksumAddress } from './validation';
import { Logger } from './logger';
import { RateLimiter } from './rateLimiter';

loadEnvironmentVariables();

const logger = new Logger('TokenDetector');

// Rate limiter for Bitquery API (2 requests per second to avoid hitting limits)
const bitqueryRateLimiter = new RateLimiter({
  maxRequests: 2,
  windowMs: 1000,
  retryDelayMs: 500,
  maxRetries: 3,
});

const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function allowance(address, address) external view returns (uint256)',
  'function approve(address, uint) external returns (bool)',
  'function balanceOf(address) external view returns(uint256)',
];

export type TokenWithContract = {
  contract: Contract;
  walletHas: (signer: Signer, requiredAmount: BigNumberish) => Promise<boolean>;
  token: Token;
};

export const buildERC20TokenWithContract = async (
  address: string,
  provider: Provider
): Promise<TokenWithContract | null> => {
  try {
    // Validate and checksum address
    const checksummedAddress = validateAndChecksumAddress(address);

    const contract = new Contract(checksummedAddress, ERC20_ABI, provider);

    const [name, symbol, decimals] = await Promise.all([
      contract.name(),
      contract.symbol(),
      contract.decimals(),
    ]);

    if (!name || !symbol || decimals === undefined) {
      logger.warn(`Token at ${checksummedAddress} missing required fields`);
      return null;
    }

    return {
      contract: contract,

      walletHas: async (signer, requiredAmount) => {
        const signerBalance = await contract.connect(signer).balanceOf(await signer.getAddress());
        return signerBalance.gte(BigNumber.from(requiredAmount));
      },

      token: new Token(CHAIN_ID, checksummedAddress, decimals, symbol, name),
    };
  } catch (error) {
    logger.error(
      `Failed to fetch token details for ${address}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
};

// Example usage for ARBITRUM
const provider = new providers.JsonRpcProvider(process.env.RPC);

export type Tokens = {
  Token0: TokenWithContract | null;
  Token1: TokenWithContract | null;
};

export const getTokens = async (): Promise<Tokens> => {
  try {
    const data = JSON.stringify({
      query: `query {
  EVM(network: arbitrum) {
    Events(
      limit: {count:1}
      orderBy: {descending: Block_Time}
      where: {Log: {Signature: {Name: {is: "PoolCreated"}}, SmartContract: {is: "0x1F98431c8aD98523631AE4a59f267346ea31F984"}}}
    ) {
      Transaction {
        Hash
      }
      Block {
        Time
      }
      Log {
        Signature {
          Name
        }
      }
      Arguments {
        Name
        Type
        Value {
          ... on EVM_ABI_Integer_Value_Arg {
            integer
          }
          ... on EVM_ABI_String_Value_Arg {
            string
          }
          ... on EVM_ABI_Address_Value_Arg {
            address
          }
          ... on EVM_ABI_BigInt_Value_Arg {
            bigInteger
          }
          ... on EVM_ABI_Bytes_Value_Arg {
            hex
          }
          ... on EVM_ABI_Boolean_Value_Arg {
            bool
          }
        }
      }
    }
  }
}`,
      variables: '{}',
    });

    const axiosConfig: AxiosRequestConfig = {
      method: 'post',
      maxBodyLength: Infinity,
      url: 'https://streaming.bitquery.io/graphql',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.BITQUERY_TOKEN}`,
      },
      data: data,
    };

    // Execute with rate limiting and retry logic
    const response = await bitqueryRateLimiter.execute(
      () => axios.request(axiosConfig),
      (error) => {
        // Retry on rate limit (429) or temporary server errors (5xx)
        if (axios.isAxiosError(error)) {
          return error.response?.status === 429 || (error.response?.status || 0) >= 500;
        }
        return false;
      }
    );

    if (!response.data.data?.EVM?.Events || response.data.data.EVM.Events.length === 0) {
      console.error('No recent pool creation events found');
      return { Token0: null, Token1: null };
    }

    const events = response.data.data.EVM.Events[0];
    if (!events.Arguments || events.Arguments.length < 2) {
      console.error('Invalid event structure: missing Arguments');
      return { Token0: null, Token1: null };
    }

    const token0Address = events.Arguments[0].Value.address;
    const token1Address = events.Arguments[1].Value.address;

    if (!token0Address || !token1Address) {
      logger.error('Pool creation event missing token addresses');
      return { Token0: null, Token1: null };
    }

    logger.info(`Detected tokens: ${token0Address} ↔ ${token1Address}`);

    const [Token0, Token1] = await Promise.all([
      buildERC20TokenWithContract(token0Address, provider),
      buildERC20TokenWithContract(token1Address, provider),
    ]);

    // Both tokens must be valid
    if (!Token0 || !Token1) {
      logger.error('Failed to build one or both ERC20 token wrappers');
      return { Token0: null, Token1: null };
    }

    logger.info(`✓ Tokens loaded: ${Token0.token.symbol} ↔ ${Token1.token.symbol}`);
    return { Token0, Token1 };
  } catch (error) {
    logger.error(
      `Error fetching tokens from Bitquery: ${error instanceof Error ? error.message : String(error)}`
    );
    return { Token0: null, Token1: null };
  }
};

/**
 * Subscribe to real-time PoolCreated events via Bitquery WebSocket interface.
 * Fallbacks to HTTP polling if WebSocket connection fails.
 */
export const subscribeToTokens = (
  onTokensDetected: (tokens: Tokens) => void,
  onError?: (error: Error) => void
): { unsubscribe: () => void } => {
  let active = true;
  let ws: InstanceType<typeof globalThis.WebSocket> | null = null;
  const token = process.env.BITQUERY_TOKEN;

  if (!token) {
    logger.warn('No BITQUERY_TOKEN configured; defaulting to HTTP polling for pool detection.');
    getTokens()
      .then((t) => active && onTokensDetected(t))
      .catch((err) => onError && onError(err));
    return {
      unsubscribe: () => {
        active = false;
      },
    };
  }

  try {
    const WebSocketClient = globalThis.WebSocket;
    if (!WebSocketClient) {
      throw new Error('Native WebSocket client unavailable in environment');
    }

    const wsUrl = `wss://streaming.bitquery.io/graphql?token=${encodeURIComponent(token)}`;
    ws = new WebSocketClient(wsUrl);

    ws.onopen = () => {
      logger.info('⚡ Bitquery WebSocket stream connected for sub-second pool detection');
      const subscriptionPayload = {
        type: 'start',
        id: '1',
        payload: {
          query: `subscription {
  EVM(network: arbitrum) {
    Events(
      where: {Log: {Signature: {Name: {is: "PoolCreated"}}, SmartContract: {is: "0x1F98431c8aD98523631AE4a59f267346ea31F984"}}}
    ) {
      Arguments {
        Name
        Value {
          ... on EVM_ABI_Address_Value_Arg { address }
        }
      }
    }
  }
}`,
        },
      };
      ws?.send(JSON.stringify(subscriptionPayload));
    };

    ws.onmessage = async (event: { data: unknown }) => {
      if (!active) return;
      try {
        const parsed = JSON.parse(String(event.data));
        const eventData = parsed?.payload?.data?.EVM?.Events?.[0];
        if (eventData?.Arguments && eventData.Arguments.length >= 2) {
          const t0 = eventData.Arguments[0]?.Value?.address;
          const t1 = eventData.Arguments[1]?.Value?.address;
          if (t0 && t1) {
            logger.info(`⚡ Real-time PoolCreated WebSocket event: ${t0} ↔ ${t1}`);
            const [Token0, Token1] = await Promise.all([
              buildERC20TokenWithContract(t0, provider),
              buildERC20TokenWithContract(t1, provider),
            ]);
            if (Token0 && Token1) {
              onTokensDetected({ Token0, Token1 });
            }
          }
        }
      } catch (err) {
        logger.error(
          `Error parsing WebSocket event payload: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    };

    ws.onerror = () => {
      logger.warn(`Bitquery WebSocket error encountered. Switching to fallback HTTP query.`);
      if (onError) onError(new Error('WebSocket error'));
      getTokens()
        .then((t) => active && onTokensDetected(t))
        .catch((err) => onError && onError(err));
    };

    ws.onclose = () => {
      logger.info('Bitquery WebSocket stream closed');
    };
  } catch (error) {
    logger.warn(
      `Failed to initialize WebSocket subscription (${error instanceof Error ? error.message : String(error)}); falling back to HTTP query.`
    );
    getTokens()
      .then((t) => active && onTokensDetected(t))
      .catch((err) => onError && onError(err));
  }

  return {
    unsubscribe: () => {
      active = false;
      if (ws && ws.readyState === ws.OPEN) {
        ws.close();
      }
    },
  };
};
