// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

/// @title MegaMEVOptimizationLib
/// @notice CLZ-backed bit-length helper, stripped to only what the sniper contracts use.
/// @dev Backed by the native EIP-7939 `clz` opcode (osaka target). Only `bitLength` (and its
///      private `fls` dependency) are kept — everything else from the original full library
///      (full-precision mulDiv, sqrt, log2, reserve heuristics, etc.) was unused dead weight
///      that added to deployed bytecode size for no benefit. Derived from Solady (MIT,
///      https://github.com/vectorized/solady).
library MegaMEVOptimizationLib {
    /// @notice Number of bits needed to represent x.
    /// @dev `bitLength(0) == 0`.
    function bitLength(
        uint256 x
    ) internal pure returns (uint256 r) {
        if (x == 0) return 0;
        unchecked {
            return fls(x) + 1;
        }
    }

    /// @dev Find last set: index of the MSB of `x` from the LSB. Returns 256 if `x` is zero.
    ///      Uses the native EIP-7939 `clz` opcode.
    function fls(
        uint256 x
    ) private pure returns (uint256 r) {
        assembly ("memory-safe") {
            r := xor(xor(255, clz(x)), mul(255, iszero(x)))
        }
    }
}
