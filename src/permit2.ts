/**
 * Uniswap Permit2 helper (canonical CREATE2: 0x000000000022D473030F116dDEE9F6B43aC78BA3).
 * Correct ABI: approve(token, spender, amount, expiration); allowance returns (amount, expiration, nonce).
 */
import { Signer, Contract, type Provider } from 'ethers';

const PERMIT2_ABI = [
  'function approve(address token, address spender, uint160 amount, uint48 expiration) external',
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function permit(address owner, ((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes signature) external',
  'function transferFrom(address from, address to, uint160 amount, address token) external',
];

interface PermitDetails {
  token: string;
  amount: bigint;
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
   * Create EIP-712 signature for Permit2 PermitSingle
   */
  async signPermit(params: PermitSingle): Promise<string> {
    const domain = {
      name: 'Permit2',
      chainId: this.chainId,
      verifyingContract: this.permit2Address,
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
        amount: params.details.amount,
        expiration: params.details.expiration,
        nonce: params.details.nonce,
      },
      spender: params.spender,
      sigDeadline: params.sigDeadline,
    };

    return this.signer.signTypedData(domain, types, value);
  }

  /**
   * Nonce for (owner, token, spender) from Permit2.allowance.
   */
  async getNonce(
    ownerAddress: string,
    tokenAddress: string,
    spender: string,
    provider: Provider
  ): Promise<number> {
    const permit2 = new Contract(this.permit2Address, PERMIT2_ABI, provider);
    const [, , nonce] = await permit2.allowance(ownerAddress, tokenAddress, spender);
    return Number(nonce);
  }

  /**
   * On-chain Permit2.approve(token, spender, amount, expiration).
   */
  async approve(
    token: string,
    spender: string,
    amount: bigint,
    expiration: number
  ): Promise<string> {
    const permit2 = new Contract(this.permit2Address, PERMIT2_ABI, this.signer);
    const tx = await permit2.approve(token, spender, amount, expiration);
    const receipt = await tx.wait(1);
    return receipt?.hash ?? tx.hash;
  }
}

export default Permit2Handler;
