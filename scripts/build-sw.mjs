import { readdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const files = (await readdir('dist/assets')).map((f) => '/assets/' + f);
const index = await readFile('dist/index.html', 'utf8');
const version = createHash('sha256').update(index).digest('hex').slice(0, 12);
await writeFile(
  'dist/sw.js',
  `const CACHE='aquarium-${version}';const ASSETS=${JSON.stringify(['/', '/index.html', '/icon.svg', '/manifest.webmanifest', ...files])};
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('aquarium-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(event.request.method!=='GET'||url.origin!==self.location.origin||event.request.headers.has('authorization'))return;if(event.request.mode==='navigate'){event.respondWith(fetch(event.request).catch(()=>caches.match('/index.html')));return;}if(ASSETS.includes(url.pathname))event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request)));});`,
);
