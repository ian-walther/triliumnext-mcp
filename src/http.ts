#!/usr/bin/env node
/** Streamable HTTP entry point. */
import { serve } from '@hono/node-server';
import { createAppContext } from './app.js';
import { ConfigError } from './config.js';
import { createHttpTransport } from './transport/http.js';

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
  const { config, logger } = ctx;
  const transport = createHttpTransport(ctx);
  const server = serve(
    { fetch: transport.app.fetch, hostname: config.http.host, port: config.http.port },
    (info) => {
      logger.info('trilium-mcp listening on http', {
        url: `http://${info.address}:${info.port}${config.http.path}`,
        publicUrl: config.http.publicUrl,
        auth: config.auth.mode,
        legacy: config.http.legacy,
        trilium: config.trilium.baseUrl,
      });
    },
  );
  const shutdown = () => {
    logger.info('shutting down');
    server.close();
    void transport.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
