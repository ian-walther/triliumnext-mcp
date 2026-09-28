/**
 * Starts a throwaway TriliumNext container for integration tests, initialises
 * a fresh document, sets a password, and mints a real ETAPI token. Nothing
 * here touches any pre-existing Trilium instance.
 *
 * Skips (with a clear message) when Docker is unavailable. Set
 * TRILIUM_TEST_URL and TRILIUM_TEST_TOKEN to reuse an existing *disposable*
 * instance instead.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const IMAGE = process.env['TRILIUM_TEST_IMAGE'] ?? 'triliumnext/trilium:v0.103.0';
const NAME = `trilium-mcp-itest-${process.pid}`;
const PASSWORD = 'integration-test-password';
export const STATE_FILE = join(tmpdir(), 'trilium-mcp-itest.json');

async function waitFor(
  url: string,
  predicate: (res: Response) => boolean,
  attempts = 120,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (predicate(res)) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout waiting for ${url}`);
}

export default async function setup(): Promise<() => void> {
  if (process.env['TRILIUM_TEST_URL'] && process.env['TRILIUM_TEST_TOKEN']) {
    writeFileSync(
      STATE_FILE,
      JSON.stringify({
        url: process.env['TRILIUM_TEST_URL'],
        token: process.env['TRILIUM_TEST_TOKEN'],
      }),
    );
    return () => unlinkSync(STATE_FILE);
  }
  const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
  });
  if (docker.status !== 0) {
    throw new Error(
      'Integration tests need Docker (or TRILIUM_TEST_URL + TRILIUM_TEST_TOKEN). Docker is not available.',
    );
  }
  spawnSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' });
  execFileSync('docker', ['run', '-d', '--name', NAME, '-p', '127.0.0.1:0:8080', IMAGE], {
    stdio: 'ignore',
  });
  const portLine = execFileSync('docker', ['port', NAME, '8080/tcp'], { encoding: 'utf8' })
    .trim()
    .split('\n')[0]!;
  const port = portLine.slice(portLine.lastIndexOf(':') + 1);
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(`${base}/api/setup/status`, (res) => res.ok);
    const status = (await (await fetch(`${base}/api/setup/status`)).json()) as {
      isInitialized: boolean;
    };
    if (!status.isInitialized) {
      const created = await fetch(`${base}/api/setup/new-document`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!created.ok && created.status !== 204)
        throw new Error(`new-document failed: ${created.status}`);
    }
    await waitFor(`${base}/api/setup/status`, (res) => res.ok);
    const form = new URLSearchParams({ password1: PASSWORD, password2: PASSWORD });
    await fetch(`${base}/set-password`, { method: 'POST', body: form, redirect: 'manual' });
    let token = '';
    for (let i = 0; i < 30 && !token; i++) {
      const login = await fetch(`${base}/etapi/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      if (login.status === 201) token = ((await login.json()) as { authToken: string }).authToken;
      else await new Promise((r) => setTimeout(r, 1000));
    }
    if (!token) throw new Error('could not obtain an ETAPI token from the test container');
    writeFileSync(STATE_FILE, JSON.stringify({ url: `${base}/etapi`, token }));
  } catch (err) {
    spawnSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' });
    throw err;
  }
  return () => {
    spawnSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' });
    try {
      unlinkSync(STATE_FILE);
    } catch {
      /* already gone */
    }
  };
}
