import { ethers, Wallet } from 'ethers';
import { provider, signer, CHAIN_ID } from './config';
import { getEip1559Fees } from './fees';
import { Logger } from './logger';
import { validateAndChecksumAddress } from './validation';

const logger = new Logger('EIP7702');

/** EIP-7702 magic byte prepended to the authorization RLP payload before keccak. */
const AUTH_MAGIC = 0x05;
/** EIP-7702 / SetCode transaction type byte. */
const TX_TYPE_SET_CODE = 0x04;
/** Delegation designator prefix: 0xef0100 || address (23 bytes total). */
const DELEGATION_DESIGNATOR_PREFIX = '0xef0100';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const DELEGATED_EXECUTOR_IFACE = new ethers.Interface([
  'function executeSwap(address tokenIn, uint256 amountIn, bytes calldata path, uint256 minAmountOut, uint256 deadline) external returns (uint256)',
  'function executeSwapWithCallback(address tokenIn, uint256 amountIn, bytes calldata path, uint256 minAmountOut, uint256 deadline, bytes calldata callbackData) external returns (uint256)',
  'function executeBatchSwaps(tuple(address tokenIn,uint256 amountIn,bytes path,uint256 minAmountOut)[] swaps, uint256 deadline) external returns (uint256[])',
  'function allowEOA(address eoa) external',
  'function allowedEOAs(address eoa) view returns (bool)',
]);

/** ERC-7821 / BEBE multi-target batch executor (BasicEOABatchExecutor). */
const BATCH_EXECUTOR_IFACE = new ethers.Interface([
  'function execute(bytes32 mode, bytes executionData) payable',
  'function supportsExecutionMode(bytes32 mode) view returns (bool)',
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
]);

/**
 * ERC-7821 single-batch mode without opData.
 * Bytes: [0]=0x01 batch, [1]=0x00 revert-on-fail, rest zero / reserved.
 * Auth rule in Solady ERC7821: empty opData requires msg.sender == address(this)
 * which is exactly the EIP-7702 self-call pattern.
 */
export const ERC7821_MODE_BATCH_NO_OPDATA =
  '0x0100000000000000000000000000000000000000000000000000000000000000';

/** One CALL from the delegated EOA to an arbitrary target contract. */
export interface BatchCall {
  /** Target contract. address(0) is rewritten to address(this) by ERC7821. */
  to: string;
  value?: bigint;
  data: string;
}

export interface Authorization {
  chainId: number;
  address: string;
  nonce: number;
  yParity: number;
  r: string;
  s: string;
}

export interface DelegatedSwapParams {
  tokenIn: string;
  amountIn: bigint;
  path: Buffer | string;
  minAmountOut: bigint;
  deadline: number;
  gasLimit?: bigint;
  /** If true, clear EOA delegation after the swap with a follow-up type-4. */
  clearAfter?: boolean;
}

export interface DelegatedSwapResult {
  success: boolean;
  txHash?: string;
  amountOut?: bigint;
  error?: string;
  gasUsed?: bigint;
  authorization?: Authorization;
  delegationCode?: string;
}

export interface DelegationStatus {
  eoa: string;
  hasCode: boolean;
  isDelegated: boolean;
  delegate: string | null;
  code: string;
  nonce: number;
}

// ---------------------------------------------------------------------------
// Minimal RLP encode (bytes / uint / address / list) for type-4 + auth
// ---------------------------------------------------------------------------

function stripHexPrefix(hex: string): string {
  return hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
}

function hexToBuf(hex: string): Buffer {
  const h = stripHexPrefix(hex);
  if (h.length === 0) return Buffer.alloc(0);
  const even = h.length % 2 === 0 ? h : '0' + h;
  return Buffer.from(even, 'hex');
}

function bufToHex(buf: Buffer): string {
  return '0x' + buf.toString('hex');
}

function rlpEncodeBytes(input: Buffer): Buffer {
  if (input.length === 1 && input[0] < 0x80) {
    return input;
  }
  if (input.length <= 55) {
    return Buffer.concat([Buffer.from([0x80 + input.length]), input]);
  }
  const lenHex = input.length.toString(16);
  const lenBytes = Buffer.from(lenHex.length % 2 === 0 ? lenHex : '0' + lenHex, 'hex');
  return Buffer.concat([Buffer.from([0xb7 + lenBytes.length]), lenBytes, input]);
}

