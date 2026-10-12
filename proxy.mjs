// dsh-remote-proxy —— 把你的 DSH 安全地开放给手机(经 Tailscale)
//
// 背景：DSH 桌面端内置的 Web 服务固定监听 127.0.0.1:19387，只有本机能开。
//       手机走 Tailscale 打进来的是 127.0.0.1:3080（tailscale serve 的目标端口）。
//       这个代理站在两者中间。
//
// 它做两件事：
//   ① 把请求原样转发给桌面端（Host 透传；DSH 的 profile 里要把该域名加入信任白名单）
//   ② 自动完成登录：DSH 的登录 cookie = HMAC-SHA256(共享密钥, payload)，
//      密钥持久化在 <DSH_HOME>/.credentials.yaml 的 client-connection/browser-session，各实例通用。
//      代理用同一个密钥签一个绑定当前 Host 的 cookie，替浏览器带上 —— 所以手机不用带 token。
//
// ❗ 为什么不让浏览器自己 303 回来：从微信/短信点开链接属于「跨站发起的导航」，
//    手机 Safari/Chrome 在跳转链里不会带上 SameSite=Strict 的 cookie，会变成无限 303
//    （ERR_TOO_MANY_REDIRECTS）。所以这里改成：响应 401 时由代理自己补上 cookie 重取一次，
//    浏览器侧一个跳转都没有，天然不可能循环。
//
// 零配置：访问域名靠 `tailscale status --json` 自动探测，凭据路径靠 DSH_HOME / 用户主目录定位。
// 需要覆盖时用环境变量：
//   DSH_AUTHORITY     期望的访问域名，默认自动探测（<机器名>.<tailnet>.ts.net）
//   DSH_REMOTE_PORT   代理监听端口，默认 3080（与 tailscale serve 的目标一致）
//   DSH_TARGET_PORT   DSH 桌面端 Web 端口，默认 19387
//   DSH_HOME          DSH 数据目录，默认 ~/.dsh
//   DSH_CREDENTIALS   凭据文件路径，默认 <DSH_HOME>/.credentials.yaml

import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import {
  LISTEN_PORT,
  TARGET_PORT,
  COOKIE_DAYS,
  CREDENTIALS,
  b64u,
  detectAuthority,
  loadSecret
} from './config.mjs';

let AUTHORITY;
let secret;
try {
  AUTHORITY = detectAuthority();
  secret = loadSecret();
} catch (error) {
  console.error('\ndsh-remote-proxy 启动失败：\n');
  console.error(error.message);
  console.error('\n先跑一次自检：node setup.mjs\n');
  process.exit(1);
}

/**
 * cookie 的 authority 必须与请求的 Host 完全一致（DSH 用 Host 算 cookie 名并写进签名负载），
 * 所以按每个请求的真实 Host 现算，而不是写死域名。
 */
function authorityOf(headers) {
  const host = headers.host;
  if (typeof host !== 'string' || host === '') return undefined;
  let canonical;
  try { canonical = new URL('http://' + host).host; } catch { return undefined; }
  const loopback = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\])(?::\d+)?$/iu.test(canonical);
  if (loopback || canonical === AUTHORITY) return canonical;
  return undefined; // 其它 Host：不签 cookie，交给 DSH 自己的信任栅栏去拒绝
}

function cookieName(authority) {
  return 'dsh-auth-' + b64u(crypto.createHash('sha256').update(authority).digest());
}

/** 按 DSH 的格式签一个绑定该 authority 的 cookie。 */
function mintCookie(authority) {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + COOKIE_DAYS * 86400000 - 60000;
  const body = b64u(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }));
  const sig = b64u(crypto.createHmac('sha256', secret).update(body).digest());
  return `v1.${body}.${sig}`;
}

/**
 * SameSite 用 Lax 而不是 DSH 自己的 Strict：跨站发起的那次导航里 Strict 不会被带上，
 * 会让「打开页面」这一步拿不到 cookie；Lax 对同站请求照常发送，安全性对本场景足够。
 */
