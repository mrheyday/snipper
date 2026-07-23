import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// 1) forge build
execSync('forge build', { cwd: path.join(root, 'contracts'), stdio: 'inherit' });

// 2) regen contractABIs.ts
const artifacts = {
  SNIPER_SEARCHER_ABI: 'contracts/out/SniperSearcher.sol/SniperSearcher.json',
  FLASH_LOAN_RECEIVER_ABI: 'contracts/out/FlashLoanReceiver.sol/FlashLoanReceiver.json',
  DELEGATED_EXECUTOR_ABI: 'contracts/out/DelegatedExecutor.sol/DelegatedExecutor.json',
  BEBE_BASIC_EOA_BATCH_EXECUTOR_ABI:
    'contracts/out/BasicEOABatchExecutor.sol/BasicEOABatchExecutor.json',
};
let out = [
  '/**',
  ' * Smart Contract ABIs',
  ' * Auto-generated from Foundry build artifacts',
  ' * Generated on: ' + new Date().toISOString().slice(0, 10),
  ' * Includes: SniperSearcher, FlashLoanReceiver, DelegatedExecutor, BEBE BasicEOABatchExecutor',
  ' */',
  '',
  '',
].join('\n');
const names = [];
for (const [name, rel] of Object.entries(artifacts)) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) throw new Error('missing ' + full);
  const abi = JSON.parse(fs.readFileSync(full, 'utf8')).abi;
  out += 'export const ' + name + ' = ' + JSON.stringify(abi, null, 2) + ' as const;\n\n';
  names.push(name);
}
out += 'export const CONTRACT_ABIS = {\n';
for (const n of names) out += '  ' + n + ',\n';
out += '};\n\nexport default CONTRACT_ABIS;\n';
fs.writeFileSync(path.join(root, 'src/contractABIs.ts'), out);
console.log('wrote contractABIs.ts', out.length);

// 3) DelegatedExecutor tests — valid Uni V3 path length
{
  const f = path.join(root, 'contracts/test/DelegatedExecutor.t.sol');
  let s = fs.readFileSync(f, 'utf8');
  const good = 'abi.encodePacked(address(tokenA), uint24(3000), address(tokenB))';
  s = s.replace(/abi\.encodePacked\(address\(tokenA\), address\(tokenB\)\)/g, good);
  if (!s.includes('error InvalidPath')) {
    s = s.replace(
      'error DeadlineExceeded();\n    error SwapFailed();',
      'error DeadlineExceeded();\n    error SwapFailed();\n    error InvalidPath();\n    error CallbackDisabled();'
    );
  }
  if (!s.includes('test_RevertWhen_InvalidPath')) {
    s = s.replace(
      'function test_ReceiveETH() public {',
      `function test_RevertWhen_InvalidPath() public {
        executor.allowEOA(user);
        bytes memory bad = abi.encodePacked(address(tokenA));
        vm.prank(user);
        vm.expectRevert(InvalidPath.selector);
        executor.executeSwap(address(tokenA), 1e18, bad, 0, block.timestamp + 60);
    }

    function test_RevertWhen_CallbackDisabled() public {
        executor.allowEOA(user);
        bytes memory path = abi.encodePacked(address(tokenA), uint24(3000), address(tokenB));
        bytes memory cb = hex"deadbeef";
        vm.prank(user);
        tokenA.approve(address(executor), 1e18);
        vm.prank(user);
        vm.expectRevert(CallbackDisabled.selector);
        executor.executeSwapWithCallback(address(tokenA), 1e18, path, 0, block.timestamp + 60, cb);
    }

    function test_ReceiveETH() public {`
    );
  }
  fs.writeFileSync(f, s);
  console.log('DelegatedExecutor.t.sol updated');
}

// 4) delegatee-calldata.md selector + wiring note
{
  const f = path.join(root, 'contracts/delegatee-calldata.md');
  let s = fs.readFileSync(f, 'utf8');
  s = s.replace(
    'Function Selector: 0x414bf389',
    'Function Selector: 0x107db2c4  // executeSwap(address,uint256,bytes,uint256,uint256)'
  );
  s = s.replace(
    '✅ **No Storage**: Delegatee is stateless, no persistent state',
    '⚠️ **Has storage**: owner / allowedEOAs mapping (not fully stateless)'
  );
  if (!s.includes('SwapRouter02 exactInput')) {
    s += `

## Router wiring (production-critical)

DelegatedExecutor and SniperSearcher call Uniswap V3 **SwapRouter02**:

- \`exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum))\`
- selector: \`0xb858183f\`

Do **not** use positional \`exactInput(bytes,address,uint256,uint256)\` (\`0x11b69c46\`) — wrong ABI.

### Flash path wiring

\`\`\`
EOA --type4--> BEBE.execute([CALL FlashLoanReceiver.initiateFlashLoan])
  --> Aave.flashLoanSimple(receiver=Flash)
  --> Flash.executeOperation
      --> approve SniperSearcher
      --> SniperSearcher.executeSwap  (must be allowExecutor'd at deploy)
      --> path MUST round-trip to borrow asset
      --> approve Aave for amount+premium
\`\`\`

### Selector cheat-sheet

| Function | Selector |
|----------|----------|
| SniperSearcher.executeSwap(address,uint256,bytes,uint256) | 0xdd824660 |
| SniperSearcher.executeSwapWithDeadline(...,uint256) | (see ABI) |
| FlashLoanReceiver.initiateFlashLoan(...) | 0xd4c4ca9b |
| BEBE / ERC7821 execute(bytes32,bytes) | 0xe9ae5c53 |
| SwapRouter02 exactInput(ExactInputParams) | 0xb858183f |
| DelegatedExecutor.executeSwap(...,deadline) | 0x107db2c4 |
`;
  }
  fs.writeFileSync(f, s);
  console.log('delegatee-calldata.md updated');
}

// 5) .env.example batch executor
{
  const f = path.join(root, '.env.example');
  let s = fs.readFileSync(f, 'utf8');
  if (!s.includes('BATCH_EXECUTOR_ADDRESS')) {
    s += `
# Deployed contract addresses (fill after forge script Deploy)
SNIPER_SEARCHER_ADDRESS=
FLASH_LOAN_RECEIVER_ADDRESS=
DELEGATED_EXECUTOR_ADDRESS=
BATCH_EXECUTOR_ADDRESS=
`;
    fs.writeFileSync(f, s);
    console.log('.env.example updated');
  }
}

console.log('done');
