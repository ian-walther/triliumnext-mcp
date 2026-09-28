#!/usr/bin/env node
/** stdio entry point: one server per connection, scopes from configuration. */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createAppContext } from './app.js';
import { ConfigError } from './config.js';
import { buildServer } from './mcp/server.js';

function main(): void {
  let ctx;
  try {
    ctx = createAppContext();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`trilium-mcp: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
  const { config, logger, audit, services } = ctx;
  const handle = serveStdio(
    ({ era }) =>
      buildServer({
        name: config.serverName,
        version: config.serverVersion,
        services,
        principal: { id: 'stdio', scopes: config.stdio.scopes, transport: 'stdio' },
        era,
        audit,
        logger,
      }),
    {
      legacy: config.stdio.legacy,
      onerror: (error) => logger.error('stdio transport error', { err: error }),
    },
  );
  logger.info('trilium-mcp listening on stdio', {
    version: config.serverVersion,
    scopes: config.stdio.scopes,
    trilium: config.trilium.baseUrl,
  });
  const shutdown = () => {
    void handle.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
