#!/usr/bin/env node
/**
 * Print ranked sniping token set from Bitquery + allowlists.
 *   node scripts/snipe-token-set.mjs
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

require('dotenv').config({ path: path.join(root, '.env') });
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'commonjs', esModuleInterop: true },
});

const { discoverSnipeTokenSet } = require(path.join(root, 'src/snipeTokenSet.ts'));
const { logAllowlistSummary, getAllowedRouters } = require(path.join(root, 'src/allowlist.ts'));

async function main() {
  console.log('========== SNIPE TOKEN SET (Bitquery + allowlist) ==========');
  logAllowlistSummary();
  console.log('Routers:', getAllowedRouters().join(', '));
  console.log('');
  const set = await discoverSnipeTokenSet({ maxCandidates: 15 });
  console.log('generatedAt', set.generatedAt);
  console.log('flashBases', set.flashBases.length);
  console.log('candidates', set.candidates.length);
  console.log('');
  for (const c of set.candidates) {
    console.log(
      `#${c.rank} score=${c.score.toFixed(1)}  ${c.baseSymbol || c.baseToken.slice(0, 10)} → ${
        c.targetSymbol || c.targetToken.slice(0, 10)
      }`
    );
    console.log(
      `     base=${c.baseToken} target=${c.targetToken} source=${c.source} trades=${c.tradeCount ?? 0}`
    );
    if (c.pool) console.log(`     pool=${c.pool} fee=${c.fee ?? '?'}`);
    console.log(`     reasons: ${c.reasons.join('; ')}`);
  }
  if (set.best) {
    console.log('');
    console.log('BEST:', set.best.baseToken, '→', set.best.targetToken, 'score', set.best.score);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