function rlpEncodeUint(value: bigint | string | number): Buffer {
  const bn = BigInt(value);
  if ((bn === 0n)) return rlpEncodeBytes(Buffer.alloc(0));
  let hex = ethers.toBeHex(bn).slice(2);
  if (hex.length % 2) hex = '0' + hex;
  return rlpEncodeBytes(Buffer.from(hex, 'hex'));
}

function rlpEncodeAddress(addr: string): Buffer {
  const clean = ethers.getAddress(addr);
  return rlpEncodeBytes(hexToBuf(clean));
}

function rlpEncodeHash32(hex: string): Buffer {
  const h = stripHexPrefix(hex).padStart(64, '0');
  return rlpEncodeBytes(Buffer.from(h, 'hex'));
}

function rlpEncodeList(items: Buffer[]): Buffer {
  const payload = Buffer.concat(items);
  if (payload.length <= 55) {
    return Buffer.concat([Buffer.from([0xc0 + payload.length]), payload]);
  }
  const lenHex = payload.length.toString(16);
  const lenBytes = Buffer.from(lenHex.length % 2 === 0 ? lenHex : '0' + lenHex, 'hex');
  return Buffer.concat([Buffer.from([0xf7 + lenBytes.length]), lenBytes, payload]);
}

// ---------------------------------------------------------------------------
// Authorization (EIP-7702 signing)
// ---------------------------------------------------------------------------

/**
 * Spec-compliant authorization digest:
 *   keccak256( 0x05 || rlp([chain_id, address, nonce]) )
 *
 * Do NOT use solidityPack, and do NOT personal_sign / signMessage (EIP-191).
 */
export function authorizationDigest(
  chainId: number,
  delegate: string,
  nonce: number
): string {
  const rlpAuth = rlpEncodeList([
    rlpEncodeUint(chainId),
    rlpEncodeAddress(delegate),
    rlpEncodeUint(nonce),
  ]);
  const payload = Buffer.concat([Buffer.from([AUTH_MAGIC]), rlpAuth]);
  return ethers.keccak256(payload);
}

/**
 * Sign an EIP-7702 authorization with a raw secp256k1 signature over the
 * authorization digest (no EIP-191 prefix).
 */
export async function signAuthorization(
  authority: Wallet,
  delegate: string,
  opts?: { chainId?: number; nonce?: number }
): Promise<Authorization> {
  const chainId = opts?.chainId ?? CHAIN_ID;
  const addr = await authority.getAddress();
  const nonce =
    opts?.nonce ?? (await provider.getTransactionCount(addr, 'pending'));
  const delegateCs = validateAndChecksumAddress(delegate);

  const digest = authorizationDigest(chainId, delegateCs, nonce);
  // Raw ECDSA over the 32-byte digest — NOT signMessage.
  const sig = authority.signingKey.sign(digest);

  return {
    chainId,
    address: delegateCs,
    nonce,
    yParity: sig.v === 27 ? 0 : 1,
    r: sig.r,
    s: sig.s,
  };
}

/** Authorize to the zero address to clear delegation. */
export async function signClearAuthorization(
  authority: Wallet,
  opts?: { chainId?: number; nonce?: number }
): Promise<Authorization> {
  return signAuthorization(authority, ZERO_ADDRESS, opts);
}

// ---------------------------------------------------------------------------
// Delegation designator helpers
// ---------------------------------------------------------------------------

export function isDelegationDesignator(code: string): boolean {
  if (!code || code === '0x') return false;
  const c = code.toLowerCase();
  return c.startsWith(DELEGATION_DESIGNATOR_PREFIX) && c.length === 2 + 6 + 40;
}

export function parseDelegate(code: string): string | null {
  if (!isDelegationDesignator(code)) return null;
  return ethers.getAddress('0x' + code.slice(8));
}

