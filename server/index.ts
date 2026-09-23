/**
 * Press Brake Simulator — production server (`npm run serve` = `tsx server/index.ts`).
 *   PORT      listening port (default 8080)
 *   DATA_DIR  directory of the shared tool library `library.json` (default ./data; /data in Docker)
 *   DIST_DIR  built front-end (default ./dist)
 *   HOST      bind address (default 0.0.0.0)
 */
import path from 'node:path';
import { createApp, hasBuiltFrontend, libraryFilePath } from './app.ts';

const port = Number.parseInt(process.env['PORT'] ?? '8080', 10);
const host = process.env['HOST'] ?? '0.0.0.0';
const dataDir = path.resolve(process.env['DATA_DIR'] ?? './data');
const distDir = path.resolve(process.env['DIST_DIR'] ?? './dist');

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`[pbsim] invalid PORT '${process.env['PORT']}'`);
  process.exit(1);
}

const app = createApp({ distDir, dataDir });
const server = app.listen(port, host, async () => {
  const built = await hasBuiltFrontend(distDir);
  console.log(`[pbsim] listening on http://${host}:${port}`);
  console.log(`[pbsim] front-end: ${distDir}${built ? '' : ' (no build found — run "npm run build"; only /api is served)'}`);
  console.log(`[pbsim] shared library: ${libraryFilePath(dataDir)}`);
});

let closing = false;
function shutdown(signal: string): void {
  if (closing) return;
  closing = true;
  console.log(`[pbsim] ${signal} — shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
