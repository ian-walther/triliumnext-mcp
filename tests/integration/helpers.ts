import { readFileSync } from 'node:fs';
import { IdempotencyStore } from '../../src/domain/idempotency.js';
import { createServices, type Services } from '../../src/domain/services.js';
import { TriliumClient } from '../../src/etapi/client.js';
import { STATE_FILE } from './globalSetup.js';

export interface LiveTrilium {
  client: TriliumClient;
  services: Services;
  url: string;
  token: string;
}

export function connectLive(): LiveTrilium {
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { url: string; token: string };
  const client = new TriliumClient({ baseUrl: state.url, token: state.token, timeoutMs: 20_000 });
  const services = createServices({
    client,
    limits: {
      maxWriteContentBytes: 2_000_000,
      defaultReadContentBytes: 256_000,
      maxReadContentBytes: 4_000_000,
      maxSearchLimit: 200,
      maxChildren: 500,
    },
    idempotency: new IdempotencyStore(),
  });
  return { client, services, ...state };
}

export function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