export async function getDelegationStatus(eoa: string): Promise<DelegationStatus> {
  const address = validateAndChecksumAddress(eoa);
  const [code, nonce] = await Promise.all([
    provider.getCode(address),
    provider.getTransactionCount(address, 'pending'),
  ]);
  const delegated = isDelegationDesignator(code);
  return {
    eoa: address,
    hasCode: code !== '0x' && code !== '0x0',
    isDelegated: delegated,
    delegate: delegated ? parseDelegate(code) : null,
    code,
    nonce,
  };
}

// ---------------------------------------------------------------------------
// Type-4 (SetCode) transaction encode + send
// ---------------------------------------------------------------------------

export interface Type4TxFields {
  chainId: number;
  nonce: number;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  to: string | null;
  value: bigint;
  data: string;
  accessList?: Array<{ address: string; storageKeys: string[] }>;
  authorizationList: Authorization[];
}

function rlpEncodeAccessList(
  list: Array<{ address: string; storageKeys: string[] }> = []
): Buffer {
  return rlpEncodeList(
    list.map((entry) =>
      rlpEncodeList([
        rlpEncodeAddress(entry.address),
        rlpEncodeList(entry.storageKeys.map((k) => rlpEncodeHash32(k))),
      ])
    )
  );
}

function rlpEncodeAuthList(auths: Authorization[]): Buffer {
  return rlpEncodeList(
    auths.map((auth) =>
      rlpEncodeList([
        rlpEncodeUint(auth.chainId),
        rlpEncodeAddress(auth.address),
        rlpEncodeUint(auth.nonce),
        rlpEncodeUint(auth.yParity),
        rlpEncodeHash32(auth.r),
        rlpEncodeHash32(auth.s),
      ])
    )
  );
}

function encodeType4Payload(
  fields: Type4TxFields,
  sig?: { yParity: number; r: string; s: string }
): Buffer {
  const toItem =
    fields.to === null || fields.to === undefined || fields.to === ''
      ? rlpEncodeBytes(Buffer.alloc(0))
      : rlpEncodeAddress(fields.to);

  const items: Buffer[] = [
    rlpEncodeUint(fields.chainId),
    rlpEncodeUint(fields.nonce),
    rlpEncodeUint(fields.maxPriorityFeePerGas),
    rlpEncodeUint(fields.maxFeePerGas),
    rlpEncodeUint(fields.gasLimit),
    toItem,
    rlpEncodeUint(fields.value),
    rlpEncodeBytes(hexToBuf(fields.data || '0x')),
    rlpEncodeAccessList(fields.accessList ?? []),
    rlpEncodeAuthList(fields.authorizationList),
  ];

  if (sig) {
    items.push(rlpEncodeUint(sig.yParity), rlpEncodeHash32(sig.r), rlpEncodeHash32(sig.s));
  }

  return Buffer.concat([Buffer.from([TX_TYPE_SET_CODE]), rlpEncodeList(items)]);
}

export function hashType4Transaction(fields: Type4TxFields): string {
  return ethers.keccak256(encodeType4Payload(fields));
}

export function serializeSignedType4(
  fields: Type4TxFields,
  sig: { yParity: number; r: string; s: string }
): string {
  return bufToHex(encodeType4Payload(fields, sig));
}

/**
 * Sign + send a type-4 SetCode transaction via eth_sendRawTransaction.
 * ethers v5 has no native type-4 support, so this bypasses sendTransaction.
 */
export async function sendType4Transaction(
  sender: Wallet,
  fields: Omit<Type4TxFields, 'chainId' | 'nonce'> &
    Partial<Pick<Type4TxFields, 'chainId' | 'nonce'>>
): Promise<{ hash: string; raw: string; authorizationList: Authorization[] }> {
  const from = await sender.getAddress();
  const chainId = fields.chainId ?? CHAIN_ID;
  const nonce = fields.nonce ?? (await provider.getTransactionCount(from, 'pending'));

  const full: Type4TxFields = {
    chainId,
    nonce,
    maxPriorityFeePerGas: fields.maxPriorityFeePerGas,
    maxFeePerGas: fields.maxFeePerGas,
    gasLimit: fields.gasLimit,
    to: fields.to,
    value: fields.value ?? BigInt(0),
    data: fields.data ?? '0x',
    accessList: fields.accessList ?? [],
    authorizationList: fields.authorizationList,
  };

  if (!full.authorizationList.length) {
    throw new Error('type-4 transaction requires a non-empty authorizationList');
  }

  const digest = hashType4Transaction(full);
  const sig = sender.signingKey.sign(digest);
  const yParity = sig.v === 27 ? 0 : 1;
  const raw = serializeSignedType4(full, { yParity, r: sig.r, s: sig.s });

  logger.info('Sending type-4 tx (auth count=' + full.authorizationList.length + ')');
  const hash: string = await provider.send('eth_sendRawTransaction', [raw]);
  logger.info('type-4 sent: ' + hash);
  return { hash, raw, authorizationList: full.authorizationList };
}

