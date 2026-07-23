import { Token } from '@uniswap/sdk-core';
import { JsonRpcProvider, Signer, Contract, ethers } from 'ethers';
import { CHAIN_ID } from './config';
import type { Provider } from 'ethers';
import { config as loadEnvironmentVariables } from 'dotenv';
import { validateAndChecksumAddress } from './validation';
import { Logger } from './logger';
import {
  bitquery,
  isWethPair,
  PoolCreatedEvent,
  WETH_ARBITRUM,
  type Unsubscribe,
} from './bitquery';

loadEnvironmentVariables();

const logger = new Logger('TokenDetector');

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
  walletHas: (signer: Signer, requiredAmount: bigint | string | number) => Promise<boolean>;
  token: Token;
};

export const buildERC20TokenWithContract = async (
  address: string,
  provider: Provider
): Promise<TokenWithContract | null> => {
  try {
    const checksummedAddress = validateAndChecksumAddress(address);
    const contract = new Contract(checksummedAddress, ERC20_ABI, provider) as Contract & {
      name(): Promise<string>; symbol(): Promise<string>; decimals(): Promise<number>;
      balanceOf(a: string): Promise<bigint>; allowance(o:string,s:string):Promise<bigint>;
      approve(s:string,a:bigint):Promise<ethers.ContractTransactionResponse>;
    };
    const [name, symbol, decimals] = await Promise.all([
      contract.name(),
      contract.symbol(),
      contract.decimals(),
    ]);
    if (!name || !symbol || decimals === undefined) {
      logger.warn('Token at ' + checksummedAddress + ' missing required fields');
      return null;
    }
    return {
      contract,
      walletHas: async (signer, requiredAmount) => {
        const connected = contract.connect(signer) as typeof contract;
        const signerBalance = await connected.balanceOf(await signer.getAddress());
        return signerBalance >= BigInt(requiredAmount);
      },
      token: new Token(CHAIN_ID, checksummedAddress, decimals, symbol, name),
    };
  } catch (error) {
    logger.error(
      'Failed to fetch token details for ' +
        address +
        ': ' +
        (error instanceof Error ? error.message : String(error))
    );
    return null;
  }
};

const provider = new JsonRpcProvider(process.env.RPC);

export type Tokens = {
  Token0: TokenWithContract | null;
  Token1: TokenWithContract | null;
  pool?: string;
  fee?: number;
  txHash?: string;
};

async function tokensFromPool(ev: PoolCreatedEvent): Promise<Tokens> {
  const [Token0, Token1] = await Promise.all([
    buildERC20TokenWithContract(ev.token0, provider),
    buildERC20TokenWithContract(ev.token1, provider),
  ]);
  if (!Token0 || !Token1) {
    return { Token0: null, Token1: null };
  }
  return {
    Token0,
    Token1,
    pool: ev.pool,
    fee: ev.fee,
    txHash: ev.txHash,
  };
}

export const getTokens = async (opts?: { wethOnly?: boolean }): Promise<Tokens> => {
  try {
    if (!bitquery.configured) {
      logger.error('BITQUERY_TOKEN not set');
      return { Token0: null, Token1: null };
    }
    const wethOnly = opts?.wethOnly !== false;
    const pools = await bitquery.latestPoolCreated({ wethOnly, limit: 10 });
    if (!pools.length) {
      logger.error(
        wethOnly
          ? 'No recent WETH-paired PoolCreated events'
          : 'No recent PoolCreated events'
      );
      return { Token0: null, Token1: null };
    }
    const pick = pools[0];
    logger.info(
      'Detected pool: ' +
        pick.token0 +
        ' <-> ' +
        pick.token1 +
        (pick.pool ? ' @ ' + pick.pool : '') +
        (pick.fee !== undefined ? ' fee=' + pick.fee : '')
    );
    const tokens = await tokensFromPool(pick);
    if (!tokens.Token0 || !tokens.Token1) {
      logger.error('Failed to build ERC20 wrappers');
      return { Token0: null, Token1: null };
    }
    logger.info(
      'Tokens loaded: ' + tokens.Token0.token.symbol + ' <-> ' + tokens.Token1.token.symbol
    );
    return tokens;
  } catch (error) {
    logger.error(
      'Error fetching tokens from Bitquery: ' +
        (error instanceof Error ? error.message : String(error))
    );
    return { Token0: null, Token1: null };
  }
};

export const subscribeToTokens = (
  onTokensDetected: (tokens: Tokens) => void,
  onError?: (error: Error) => void,
  opts?: { wethOnly?: boolean }
): Unsubscribe => {
  if (!bitquery.configured) {
    logger.warn('No BITQUERY_TOKEN; one-shot HTTP pool detection.');
    getTokens({ wethOnly: opts?.wethOnly })
      .then((t) => onTokensDetected(t))
      .catch((err) => onError?.(err));
    return { unsubscribe: () => undefined };
  }

  logger.info('Subscribing to PoolCreated (graphql-ws, WETH filter default on)');
  return bitquery.subscribePoolCreated(
    async (pool) => {
      try {
        if (opts?.wethOnly !== false && !isWethPair(pool.token0, pool.token1, WETH_ARBITRUM)) {
          return;
        }
        logger.info(
          'PoolCreated: ' +
            pool.token0 +
            ' <-> ' +
            pool.token1 +
            (pool.pool ? ' pool=' + pool.pool : '')
        );
        const tokens = await tokensFromPool(pool);
        if (tokens.Token0 && tokens.Token1) onTokensDetected(tokens);
      } catch (e) {
        onError?.(e instanceof Error ? e : new Error(String(e)));
      }
    },
    {
      wethOnly: opts?.wethOnly !== false,
      onError: (e) => {
        logger.warn('PoolCreated stream error: ' + e.message + '; HTTP fallback once');
        onError?.(e);
        getTokens({ wethOnly: opts?.wethOnly })
          .then((t) => {
            if (t.Token0 && t.Token1) onTokensDetected(t);
          })
          .catch((err) => onError?.(err));
      },
    }
  );
};

export { isWethPair, WETH_ARBITRUM };
export type { PoolCreatedEvent };
