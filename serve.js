#!/usr/bin/env node
// Minimal static file server. No dependencies.
// Usage: node serve.js [port]

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const ROOT = resolve(new URL('./docs/', import.meta.url).pathname);
const PORT = parseInt(process.argv[2] || process.env.PORT || '8005', 10);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.map':  'application/json; charset=utf-8',
};

function safePath(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const abs = normalize(join(ROOT, clean));
  if (!abs.startsWith(ROOT + sep) && abs !== ROOT) return null;
  return abs;
}

const server = createServer(async (req, res) => {
  try {
    let path = safePath(req.url);
    if (!path) { res.writeHead(403); res.end('Forbidden'); return; }
    let s;
    try { s = await stat(path); } catch { res.writeHead(404); res.end('Not found'); return; }
    if (s.isDirectory()) path = join(path, 'index.html');
    const body = await readFile(path);
    const type = TYPES[extname(path).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500);
    res.end('Server error: ' + err.message);
  }
});

server.listen(PORT, () => {
  console.log(`chromavox: http://localhost:${PORT}/`);
});