// ---------------------------------------------------------------------------
// High-level executor used by ExecutionBridge
// ---------------------------------------------------------------------------

export class EIP7702Authorizer {
  private delegatedExecutor: string;
  private chainId: number;
  private authority: Wallet;

  constructor(
    delegatedExecutorAddress: string,
    chainId: number = CHAIN_ID,
    authority: Wallet = signer as Wallet
  ) {
    this.delegatedExecutor = validateAndChecksumAddress(delegatedExecutorAddress);
    this.chainId = chainId;
    this.authority = authority;
  }

  /**
   * @param accountNonce Current authority nonce (from getTransactionCount).
   * @param opts.selfSponsored When true (default), auth.nonce = accountNonce + 1.
   *   EIP-7702 processes the authorization list AFTER the sender's nonce is
   *   incremented, so self-sponsored type-4 must sign auth with nonce+1.
   *   Set selfSponsored=false only when a different account pays for the tx.
   */
  async createAuthorization(
    accountNonce?: number,
    opts?: { selfSponsored?: boolean }
  ): Promise<Authorization> {
    const addr = await this.authority.getAddress();
    const current =
      accountNonce ?? (await provider.getTransactionCount(addr, 'pending'));
    const selfSponsored = opts?.selfSponsored !== false;
    const authNonce = selfSponsored ? current + 1 : current;
    return signAuthorization(this.authority, this.delegatedExecutor, {
      chainId: this.chainId,
      nonce: authNonce,
    });
  }

  async createClearAuthorization(
    accountNonce?: number,
    opts?: { selfSponsored?: boolean }
  ): Promise<Authorization> {
    const addr = await this.authority.getAddress();
    const current =
      accountNonce ?? (await provider.getTransactionCount(addr, 'pending'));
    const selfSponsored = opts?.selfSponsored !== false;
    const authNonce = selfSponsored ? current + 1 : current;
    return signClearAuthorization(this.authority, {
      chainId: this.chainId,
      nonce: authNonce,
    });
  }

  /** Structured ABI encode of an auth tuple (debug / external tooling). */
  encodeAuthorization(auth: Authorization): string {
    return ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint256', 'address', 'uint256', 'uint8', 'bytes32', 'bytes32'],
      [auth.chainId, auth.address, auth.nonce, auth.yParity, auth.r, auth.s]
    );
  }
}

export class EIP7702Executor {
  private delegatedExecutor: string;
  private authorizer: EIP7702Authorizer;
  private authority: Wallet;
  private chainId: number;

  constructor(
    delegatedExecutorAddress: string,
    chainId: number = CHAIN_ID,
    authority: Wallet = signer as Wallet
  ) {
    this.delegatedExecutor = validateAndChecksumAddress(delegatedExecutorAddress);
    this.chainId = chainId;
    this.authority = authority;
    this.authorizer = new EIP7702Authorizer(this.delegatedExecutor, chainId, authority);
  }

  getExecutorAddress(): string {
    return this.delegatedExecutor;
  }

  getAuthorizer(): EIP7702Authorizer {
    return this.authorizer;
  }

  async getStatus(): Promise<DelegationStatus> {
    return getDelegationStatus(await this.authority.getAddress());
  }

  private async feeHints(): Promise<{ tip: bigint; maxFee: bigint }> {
    const f = await getEip1559Fees();
    return { tip: f.maxPriorityFeePerGas, maxFee: f.maxFeePerGas };
  }

