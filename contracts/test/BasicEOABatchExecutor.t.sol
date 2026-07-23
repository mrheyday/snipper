// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {Test, console} from "forge-std/Test.sol";
import {BasicEOABatchExecutor} from "../src/BasicEOABatchExecutor.sol";
import {ERC7821} from "solady/accounts/ERC7821.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @dev Records the last caller so tests can assert CALL msg.sender under self-execution.
contract CallerProbe {
    address public lastCaller;
    uint256 public lastValue;
    bytes public lastData;

    function ping(bytes calldata data) external payable returns (bytes memory) {
        lastCaller = msg.sender;
        lastValue = msg.value;
        lastData = data;
        return data;
    }
}

/// @notice Verifies BasicEOABatchExecutor (BEBE): ERC-7821 batch + ERC-1271
///         isValidSignature for EIP-7702 EOA delegation.
contract BasicEOABatchExecutorTest is Test {
    BasicEOABatchExecutor public bebe;
    CallerProbe public probeA;
    CallerProbe public probeB;
    ERC20Mock public token;

    // ERC-7821 single-batch mode, no opData (matches TS ERC7821_MODE_BATCH_NO_OPDATA)
    bytes32 constant MODE_BATCH_NO_OPDATA =
        0x0100000000000000000000000000000000000000000000000000000000000000;

    bytes32 constant MODE_BATCH_WITH_OPDATA =
        0x0100000000007821000100000000000000000000000000000000000000000000;

    bytes4 constant ERC1271_MAGIC = 0x1626ba7e;
    bytes4 constant ERC1271_FAIL = 0xffffffff;

    /// @dev Canonical BEBE CREATE2 address (Vectorized/bebe).
    address constant CANONICAL_BEBE = 0x00000000BEBEDB7C30ee418158e26E31a5A8f3E2;

    uint256 eoaKey;
    address eoa;

    function setUp() public {
        bebe = new BasicEOABatchExecutor();
        probeA = new CallerProbe();
        probeB = new CallerProbe();
        token = new ERC20Mock("T", "T", 18);
        (eoa, eoaKey) = makeAddrAndKey("bebe-eoa");
    }

    function test_SupportsExecutionMode() public view {
        assertTrue(bebe.supportsExecutionMode(MODE_BATCH_NO_OPDATA));
        assertTrue(bebe.supportsExecutionMode(MODE_BATCH_WITH_OPDATA));
    }

    /// @dev When the executor is called by itself (7702 self-call), execute()
    ///      is authorized and issues real CALLs to other contracts with
    ///      msg.sender == the executor address.
    function test_MultiTarget_SelfCall_ReachesOtherContracts() public {
        ERC7821.Call[] memory calls = new ERC7821.Call[](2);
        calls[0] = ERC7821.Call({
            to: address(probeA),
            value: 0,
            data: abi.encodeCall(CallerProbe.ping, (hex"aa"))
        });
        calls[1] = ERC7821.Call({
            to: address(probeB),
            value: 0,
            data: abi.encodeCall(CallerProbe.ping, (hex"bb"))
        });

        bytes memory executionData = abi.encode(calls);

        // Simulate EIP-7702: prank as the executor so msg.sender == address(this).
        vm.prank(address(bebe));
        bebe.execute(MODE_BATCH_NO_OPDATA, executionData);

        assertEq(probeA.lastCaller(), address(bebe), "probeA should see bebe as msg.sender");
        assertEq(probeB.lastCaller(), address(bebe), "probeB should see bebe as msg.sender");
        assertEq(probeA.lastData(), hex"aa");
        assertEq(probeB.lastData(), hex"bb");
    }

    /// @dev External callers (not self) with empty opData must be rejected.
    function test_RevertWhen_ExternalCallerNoOpData() public {
        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0] = ERC7821.Call({
            to: address(probeA),
            value: 0,
            data: abi.encodeCall(CallerProbe.ping, (hex"cc"))
        });
        bytes memory executionData = abi.encode(calls);

        vm.expectRevert();
        bebe.execute(MODE_BATCH_NO_OPDATA, executionData);
    }

    /// @dev Multi-target can also drive ERC20 approve on another contract.
    function test_MultiTarget_ApproveOtherToken() public {
        address spender = makeAddr("spender");
        uint256 amount = 123e18;
        token.mint(address(bebe), amount);

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0] = ERC7821.Call({
            to: address(token),
            value: 0,
            data: abi.encodeWithSignature("approve(address,uint256)", spender, amount)
        });

        vm.prank(address(bebe));
        bebe.execute(MODE_BATCH_NO_OPDATA, abi.encode(calls));

        assertEq(token.allowance(address(bebe), spender), amount);
    }

    /// @dev Native value forwarding to another contract.
    function test_MultiTarget_ForwardsValue() public {
        vm.deal(address(bebe), 1 ether);

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0] = ERC7821.Call({
            to: address(probeA),
            value: 0.25 ether,
            data: abi.encodeCall(CallerProbe.ping, (hex"01"))
        });

        vm.prank(address(bebe));
        bebe.execute(MODE_BATCH_NO_OPDATA, abi.encode(calls));

        assertEq(probeA.lastValue(), 0.25 ether);
        assertEq(address(probeA).balance, 0.25 ether);
    }

    /// @dev address(0) in Call.to is rewritten to address(this) by ERC-7821.
    function test_ZeroTo_MeansSelf() public {
        // Encode a self-call via to=address(0). Use empty data (no-op) so it doesn't revert.
        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0] = ERC7821.Call({to: address(0), value: 0, data: ""});

        vm.prank(address(bebe));
        bebe.execute(MODE_BATCH_NO_OPDATA, abi.encode(calls));
        // Success without revert is enough: zero `to` was rewritten and called.
    }

    // ─── ERC-1271 isValidSignature ─────────────────────────────────────────

    /// @dev Valid ECDSA signature from the account itself returns magic value.
    /// Under EIP-7702, address(this) is the EOA, so we etch BEBE code onto the EOA.
    function test_IsValidSignature_ValidEOA() public {
        bytes memory runtime = address(bebe).code;
        vm.etch(eoa, runtime);

        bytes32 hash = keccak256("bebe-sign");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(eoaKey, hash);
        bytes memory sig = abi.encodePacked(r, s, v);

        bytes4 result = BasicEOABatchExecutor(payable(eoa)).isValidSignature(hash, sig);
        assertEq(result, ERC1271_MAGIC);
    }

    /// @dev Signature from a different key must not validate.
    function test_IsValidSignature_WrongSigner() public {
        bytes memory runtime = address(bebe).code;
        vm.etch(eoa, runtime);

        (, uint256 wrongKey) = makeAddrAndKey("wrong");
        bytes32 hash = keccak256("bebe-sign");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongKey, hash);
        bytes memory sig = abi.encodePacked(r, s, v);

        bytes4 result = BasicEOABatchExecutor(payable(eoa)).isValidSignature(hash, sig);
        assertEq(result, ERC1271_FAIL);
    }

    /// @dev Simulated 7702: EOA code = BEBE, self-call execute multi-target.
    function test_EIP7702_EtchAndSelfExecute() public {
        bytes memory runtime = address(bebe).code;
        vm.etch(eoa, runtime);
        vm.deal(eoa, 1 ether);

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0] = ERC7821.Call({
            to: address(probeA),
            value: 0.1 ether,
            data: abi.encodeCall(CallerProbe.ping, (hex"ef"))
        });

        vm.prank(eoa);
        BasicEOABatchExecutor(payable(eoa)).execute(MODE_BATCH_NO_OPDATA, abi.encode(calls));

        assertEq(probeA.lastCaller(), eoa);
        assertEq(probeA.lastValue(), 0.1 ether);
        assertEq(probeA.lastData(), hex"ef");
    }

    function test_CanonicalAddress_Constant() public pure {
        assertEq(CANONICAL_BEBE, 0x00000000BEBEDB7C30ee418158e26E31a5A8f3E2);
    }
}
