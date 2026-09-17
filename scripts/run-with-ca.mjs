// Dev wrapper: if a local TLS-interception root CA is present, make Node trust
// it before launching the real command, then exec the command transparently.
//
// Why this exists: on machines behind a TLS-inspecting proxy (e.g. Cloudflare
// WARP / Zero Trust) every HTTPS cert is re-signed by a private root. curl and
// Chromium trust it via the system keychain, but Node's `fetch` (undici) ships
// its own CA bundle and rejects it with SELF_SIGNED_CERT_IN_CHAIN — surfacing
// as a useless "fetch failed". Export the proxy root to ./certs (gitignored)
// and this wrapper wires it in via NODE_EXTRA_CA_CERTS.
//
// In CI/prod (no such file) it's a no-op: the command runs unchanged.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const certPath =
  process.env.DEV_CA_CERT || resolve(here, '../certs/cloudflare-gateway-root.pem');

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error('Usage: node scripts/run-with-ca.mjs <command> [args...]');
  process.exit(1);
}

const env = { ...process.env };
if (existsSync(certPath) && !env.NODE_EXTRA_CA_CERTS) {
  env.NODE_EXTRA_CA_CERTS = certPath;
}

const child = spawn(cmd, args, { stdio: 'inherit', env, shell: false });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on('error', (err) => {
  console.error(`run-with-ca: failed to launch "${cmd}": ${err.message}`);
  process.exit(1);
});
