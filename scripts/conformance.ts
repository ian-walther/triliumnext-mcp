/**
 * Runs the official MCP conformance suite against this server for each
 * protocol revision. Starts an in-memory fake Trilium and the HTTP entry point
 * on loopback, then invokes `@modelcontextprotocol/conformance`.
 *
 *   npx tsx scripts/conformance.ts [2025-11-25] [2026-07-28]
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { FakeTrilium } from '../tests/helpers/fakeTrilium.js';

// Usage: tsx scripts/conformance.ts [revision ...]            run requirement sets (default both)
//        tsx scripts/conformance.ts -- --scenario <name> ...  pass arguments straight through
const dash = process.argv.indexOf('--');
const passthrough = dash >= 0 ? process.argv.slice(dash + 1) : undefined;
const revisions = passthrough ? [] : process.argv.slice(2).length ? process.argv.slice(2) : ['2025-11-25', '2026-07-28'];
const port = 3947;
const url = `http://127.0.0.1:${port}/mcp`;

async function main(): Promise<number> {
  const fake = new FakeTrilium({ token: 'tok' });
  fake.addNote({ noteId: 'sample', title: 'Sample', type: 'text', parentNoteId: 'root', content: '<p>sample</p>' });
  const triliumUrl = await fake.listen();
  const server = spawn(process.execPath, ['dist/http.js'], {
    env: {
      ...process.env,
      TRILIUM_API_URL: triliumUrl,
      TRILIUM_API_TOKEN: 'tok',
      MCP_HTTP_PORT: String(port),
      MCP_AUTH_MODE: 'none',
      MCP_RATE_LIMIT_PER_MINUTE: '0',
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  try {
    await waitFor(`http://127.0.0.1:${port}/healthz`);
    mkdirSync('results', { recursive: true });
    let failed = 0;
    if (passthrough) {
      const result = spawnSync('npx', ['-y', '@modelcontextprotocol/conformance@alpha', 'server', '--url', url, ...passthrough], { stdio: 'inherit', env: process.env });
      return result.status === 0 ? 0 : 1;
    }
    for (const revision of revisions) {
      console.log(`\n=== conformance --requirements ${revision} ===`);
      const args = ['-y', '@modelcontextprotocol/conformance@alpha', 'server', '--url', url, '--requirements', revision];
      const baseline = `conformance-baseline.yml`;
      const result = spawnSync('npx', [...args, '--expected-failures', baseline], { stdio: 'inherit', env: process.env });
      if (result.status !== 0) failed += 1;
    }
    return failed;
  } finally {
    server.kill('SIGTERM');
    await fake.close();
  }
}

async function waitFor(healthUrl: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not become healthy at ${healthUrl}`);
}

main().then(
  (failed) => process.exit(failed === 0 ? 0 : 1),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
