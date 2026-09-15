import { createTargetApp } from './app.js';

// Starts both tenants, or just one if you pass `base` or `northbay`.

const basePort = Number(process.env.TARGET_HOST_PORT ?? 4310);
const variantPort = Number(process.env.TARGET_VARIANT_HOST_PORT ?? 4311);
const only = process.argv[2];

function boot(tenantId: string, port: number, portVariable: string): void {
  const server = createTargetApp({ tenantId }).listen(port, () => {
    console.log(`[target] ${tenantId} listening on http://localhost:${port}/`);
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[target] port ${port} is already in use, set ${portVariable} to use another one`);
      process.exit(1);
    }
    throw error;
  });
}

if (only === undefined || only === 'base') boot('base', basePort, 'TARGET_HOST_PORT');
if (only === undefined || only === 'northbay') boot('northbay', variantPort, 'TARGET_VARIANT_HOST_PORT');