function cookieHeader(authority) {
  const maxAge = COOKIE_DAYS * 86400;
  const expires = new Date(Date.now() + maxAge * 1000).toUTCString();
  return `${cookieName(authority)}=${mintCookie(authority)}; Max-Age=${maxAge}; Path=/; Expires=${expires}; SameSite=Lax`;
}

/** 把 Cookie 头里同名的那条替换成我们签的（避免浏览器残留的旧 cookie 排在前面被 DSH 先取到）。 */
function withCookie(headerValue, name, value) {
  const kept = typeof headerValue === 'string'
    ? headerValue.split(';').map((s) => s.trim()).filter((s) => s !== '' && !s.startsWith(name + '='))
    : [];
  kept.push(name + '=' + value);
  return kept.join('; ');
}

const hasCookie = (headerValue, name) =>
  typeof headerValue === 'string' && headerValue.split(';').some((s) => s.trim().startsWith(name + '='));

const asArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function handle(req, res) {
  const authority = authorityOf(req.headers);
  const name = authority === undefined ? undefined : cookieName(authority);

  // 客户端已带着我们的 cookie：原样转发。
  // 没带（新设备、清了数据、cookie 过期）：由代理补一个再转发 —— 浏览器侧零跳转，不可能循环。
  const prepareHeaders = (base) => {
    const headers = { ...base };
    if (name !== undefined && !hasCookie(headers.cookie, name)) {
      headers.cookie = withCookie(headers.cookie, name, mintCookie(authority));
    }
    return headers;
  };

  const forward = (headers, retried) => {
    const upstream = http.request({
      host: '127.0.0.1',
      port: TARGET_PORT,
      path: req.url,
      method: req.method,
      headers
    });
    upstream.on('response', (pres) => {
      // 补过 cookie 还被拒（例如浏览器残留了同名旧 cookie）：换成全新的再取一次。
      const isGetIndex = req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'));
      if (pres.statusCode === 401 && name !== undefined && !retried && isGetIndex) {
        pres.resume();
        forward({ ...headers, cookie: withCookie(undefined, name, mintCookie(authority)) }, true);
        return;
      }
      const out = { ...pres.headers };
      const existing = asArray(out['set-cookie']);
      if (name !== undefined && !existing.some((line) => line.startsWith(name + '='))) {
        out['set-cookie'] = [...existing, cookieHeader(authority)];
      }
      // 页面 HTML 一律不缓存：DSH 自己不发 cache-control，浏览器留着旧版本前端壳时，
      // 换版本后会拿旧资源名去请求（404）→ 界面残缺（例如没有输入框）。带 hash 的静态资源不用管。
      if (typeof out['content-type'] === 'string' && out['content-type'].startsWith('text/html')) {
        out['cache-control'] = 'no-store';
      }
      res.writeHead(pres.statusCode, out);
      pres.pipe(res);
    });
    upstream.on('error', (error) => {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`dsh-remote-proxy：连不上 DSH 的 127.0.0.1:${TARGET_PORT} —— ${error.message}\n`);
    });
    req.pipe(upstream);
  };

  forward(prepareHeaders(req.headers), false);
}

const server = http.createServer(handle);

// WebSocket 升级：同样补 cookie，然后原样透传握手与后续字节流。
server.on('upgrade', (req, socket, head) => {
  const authority = authorityOf(req.headers);
  const name = authority === undefined ? undefined : cookieName(authority);
  const headers = { ...req.headers };
  if (name !== undefined && !hasCookie(headers.cookie, name)) {
    headers.cookie = withCookie(headers.cookie, name, mintCookie(authority));
  }
  const upstream = net.connect(TARGET_PORT, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [key, value] of Object.entries(headers)) {
      lines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
    }
    lines.push('', '');
    upstream.write(lines.join('\r\n'));
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`dsh-remote-proxy：127.0.0.1:${LISTEN_PORT} -> 127.0.0.1:${TARGET_PORT}`);
  console.log(`  接受域名：${AUTHORITY}`);
  console.log(`  凭据文件：${CREDENTIALS}`);
  console.log('  手机打开：https://' + AUTHORITY + '/（首次会自动种 30 天 cookie）');
});
