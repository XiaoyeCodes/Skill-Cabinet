import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCategories } from './dist/categories.js';
import { writeRepositoryCategories } from './repository-categories.mjs';
const root = path.resolve(fileURLToPath(new URL('./dist/', import.meta.url)));
const repository = path.resolve(root, '..');
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.zip':'application/zip','.jpg':'image/jpeg','.svg':'image/svg+xml'};
export function createServer({ repositoryRoot = repository } = {}) {
 let categoryWrites = Promise.resolve();
 return http.createServer(async(req,res)=>{
  try {
    if (req.url === '/api/categories') {
      if (req.method !== 'PUT') { res.writeHead(405, { Allow: 'PUT' }).end(); return; }
      const host = req.headers.host || '';
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) || req.headers['sec-fetch-site'] === 'cross-site' || req.headers.origin && req.headers.origin !== `http://${host}`) {
        res.writeHead(403).end('Forbidden'); return;
      }
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') { res.writeHead(415).end(); return; }
      try {
        const chunks = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 128 * 1024) { res.writeHead(413).end(); return; }
          chunks.push(chunk);
        }
        let names;
        try { names = normalizeCategories(JSON.parse(Buffer.concat(chunks).toString('utf8')).categories); }
        catch { res.writeHead(400).end('Invalid categories'); return; }
        const pending = categoryWrites.then(() => writeRepositoryCategories(path.join(repositoryRoot, 'skill-cabinet/manifest.json'), names));
        categoryWrites = pending.catch(() => {});
        const categories = await pending;
        res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' }).end(JSON.stringify({ categories }));
      } catch { res.writeHead(500).end('分类未写入仓库，本地内容已保留，请稍后重试。'); }
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    const requested = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    // Expose only the tracked library manifest and content-addressed archives.
    const isLibrary = requested.startsWith('/skill-cabinet/');
    if (isLibrary && !/^\/skill-cabinet\/(manifest\.json|archives\/[a-z0-9][a-z0-9_-]*-[a-f0-9]{64}\.zip)$/.test(requested)) {
      res.writeHead(404).end('Not found'); return;
    }
    const target = path.resolve(isLibrary ? repositoryRoot : root,'.'+requested);
    if (isLibrary) {
      const data = await readFile(target);
      res.writeHead(200, {'Content-Type':types[path.extname(target)], 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'}).end(req.method === 'HEAD' ? undefined : data);
      return;
    }
    if (target !== root && !target.startsWith(root+path.sep)) {res.writeHead(403).end();return;}
    const info = await stat(target);
    const file = info.isDirectory()?path.join(target,'index.html'):target;
    const data=await readFile(file);
    res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'}).end(req.method === 'HEAD' ? undefined : data);
  } catch {res.writeHead(404).end('Not found');}
}); }
const port=Number(process.env.PORT||4173);
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer().listen(port,'127.0.0.1',()=>console.log(`Skill Cabinet: http://localhost:${port}`));
}
