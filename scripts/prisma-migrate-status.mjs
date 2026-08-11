import { spawn } from 'node:child_process';

// Prisma 6.19's schema-engine status path can emit an empty response when an ambient shell sets
// RUST_LOG=warn. Pinning the CLI subprocess to info makes the release gate deterministic without
// changing application logging or leaking the datasource URL.
const child = spawn(
  process.execPath,
  ['node_modules/prisma/build/index.js', 'migrate', 'status', ...process.argv.slice(2)],
  {
    cwd: process.cwd(),
    env: { ...process.env, RUST_LOG: 'info' },
    stdio: 'inherit',
  },
);

child.on('error', (error) => {
  process.stderr.write(`Unable to start Prisma migration status: ${error.message}\n`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) {
    process.stderr.write(`Prisma migration status stopped by ${signal}\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
