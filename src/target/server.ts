/**
 * Boots the demo back-office. Both tenants run the same code with a different
 * profile; the variant exists so a capability recorded on one can be replayed
 * against the other.
 */
import { createTargetApp } from './app.js';

const basePort = Number(process.env.TARGET_HOST_PORT ?? 4310);
const variantPort = Number(process.env.TARGET_VARIANT_HOST_PORT ?? 4311);
const only = process.argv[2];

function boot(tenantId: string, port: number, variable: string): void {
  const app = createTargetApp({ tenantId });
  const server = app.listen(port, () => {
    console.log(`[target] tenant=${tenantId} http://localhost:${port}/`);
  });
  // A bare EADDRINUSE stack trace names nothing the reader can act on, and a
  // machine that has run another project almost certainly has something on one
  // of these ports already. Say which port, and which variable moves it.
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `[target] port ${port} is already in use. Run it somewhere else with ${variable}=<port>, ` +
          `or set it in .env (see .env.example).`,
      );
      process.exit(1);
    }
    throw error;
  });
}

if (only === 'base' || only === undefined) boot('base', basePort, 'TARGET_HOST_PORT');
if (only === 'northbay' || only === undefined) {
  boot('northbay', variantPort, 'TARGET_VARIANT_HOST_PORT');
}
