// Zero-dependency static dev server.
//
//   node server.mjs [port]
//
// Serves the game at http://127.0.0.1:8788/
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8788);

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

const server = createServer(async (req, res) => {
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
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ragdoll dino -> http://127.0.0.1:${PORT}/`);
});
