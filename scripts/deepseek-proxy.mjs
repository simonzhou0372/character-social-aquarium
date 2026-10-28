// Optional loopback-only transport. No scheduler, logging of prompts, or credentials in the browser.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export function loadLocalKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const env = readFileSync('.env.local', 'utf8');
    const line = env.split(/\r?\n/).find((s) => /^\s*DEEPSEEK_API_KEY\s*=/.test(s));
    return line
      ?.slice(line.indexOf('=') + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
  } catch {
    return undefined;
  }
}
export function startProxy(
  key = loadLocalKey(),
  port = Number(process.env.AQUARIUM_PROXY_PORT ?? 8788),
) {
  if (!key) throw new Error('请在本地 .env.local 配置 DEEPSEEK_API_KEY；不要把密钥提交到Git。');
  const origins = new Set([
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    'http://127.0.0.1:4173',
    'http://localhost:4173',
  ]);
  if (process.env.AQUARIUM_ORIGIN) {
    const u = new URL(process.env.AQUARIUM_ORIGIN);
    if (u.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(u.hostname))
      throw new Error('附加来源必须是本机HTTP地址');
    origins.add(u.origin);
  }
  let active = 0;
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (!origin || !origins.has(origin)) {
      res.writeHead(403);
      res.end();
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const path = req.url?.replace(/^\/v1\//, '/');
    if (
      !(path === '/chat/completions' && req.method === 'POST') &&
      !(path === '/models' && req.method === 'GET')
    ) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (active >= 4) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: '本地传输通道繁忙' } }));
      return;
    }
    active++;
    const controller = new AbortController(),
      timeout = setTimeout(() => controller.abort(), 125000);
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      let body = '',
        bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) throw new Error('请求超过4MB');
        body += chunk;
      }
      let payload;
      if (req.method === 'POST') {
        const input = JSON.parse(body);
        if (input.stream === true) throw new Error('当前传输使用非流式响应');
        payload = Object.fromEntries(
          [
            'model',
            'messages',
            'max_tokens',
            'temperature',
            'response_format',
            'thinking',
            'reasoning_effort',
          ]
            .filter((k) => input[k] !== undefined)
            .map((k) => [k, input[k]]),
        );
      }
      const upstream = await fetch('https://api.deepseek.com' + path, {
        method: req.method,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: payload ? JSON.stringify(payload) : undefined,
        signal: controller.signal,
        redirect: 'error',
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8' });
      // Preserve the complete provider usage object, cache counters and reasoning token details.
      res.end(text.split(key).join('[redacted]'));
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(controller.signal.aborted ? 504 : 400, {
          'Content-Type': 'application/json',
        });
        res.end(
          JSON.stringify({
            error: {
              message: controller.signal.aborted
                ? '传输超时'
                : '本地传输失败，请检查请求格式及网络',
            },
          }),
        );
      }
    } finally {
      active--;
      clearTimeout(timeout);
    }
  });
  return server.listen(port, '127.0.0.1', () =>
    console.log(
      `本地 DeepSeek 传输：http://127.0.0.1:${port}/v1；浏览器API Key可填 local-proxy。确认“此兼容代理支持DeepSeek参数”后可使用按任务推理和完整用量统计。`,
    ),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    startProxy();
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