  private pathToHex(path: Buffer | string): string {
    if (typeof path === 'string') return path;
    return bufToHex(Buffer.isBuffer(path) ? path : Buffer.from(path));
  }

  /**
   * After a type-4 send, require active delegation to the expected contract.
   * EIP-7702 skips invalid auths without reverting — status=1 alone is insufficient.
   */
  private async assertDelegated(
    eoa: string,
    expected: string,
    receipt: ethers.TransactionReceipt
  ): Promise<string | null> {
    const after = await getDelegationStatus(eoa);
    if (!after.isDelegated || !after.delegate) {
      return 'type-4 auth did not set delegation (auth may have been skipped)';
    }
    if (after.delegate.toLowerCase() !== expected.toLowerCase()) {
      return `delegated to ${after.delegate}, expected ${expected}`;
    }
    // Gas used of a pure no-op self-call is tiny; real executeSwap/batch is higher.
    if (receipt.gasUsed < 25_000n) {
      return `type-4 gasUsed too low (${receipt.gasUsed}) — likely empty CALL / no-op`;
    }
    return null;
  }

  /**
   * Ensure the EOA is delegated to DelegatedExecutor via a type-4 auth list,
   * then call executeSwap on the EOA so the delegated code runs in EOA context.
   */
  async executeDelegatedSwap(params: DelegatedSwapParams): Promise<DelegatedSwapResult> {
    try {
      const eoa = await this.authority.getAddress();
      logger.info('EIP-7702 delegated swap');
      logger.info('  EOA: ' + eoa);
      logger.info('  delegate: ' + this.delegatedExecutor);
      logger.info('  amountIn: ' + params.amountIn.toString());

      const data = DELEGATED_EXECUTOR_IFACE.encodeFunctionData('executeSwap', [
        params.tokenIn,
        params.amountIn,
        this.pathToHex(params.path),
        params.minAmountOut,
        params.deadline,
      ]);

      const { tip, maxFee } = await this.feeHints();
      const gasLimit = params.gasLimit ?? BigInt(450_000);
      const status = await getDelegationStatus(eoa);

      // Always include a fresh auth so the tx is a true type-4 SetCode tx.
      const auth = await this.authorizer.createAuthorization(status.nonce);
      logger.info(
        '  auth -> ' + auth.address + ' (auth.nonce=' + auth.nonce + ', pending tx nonce path)'
      );

      const sent = await sendType4Transaction(this.authority, {
        chainId: this.chainId,
        maxPriorityFeePerGas: tip,
        maxFeePerGas: maxFee,
        gasLimit,
        to: eoa, // execute against the delegated EOA itself
        value: 0n,
        data,
        authorizationList: [auth],
      });

      const receipt = await provider.waitForTransaction(sent.hash, 1, 90_000);
      if (!receipt) {
        return {
          success: false,
          error: 'type-4 confirmation timeout',
          txHash: sent.hash,
          authorization: auth,
        };
      }
      if (receipt.status === 0) {
        return {
          success: false,
          error: 'type-4 transaction reverted',
          txHash: sent.hash,
          gasUsed: receipt.gasUsed,
          authorization: auth,
        };
      }

      const postErr = await this.assertDelegated(eoa, this.delegatedExecutor, receipt);
      if (postErr) {
        return {
          success: false,
          error: postErr,
          txHash: sent.hash,
          gasUsed: receipt.gasUsed,
          authorization: auth,
        };
      }

      const after = await getDelegationStatus(eoa);
      logger.info('  delegated code now: ' + String(after.delegate));

      if (params.clearAfter) {
        await this.clearDelegation();
      }

      return {
        success: true,
        txHash: sent.hash,
        gasUsed: receipt.gasUsed,
        authorization: auth,
        delegationCode: after.code,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('Delegated swap failed: ' + errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  async executeDelegatedBatchSwaps(
    swaps: DelegatedSwapParams[],
    deadline: number
  ): Promise<DelegatedSwapResult> {
    try {
      const eoa = await this.authority.getAddress();
      const swapRequests = swaps.map((s) => ({
        tokenIn: s.tokenIn,
        amountIn: s.amountIn,
        path: this.pathToHex(s.path),
        minAmountOut: s.minAmountOut,
      }));

      const data = DELEGATED_EXECUTOR_IFACE.encodeFunctionData('executeBatchSwaps', [
        swapRequests,
        deadline,
      ]);

      const { tip, maxFee } = await this.feeHints();
      const status = await getDelegationStatus(eoa);
      const auth = await this.authorizer.createAuthorization(status.nonce);

      const sent = await sendType4Transaction(this.authority, {
        chainId: this.chainId,
        maxPriorityFeePerGas: tip,
        maxFeePerGas: maxFee,
        gasLimit: BigInt(200_000 + swaps.length * 180_000),
        to: eoa,
        value: 0n,
        data,
        authorizationList: [auth],
      });

      const receipt = await provider.waitForTransaction(sent.hash, 1, 90_000);
      if (!receipt || receipt.status === 0) {
        return {
          success: false,
          error: receipt ? 'batch type-4 reverted' : 'batch type-4 timeout',
          txHash: sent.hash,
          authorization: auth,
        };
      }
      return {
        success: true,
        txHash: sent.hash,
        gasUsed: receipt.gasUsed,
        authorization: auth,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMsg };
    }
  }

  /** Send a type-4 tx that authorizes the zero address, clearing EOA code. */
  async clearDelegation(): Promise<DelegatedSwapResult> {
    try {
      const eoa = await this.authority.getAddress();
      const status = await getDelegationStatus(eoa);
      if (!status.isDelegated) {
        return { success: true, error: 'already clear' };
      }
      const auth = await this.authorizer.createClearAuthorization(status.nonce);
      const { tip, maxFee } = await this.feeHints();

      const sent = await sendType4Transaction(this.authority, {
        chainId: this.chainId,
        maxPriorityFeePerGas: tip,
        maxFeePerGas: maxFee,
        gasLimit: BigInt(100_000),
        to: eoa,
        value: 0n,
        data: '0x',
        authorizationList: [auth],
      });
      const receipt = await provider.waitForTransaction(sent.hash, 1, 60_000);
      return {
        success: !!receipt && receipt.status === 1,
        txHash: sent.hash,
        gasUsed: receipt?.gasUsed,
        authorization: auth,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/**
 * Low-level builder kept for external tooling / tests.
 */
export class EIP7702TransactionBuilder {
  static async buildAndSignSetCodeTx(args: {
    authority: Wallet;
    delegate: string;
    to?: string | null;
    data?: string;
    gasLimit?: bigint;
    chainId?: number;
    value?: bigint;
  }): Promise<{ raw: string; hash: string; authorization: Authorization }> {
    const chainId = args.chainId ?? CHAIN_ID;
    const eoa = await args.authority.getAddress();
    const status = await getDelegationStatus(eoa);
    const authorization = await signAuthorization(args.authority, args.delegate, {
      chainId,
      nonce: status.nonce,
    });
    const fee = await provider.getFeeData();
    const tip = fee.maxPriorityFeePerGas ?? ethers.parseUnits('0.01', 'gwei');
    const maxFee = fee.maxFeePerGas ?? (((await provider.getFeeData()).gasPrice ?? 0n) * 2n);

    const sent = await sendType4Transaction(args.authority, {
      chainId,
      maxPriorityFeePerGas: tip,
      maxFeePerGas: (maxFee > tip) ? maxFee : (tip * 2n),
      gasLimit: args.gasLimit ?? BigInt(150_000),
      to: args.to === undefined ? eoa : args.to,
      value: args.value ?? BigInt(0),
      data: args.data ?? '0x',
      authorizationList: [authorization],
    });
    return { raw: sent.raw, hash: sent.hash, authorization };
  }

  /** @deprecated legacy stub — use buildAndSignSetCodeTx */
  static buildSetCodeTx(
    _delegatedExecutorAddress: string,
    eoaAddress: string,
    chainId: number = CHAIN_ID
  ): Partial<ethers.TransactionRequest> {
    return {
      to: eoaAddress,
      type: 4,
      from: eoaAddress,
      data: '0x',
      chainId,
    };
  }
}


// ---------------------------------------------------------------------------
// Multi-target delegation: BasicEOABatchExecutor (ERC-7821 / BEBE)
// ---------------------------------------------------------------------------

/**
 * Encode ERC-7821 execute(mode, abi.encode(calls)) calldata for a multi-target
 * batch. Each call is a real CALL from the EOA (under 7702) to any contract
 * with value and data — routers, Aave, ERC20 approve, etc.
 */
export function encodeBatchExecute(calls: BatchCall[]): {
  mode: string;
  executionData: string;
  data: string;
} {
  if (!calls.length) {
    throw new Error('encodeBatchExecute: empty calls');
  }
  const normalized = calls.map((c) => ({
    to: c.to === ZERO_ADDRESS || !c.to ? ZERO_ADDRESS : validateAndChecksumAddress(c.to),
    value: c.value ?? BigInt(0),
    data: c.data && c.data !== '' ? c.data : '0x',
  }));
  const executionData = ethers.AbiCoder.defaultAbiCoder().encode(
    ['tuple(address to,uint256 value,bytes data)[]'],
    [normalized]
  );
  const mode = ERC7821_MODE_BATCH_NO_OPDATA;
  const data = BATCH_EXECUTOR_IFACE.encodeFunctionData('execute', [mode, executionData]);
  return { mode, executionData, data };
}

/**
 * EIP-7702 multi-target batch executor.
 *
 * Unlike EIP7702Executor (DelegatedExecutor -> hardcoded Uniswap router only),
 * this authorizes the EOA to BasicEOABatchExecutor and invokes ERC-7821
 * execute, which issues arbitrary CALLs to any list of contracts.
 */
export class BatchEOAExecutor {
  private batchExecutor: string;
  private authorizer: EIP7702Authorizer;
  private authority: Wallet;
  private chainId: number;

  constructor(
    batchExecutorAddress: string,
    chainId: number = CHAIN_ID,
    authority: Wallet = signer as Wallet
  ) {
    this.batchExecutor = validateAndChecksumAddress(batchExecutorAddress);
    this.chainId = chainId;
    this.authority = authority;
    this.authorizer = new EIP7702Authorizer(this.batchExecutor, chainId, authority);
  }

  getExecutorAddress(): string {
    return this.batchExecutor;
  }

  getAuthorizer(): EIP7702Authorizer {
    return this.authorizer;
  }

  async getStatus(): Promise<DelegationStatus> {
    return getDelegationStatus(await this.authority.getAddress());
  }

  private async feeHints(): Promise<{ tip: bigint; maxFee: bigint }> {
    const f = await getEip1559Fees();
    return { tip: f.maxPriorityFeePerGas, maxFee: f.maxFeePerGas };
  }

  /**
   * Authorize EOA -> BasicEOABatchExecutor and run a multi-target CALL batch.
   * Each entry in calls is forwarded to an arbitrary contract under EOA context.
   */
  async executeBatchCalls(
    calls: BatchCall[],
    opts?: { gasLimit?: bigint; clearAfter?: boolean }
  ): Promise<DelegatedSwapResult> {
    try {
      const eoa = await this.authority.getAddress();
      logger.info('EIP-7702 multi-target batch (' + calls.length + ' calls)');
      logger.info('  EOA: ' + eoa);
      logger.info('  batchExecutor: ' + this.batchExecutor);
      for (let i = 0; i < calls.length; i++) {
        logger.info(
          '  [' + i + '] to=' + calls[i].to + ' data=' + (calls[i].data || '0x').slice(0, 18) + '...'
        );
      }

      const encoded = encodeBatchExecute(calls);
      const { tip, maxFee } = await this.feeHints();
      const status = await getDelegationStatus(eoa);
      const auth = await this.authorizer.createAuthorization(status.nonce);

      const gasLimit =
        opts?.gasLimit ?? BigInt(150_000 + calls.length * 200_000);

      const sent = await sendType4Transaction(this.authority, {
        chainId: this.chainId,
        maxPriorityFeePerGas: tip,
        maxFeePerGas: maxFee,
        gasLimit,
        to: eoa,
        value: 0n,
        data: encoded.data,
        authorizationList: [auth],
      });

      const receipt = await provider.waitForTransaction(sent.hash, 1, 90_000);
      if (!receipt) {
        return {
          success: false,
          error: 'multi-target type-4 confirmation timeout',
          txHash: sent.hash,
          authorization: auth,
        };
      }
      if (receipt.status === 0) {
        return {
          success: false,
          error: 'multi-target type-4 transaction reverted',
          txHash: sent.hash,
          gasUsed: receipt.gasUsed,
          authorization: auth,
        };
      }

      const after = await getDelegationStatus(eoa);
      if (
        !after.isDelegated ||
        !after.delegate ||
        after.delegate.toLowerCase() !== this.batchExecutor.toLowerCase()
      ) {
        return {
          success: false,
          error: `BEBE delegation missing after type-4 (got ${after.delegate ?? after.code.slice(0, 24)})`,
          txHash: sent.hash,
          gasUsed: receipt.gasUsed,
          authorization: auth,
        };
      }
      // Empty self-call + skipped auth can still status=1 with very low gas.
      if (receipt.gasUsed < 40_000n) {
        return {
          success: false,
          error: `type-4 batch gasUsed too low (${receipt.gasUsed}) — likely no-op`,
          txHash: sent.hash,
          gasUsed: receipt.gasUsed,
          authorization: auth,
        };
      }
      logger.info('  delegated code now: ' + String(after.delegate));

      if (opts?.clearAfter) {
        const clearAuth = await this.authorizer.createClearAuthorization(
          (await getDelegationStatus(eoa)).nonce
        );
        await sendType4Transaction(this.authority, {
          chainId: this.chainId,
          maxPriorityFeePerGas: tip,
          maxFeePerGas: maxFee,
          gasLimit: BigInt(100_000),
          to: eoa,
          value: 0n,
          data: '0x',
          authorizationList: [clearAuth],
        });
      }

      return {
        success: true,
        txHash: sent.hash,
        gasUsed: receipt.gasUsed,
        authorization: auth,
        delegationCode: after.code,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('Multi-target batch failed: ' + errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Convenience: approve token then exactInput on Uniswap V3 SwapRouter02 in one
   * multi-target batch (approve + swap as two CALLs from the EOA).
   */
  async approveAndSwap(params: {
    tokenIn: string;
    router: string;
    amountIn: bigint;
    path: Buffer | string;
    minAmountOut: bigint;
    gasLimit?: bigint;
    /** Unix deadline for SwapRouter02 multicall wrapper (default now+120s). */
    deadline?: number;
  }): Promise<DelegatedSwapResult> {
    const pathHex =
      typeof params.path === 'string'
        ? params.path
        : bufToHex(Buffer.isBuffer(params.path) ? params.path : Buffer.from(params.path));

    const erc20 = new ethers.Interface([
      'function approve(address spender, uint256 amount) returns (bool)',
    ]);
    // SwapRouter02 exactInput has no deadline — wrap in multicall(deadline, data[]).
    const routerIface = new ethers.Interface([
      'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
      'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
    ]);

    const eoa = await this.authority.getAddress();
    const deadline = params.deadline ?? Math.floor(Date.now() / 1000) + 120;
    const exactInputData = routerIface.encodeFunctionData('exactInput', [
      {
        path: pathHex,
        recipient: eoa,
        amountIn: params.amountIn,
        amountOutMinimum: params.minAmountOut,
      },
    ]);
    const calls: BatchCall[] = [
      {
        to: params.tokenIn,
        data: erc20.encodeFunctionData('approve', [params.router, params.amountIn]),
      },
      {
        to: params.router,
        data: routerIface.encodeFunctionData('multicall', [deadline, [exactInputData]]),
      },
    ];
    return this.executeBatchCalls(calls, { gasLimit: params.gasLimit });
  }
}

export default {
  EIP7702Authorizer,
  EIP7702Executor,
  EIP7702TransactionBuilder,
  signAuthorization,
  signClearAuthorization,
  authorizationDigest,
  getDelegationStatus,
  isDelegationDesignator,
  parseDelegate,
  sendType4Transaction,
  encodeBatchExecute,
  BatchEOAExecutor,
  ERC7821_MODE_BATCH_NO_OPDATA,
};
