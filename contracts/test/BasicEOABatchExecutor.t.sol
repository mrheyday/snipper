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

/// @notice Verifies BasicEOABatchExecutor can CALL arbitrary other contracts when
///         invoked as address(this) (the EIP-7702 self-call pattern).
contract BasicEOABatchExecutorTest is Test {
    BasicEOABatchExecutor public bebe;
    CallerProbe public probeA;
    CallerProbe public probeB;
    ERC20Mock public token;

    // ERC-7821 single-batch mode, no opData (matches TS ERC7821_MODE_BATCH_NO_OPDATA)
    bytes32 constant MODE_BATCH_NO_OPDATA =
        0x0100000000000000000000000000000000000000000000000000000000000000;

    function setUp() public {
        bebe = new BasicEOABatchExecutor();
        probeA = new CallerProbe();
        probeB = new CallerProbe();
        token = new ERC20Mock("T", "T", 18);
    }

    function test_SupportsExecutionMode() public view {
        assertTrue(bebe.supportsExecutionMode(MODE_BATCH_NO_OPDATA));
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
}
