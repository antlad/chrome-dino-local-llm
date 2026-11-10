// Zero-dependency static dev server.
//
//   node server.mjs [port]
//
// Serves the game at http://127.0.0.1:8788/
// If the port is already taken (a previous `npm start` still running), we walk
// forward to the next free port instead of dying with EADDRINUSE. Set
// PORT_STRICT=1 to keep the old fail-fast behaviour.
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

async function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  let rel = normalize(clean).replace(/^([/\\])+/, '');
  if (rel === '' || rel === '.') rel = 'index.html';
  const abs = resolve(join(ROOT, rel));
  // Path traversal guard.
  if (!abs.startsWith(ROOT)) return null;
  try {
    const info = await stat(abs);
    if (info.isDirectory()) return resolveFile(join(clean, 'index.html'));
  } catch {
    return null;
  }
  return abs;
}

async function handler(req, res) {
  try {
    const abs = await resolveFile(req.url ?? '/');
    if (!abs) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`404 ${req.url}\n`);
      return;
    }
    const body = await readFile(abs);
    res.writeHead(200, {
      'content-type': MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'content-length': body.length,
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`500 ${err.message}\n`);
  }
}

const HOST = '127.0.0.1';
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8788);
const MAX_PORT_ATTEMPTS = 20;
const STRICT = process.env.PORT_STRICT === '1' || process.env.PORT_STRICT === 'true';

// A dev server left over from an earlier `npm start` is the common case, so a
// busy port is not an error: if it is already us, say so and exit happily.
function probeUs(port) {
  return new Promise((done) => {
    const req = createConnection({ host: HOST, port }, () => {
      req.write(`GET / HTTP/1.1\r\nHost: ${HOST}:${port}\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    req.setTimeout(750, () => req.destroy());
    req.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 8192) req.destroy();
    });
    req.on('error', () => done(false));
    req.on('close', () => done(/Ragdoll T-Rex/.test(buf)));
  });
}

function listen(port, attempts) {
  const server = createServer(handler);

  server.on('error', async (err) => {
    if (err.code !== 'EADDRINUSE') {
      console.error(err.message);
      process.exit(1);
    }
    if (!STRICT && (await probeUs(port))) {
      console.log(`already running -> http://${HOST}:${port}/  (same server, exiting)`);
      console.log('to restart it: npm restart');
      process.exit(0);
    }
    if (STRICT || attempts <= 1) {
      console.error(`port ${port} is in use by another process. Try: node server.mjs ${port + 1}`);
      process.exit(1);
    }
    console.log(`port ${port} busy, trying ${port + 1}`);
    listen(port + 1, attempts - 1);
  });

  server.listen(port, HOST, () => {
    console.log(`ragdoll dino -> http://${HOST}:${port}/`);
  });
}

listen(PORT, MAX_PORT_ATTEMPTS);
