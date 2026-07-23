import { AaveLending } from './src/aaveLending';
import { signer } from './src/config';

async function main() {
  const lending = new AaveLending(signer);
  const WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';

  // @ts-expect-error -- accessing private field for this one-off verification test
  const txs = await lending.pool.supply({
    user: await signer.getAddress(),
    reserve: WETH,
    amount: '0.0001',
  });

  console.log(`Pool.supply() returned ${txs.length} transaction(s):`);
  for (const t of txs) {
    const populated = await t.tx();
    console.log(`  txType: ${t.txType}`);
    console.log(`  to: ${populated.to}`);
    console.log(`  data (first 10 bytes): ${populated.data?.toString().slice(0, 22)}...`);
  }
}

main().catch((e) => console.error('ERROR:', e));
