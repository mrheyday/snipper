// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

/// @title DeployRegistry
/// @notice Canonical constructor arguments and Arbitrum One production addresses.
/// @dev Source of truth for deploy scripts, Verify/Configure, and off-chain config.
///      Constructor args are immutable once deployed; post-deploy wiring is Configure.s.sol.
library DeployRegistry {
    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                    CONSTRUCTOR ARGUMENTS                   */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev Uniswap V3 SwapRouter02 (Arbitrum One + Sepolia).
    address internal constant SWAP_ROUTER = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;

    /// @dev Aave V3 Pool — Arbitrum One.
    address internal constant AAVE_POOL_ARBITRUM = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;

    /// @dev Aave V3 Pool — Arbitrum Sepolia.
    address internal constant AAVE_POOL_SEPOLIA = 0xB9C5a95a8f8D7ad8E64d64eF53e6aBaA40a5bF18;

    /// @dev Dust bit-length floor. 0 = disabled (required for 6-dec stables).
    uint256 internal constant MIN_AMOUNT_BIT_LENGTH = 0;

    /// @dev Vectorized BEBE CREATE2 (no constructor args).
    address internal constant BEBE = 0x00000000BEBEDB7C30ee418158e26E31a5A8f3E2;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*              ARBITRUM ONE PRODUCTION (2026-07-23)          */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    uint256 internal constant CHAIN_ID_ARBITRUM = 42161;
    uint256 internal constant CHAIN_ID_ARBITRUM_SEPOLIA = 421614;

    address internal constant OWNER = 0x00000001386687D89e6A36aE01C5e5F75acF61Af;
    address internal constant SNIPER_SEARCHER = 0xAC7465949D3178C9F13d629c6417b2a02D50DdC8;
    address internal constant FLASH_LOAN_RECEIVER = 0xdce71b4f28dcc5686B3B4e8790bD6051345A89b8;
    address internal constant DELEGATED_EXECUTOR = 0xc7a5B0873CB174A78017A66b541B24be64fBAde4;

    /// @dev SniperSearcher(swapRouter, minAmountBitLength)
    function sniperConstructorArgs() internal pure returns (address swapRouter, uint256 minBits) {
        return (SWAP_ROUTER, MIN_AMOUNT_BIT_LENGTH);
    }

    /// @dev FlashLoanReceiver(swapExecutor, lendingPool) on Arbitrum One.
    function flashConstructorArgsArbitrum()
        internal
        pure
        returns (address swapExecutor, address lendingPool)
    {
        return (SNIPER_SEARCHER, AAVE_POOL_ARBITRUM);
    }

    /// @dev DelegatedExecutor(minAmountBitLength)
    function delegatedConstructorArgs() internal pure returns (uint256 minBits) {
        return MIN_AMOUNT_BIT_LENGTH;
    }

    /// @dev ABI-encoded constructor args for forge verify / explorers.
    function sniperConstructorArgsEncoded() internal pure returns (bytes memory) {
        return abi.encode(SWAP_ROUTER, MIN_AMOUNT_BIT_LENGTH);
    }

    function flashConstructorArgsEncodedArbitrum() internal pure returns (bytes memory) {
        return abi.encode(SNIPER_SEARCHER, AAVE_POOL_ARBITRUM);
    }

    function delegatedConstructorArgsEncoded() internal pure returns (bytes memory) {
        return abi.encode(MIN_AMOUNT_BIT_LENGTH);
    }

    function aavePoolForChain(uint256 chainId) internal pure returns (address) {
        if (chainId == CHAIN_ID_ARBITRUM) return AAVE_POOL_ARBITRUM;
        if (chainId == CHAIN_ID_ARBITRUM_SEPOLIA) return AAVE_POOL_SEPOLIA;
        revert("DeployRegistry: unsupported chain");
    }
}
