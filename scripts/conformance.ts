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
const revisions = passthrough
  ? []
  : process.argv.slice(2).length
    ? process.argv.slice(2)
    : ['2025-11-25', '2026-07-28'];
const port = 3947;
const url = `http://127.0.0.1:${port}/mcp`;

async function main(): Promise<number> {
  const fake = new FakeTrilium({ token: 'tok' });
  fake.addNote({
    noteId: 'sample',
    title: 'Sample',
    type: 'text',
    parentNoteId: 'root',
    content: '<p>sample</p>',
  });
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
      const result = spawnSync(
        'npx',
        ['-y', '@modelcontextprotocol/conformance@alpha', 'server', '--url', url, ...passthrough],
        { stdio: 'inherit', env: process.env },
      );
      return result.status === 0 ? 0 : 1;
    }
    for (const revision of revisions) {
      console.log(`\n=== conformance --requirements ${revision} ===`);
      const args = [
        '-y',
        '@modelcontextprotocol/conformance@alpha',
        'server',
        '--url',
        url,
        '--requirements',
        revision,
      ];
      const result = spawnSync(
        'npx',
        [...args, '--expected-failures', 'conformance-baseline.yml'],
        {
          encoding: 'utf8',
          env: process.env,
        },
      );
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      const complaintsTolerated = onlyWarningOnlyComplaints(`${result.stdout}\n${result.stderr}`);
      if (result.status !== 0 && !complaintsTolerated) failed += 1;
      if (result.status !== 0 && complaintsTolerated)
        console.log('(non-zero exit tolerated: only warning-only scenarios were reported)');
    }
    return failed;
  } finally {
    server.kill('SIGTERM');
    await fake.close();
  }
}

/**
 * Scenarios that emit no failing checks but a warning. The alpha CLI reports
 * them as "unexpected failures" on one revision and as "stale baseline
 * entries" on the other, so neither baseline state satisfies both runs.
 */
const WARNING_ONLY = new Set([
  'server-sse-multiple-streams',
  'input-required-result-missing-input-response',
  'input-required-result-ignore-extra-params',
]);

/** True when every complaint in the summary concerns a warning-only scenario with zero failed checks. */
function onlyWarningOnlyComplaints(output: string): boolean {
  const complaints = [...output.matchAll(/^\s+[✗✓]\s+(\S+)\s*$/gmu)].map((m) => m[1]!);
  const summary = new Map(
    [...output.matchAll(/^[✗✓]\s+(\S+):\s+(\d+) passed,\s+(\d+) failed/gmu)].map((m) => [
      m[1]!,
      Number(m[3]),
    ]),
  );
  return (
    complaints.length > 0 &&
    complaints.every((name) => WARNING_ONLY.has(name) && (summary.get(name) ?? 0) === 0)
  );
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
