import { BigNumber, Signer, Contract } from 'ethers';

const PERMIT2_ABI = [
  'function approve(address token, uint160 amount, uint48 expiration) external',
  'function permit(address owner, (address token, uint160 amount, uint48 expiration, uint48 nonce)[] details, bytes signature) external payable',
  'function permitTransferFrom((address from, address to, uint160 requestedAmount, uint160 amount, uint48 expiration, uint48 nonce) details, bytes signature) external',
  'function nonces(address owner, address token) view returns (uint48)',
];

interface PermitDetails {
  token: string;
  amount: BigNumber;
  expiration: number;
  nonce: number;
}

interface PermitSingle {
  details: PermitDetails;
  spender: string;
  sigDeadline: number;
}

export class Permit2Handler {
  private permit2Address: string;
  private signer: Signer;
  private chainId: number;

  constructor(permit2Address: string, signer: Signer, chainId: number) {
    this.permit2Address = permit2Address;
    this.signer = signer;
    this.chainId = chainId;
  }

  /**
   * Create EIP-712 signature for Permit2 approval
   */
  async signPermit(params: PermitSingle): Promise<string> {
    const domain = {
      name: 'Permit2',
      chainId: this.chainId,
      verifyingContract: this.permit2Address,
      version: '1',
    };

    const types = {
      PermitDetails: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint160' },
        { name: 'expiration', type: 'uint48' },
        { name: 'nonce', type: 'uint48' },
      ],
      PermitSingle: [
        { name: 'details', type: 'PermitDetails' },
        { name: 'spender', type: 'address' },
        { name: 'sigDeadline', type: 'uint256' },
      ],
    };

    const value = {
      details: {
        token: params.details.token,
        amount: params.details.amount.toString(),
        expiration: params.details.expiration,
        nonce: params.details.nonce,
      },
      spender: params.spender,
      sigDeadline: params.sigDeadline,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const signerWithTypedData = this.signer as any;
    return signerWithTypedData._signTypedData(domain, types, value);
  }

  /**
   * Get current nonce for token
   */
  async getNonce(ownerAddress: string, tokenAddress: string, provider: unknown): Promise<number> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const permit2Contract = new Contract(this.permit2Address, PERMIT2_ABI, provider as any);
    const nonce = await permit2Contract.nonces(ownerAddress, tokenAddress);
    return nonce;
  }

  /**
   * Create permit approval for token
   */
  async createPermit(
    ownerAddress: string,
    tokenAddress: string,
    amount: BigNumber,
    spender: string,
    expiration: number,
    provider: unknown
  ): Promise<{ signature: string; permit: PermitSingle }> {
    const nonce = await this.getNonce(ownerAddress, tokenAddress, provider);

    const permit: PermitSingle = {
      details: {
        token: tokenAddress,
        amount,
        expiration,
        nonce,
      },
      spender,
      sigDeadline: Math.floor(Date.now() / 1000) + 1800, // 30 min from now
    };

    const signature = await this.signPermit(permit);

    return { signature, permit };
  }

  /**
   * Approve token via Permit2 (if needed)
   */
  async approveToken(tokenAddress: string, amount: BigNumber, expiration: number): Promise<void> {
    const permit2Contract = new Contract(this.permit2Address, PERMIT2_ABI, this.signer);

    const tx = await permit2Contract.approve(tokenAddress, amount, expiration);
    await tx.wait();
  }
}

export default Permit2Handler;
