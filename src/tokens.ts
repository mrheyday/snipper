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

type TokenWithContract = {
  contract: Contract;
  walletHas: (signer: Signer, requiredAmount: BigNumberish) => Promise<boolean>;
  token: Token;
};

const buildERC20TokenWithContract = async (
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

type Tokens = {
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
