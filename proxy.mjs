// dsh-remote-proxy —— 把你的 DSH 安全地开放给手机(经 Tailscale)
//
// 背景：DSH 桌面端内置的 Web 服务只监听回环地址，只有本机能开。
//       端口在 0.2.0 及更早是固定的 19387；0.2.1 起改为系统分配（每次启动可能不同），
//       所以这里默认自动探测，DSH_TARGET_PORT 只用来显式覆盖。
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
//   DSH_TARGET_PORT   DSH 桌面端 Web 端口；不设则自动探测（0.2.1 起端口由系统分配）
//   DSH_HOME          DSH 数据目录，默认 ~/.dsh
//   DSH_CREDENTIALS   凭据文件路径，默认 <DSH_HOME>/.credentials.yaml

import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import {
  LISTEN_PORT,
  TARGET_PORT,
  TARGET_PORT_OVERRIDE,
  detectDshPort,
  COOKIE_DAYS,
  CREDENTIALS,
  b64u,
  detectAuthority,
  loadSecret,
  matchAuthority,
  normalizeHost
} from './config.mjs';

// 桌面端 0.2.1 起用系统分配的端口，每次启动都可能变 —— 用可变量持有，探测到变化就替换。
let targetPort = TARGET_PORT;

// ❗开机自启时 Tailscale 可能还没就绪：登录触发的计划任务往往比 tailscaled 早几十秒，
//    那一刻 `tailscale status --json` 里还没有 Self.DNSName —— 这是**临时状态**，不是配置错误。
//    2026-10-20 凌晨真实踩到：计划任务 01:24:32 启动，代理 01:24:34 直接 exit(1)；
//    而计划任务是 onlogon 一次性触发、不会重试 → 手机端一路 502，直到有人手动拉起。
//    所以这里改成「等依赖就绪」：默认最多等 3 分钟，每 5 秒重试一次。
//    显式设 DSH_BOOT_WAIT_MS=0 可以关掉等待（排查配置错误时想立刻看到报错就用它）。
const BOOT_WAIT_MS = Number(process.env.DSH_BOOT_WAIT_MS ?? 180000);
const BOOT_RETRY_MS = 5000;

let AUTHORITY;
let secret;
{
  const deadline = Date.now() + BOOT_WAIT_MS;
  let announced = false;
  for (;;) {
    try {
      AUTHORITY = detectAuthority();
      secret = loadSecret();
      break;
    } catch (error) {
      if (Date.now() >= deadline) {
        console.error('\ndsh-remote-proxy 启动失败：\n');
        console.error(error.message);
        console.error('\n先跑一次自检：node setup.mjs\n');
        process.exit(1);
      }
      if (!announced) {
        console.error(`\n等待依赖就绪（最多 ${Math.round(BOOT_WAIT_MS / 1000)} 秒，每 ${BOOT_RETRY_MS / 1000} 秒重试）：`);
        console.error(`  ${error.message.split('\n')[0]}`);
        announced = true;
      }
      await new Promise((resolve) => setTimeout(resolve, BOOT_RETRY_MS));
    }
  }
}

/**
 * 只接受配置里的访问域名，其余一律拒绝。
 *
 * ❗旧实现额外放行了 loopback Host（127.0.0.1 / localhost / [::1]），本意是「本机从 3080 也能打开」。
 * 但 Host 是请求方自己填的：从 Tailscale 打进来的远端请求只要把 Host 改成 127.0.0.1:3080，
 * 代理就会为这个 loopback authority 签一份 cookie 并原样转发；DSH 看到「Host 是回环 + 一份合法 cookie」
 * 就放行 —— trustedHosts 被整条绕过（2026-10-17 盲审的 P0）。
 *
 * 现在只认 AUTHORITY。本机要访问请直接开 DSH 的窗口（或 http://127.0.0.1:<DSH 端口>/），不经过这个代理。
 * 确实需要放行回环 Host 时设 DSH_ALLOW_LOOPBACK=1（仅供本机调试）。
 */
const ALLOW_LOOPBACK = process.env.DSH_ALLOW_LOOPBACK === '1';

/**
 * 判定逻辑（含域名大小写归一、回环放行条件）已移到 config.mjs 的 matchAuthority，
 * 那边是纯函数，可以直接单测；这里只绑定本进程的 AUTHORITY 与开关。
 */
const authorityOf = (headers, remoteAddress) => matchAuthority(headers, remoteAddress, AUTHORITY, ALLOW_LOOPBACK);

/**
 * ❗跨源请求必须在改写之前拦掉（2026-10-17 复审指出的 CSRF 面）。
 *
 * 代理会把 Host/Origin 改写成回环，而 DSH 对回环请求一律放行 —— 于是「任何能让浏览器访问
 * https://<域名>/ 的页面」都能驱动浏览器发出带认证的写请求（cookie 由代理自己签，浏览器不需要持有）。
 * 所以：只要带了 Origin，就必须等于访问域名本身；其余一律 403。
 * 没有 Origin 的请求（同源 GET、curl、健康检查）不受影响。
 */
function originAllowed(origin) {
  if (origin === undefined) return true;
  try {
    return normalizeHost(new URL(String(origin)).host) === normalizeHost(AUTHORITY);
  } catch {
    return false;
  }
}

function cookieName(authority) {
  return 'dsh-auth-' + b64u(crypto.createHash('sha256').update(normalizeHost(authority)).digest());
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
  // HttpOnly：这枚 cookie 只该由浏览器自动携带，JS 读不到，XSS 也偷不走；
  // Secure：唯一入口是 https（tailscale serve），加锁后不会再随明文 http 发出去。
  // 注意：如果直接拿明文 http 访问 3080，浏览器会丢弃这条 Secure cookie，表现是每次请求都重签一枚，
  // 功能不受影响（响应头每次都带 Set-Cookie），只是多一次 HMAC，不必为此去掉 Secure。
  return `${cookieName(authority)}=${mintCookie(authority)}; Max-Age=${maxAge}; Path=/; Expires=${expires}; SameSite=Lax; HttpOnly; Secure`;
}

/**
 * 用我们签的 cookie 覆盖同名项。
 *
 * ❗只替换**同名那一枚**（回环 authority 的）。曾一度改成「过滤整个 dsh-auth- 前缀」，
 * 想一次清干净，但那样会把 DSH 自己种的其他 dsh-auth-* 也吞掉（登出/多设备语义靠它），
 * 2026-10-17 复审指出后收窄回来。浏览器手里域名那枚名字不同，DSH 按 Host 找回环名，留着不影响。
 */
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
  const authority = authorityOf(req.headers, req.socket && req.socket.remoteAddress);
  if (authority === undefined) {
    // ❗不要「不签 cookie 但还是转发」：那样远端伪造 Host 依然能被 DSH 当成回环请求放行。
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(
      'dsh-remote-proxy：只接受 https://' + AUTHORITY + '/ 这个域名。\n' +
        '本机请直接访问 http://127.0.0.1:' + targetPort + '/ ，不要经过这个代理。\n'
    );
    return;
  }
  // ❗跨源请求必须在改写之前拦掉（2026-10-17 复审指出的 CSRF 面）：代理会把 Host/Origin 改成回环，
  // 而 DSH 对回环请求一律放行 —— 于是任何能让浏览器访问 https://<域名>/ 的页面，都能驱动浏览器
  // 发出带认证的写请求（cookie 由代理自己签，浏览器根本不需要持有）。所以只要带了 Origin，
  // 就必须等于访问域名本身；没有 Origin 的请求（同源 GET、curl、健康检查）不受影响。
  if (!originAllowed(req.headers.origin)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('dsh-remote-proxy：跨源请求被拒绝（Origin 必须等于访问域名）。\n');
    return;
  }

  // ❗0.2.1 起 DSH 的 /api 与 WebSocket 一样只认「回环 Host + 回环 Origin + authority 为回环的 cookie」：
  // 域名 Host 的 HTTP 请求会被 403（页面 HTML 本身却放行），表现是「界面壳能打开、对话和数据全空」。
  // 所以普通请求也必须把三者改写成回环；来源 Host 上面已经校验过，改写是安全的。
  const loop = '127.0.0.1:' + targetPort;
  const name = cookieName(loop);

  // 每次都重签：客户端那枚是域名 authority 签的，DSH 按 Host 找回环名，原样转发必然对不上。
  const prepareHeaders = (base) => {
    const headers = { ...base };
    headers.host = loop;
    if (headers.origin !== undefined) headers.origin = 'http://' + loop;
    headers.cookie = withCookie(headers.cookie, name, mintCookie(loop));
    return headers;
  };

  const forward = (headers, retried) => {
    const upstream = http.request({
      host: '127.0.0.1',
      port: targetPort,
      path: req.url,
      method: req.method,
      headers
    });
    upstream.on('response', (pres) => {
      // 补过 cookie 还被拒（例如浏览器残留了同名旧 cookie）：换成全新的再取一次。
      const isGetIndex = req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'));
      if (pres.statusCode === 401 && name !== undefined && !retried && isGetIndex) {
        pres.resume();
        forward({ ...headers, cookie: withCookie(undefined, name, mintCookie(loop)) }, true);
        return;
      }
      const out = { ...pres.headers };
      // 只剥「回环 authority 那一枚」：DSH 自己发的其他 cookie（含登出用的过期 cookie）必须留着。
      const existing = asArray(out['set-cookie']).filter((line) => !line.startsWith(name + '='));
      out['set-cookie'] = [...existing, cookieHeader(authority)];
      // 页面 HTML 一律不缓存：DSH 自己不发 cache-control，浏览器留着旧版本前端壳时，
      // 换版本后会拿旧资源名去请求（404）→ 界面残缺（例如没有输入框）。带 hash 的静态资源不用管。
      if (typeof out['content-type'] === 'string' && out['content-type'].startsWith('text/html')) {
        out['cache-control'] = 'no-store';
      }
      res.writeHead(pres.statusCode, out);
      pres.pipe(res);
    });
    upstream.on('error', (error) => {
      // 桌面端重启会换端口：失败时立刻补探一次，下一个请求就能连上（不必等轮询）
      if (TARGET_PORT_OVERRIDE === undefined) {
        void detectDshPort().then((found) => {
          if (found !== undefined && found !== targetPort) {
            console.log('DSH 端口变化：' + targetPort + ' -> ' + found);
            targetPort = found;
          }
        });
      }
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`dsh-remote-proxy：连不上 DSH 的 127.0.0.1:${targetPort} —— ${error.message}\n`);
    });
    req.pipe(upstream);
  };

  forward(prepareHeaders(req.headers), false);
}

// 系统分配的端口每次启动都可能变。这里每 5 分钟重探一次，换端口后下一个请求自动跟上；
// 请求失败时还会立刻补探（见上面的 upstream.on('error')），所以实际感知延迟是「第一次 502」。
if (TARGET_PORT_OVERRIDE === undefined) {
  setInterval(() => {
    void detectDshPort().then((found) => {
      if (found !== undefined && found !== targetPort) {
        console.log('DSH 端口变化：' + targetPort + ' -> ' + found);
        targetPort = found;
      }
    });
  }, 300000).unref();
}

const server = http.createServer(handle);

// WebSocket 升级：同样补 cookie，然后原样透传握手与后续字节流。
server.on('upgrade', (req, socket, head) => {
  const authority = authorityOf(req.headers, socket.remoteAddress);
  if (authority === undefined) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  if (!originAllowed(req.headers.origin)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  // ❗DSH 的 WebSocket 端点只认「回环 Host + 回环 Origin + authority 为回环的 cookie」：
  // 即便 profile 的 trustedHosts 里配了访问域名，域名 Host/Origin 也一律 403（2026-10-17 实测四种组合，
  // 只有回环那组拿到 101）。所以这里把三者统一改写成回环；来源 Host 上面已经校验过，改写是安全的。
  const loopAuthority = '127.0.0.1:' + targetPort;
  const name = cookieName(loopAuthority);
  const headers = { ...req.headers };
  headers.host = loopAuthority;
  if (headers.origin !== undefined) headers.origin = 'http://' + loopAuthority;
  headers.cookie = withCookie(headers.cookie, name, mintCookie(loopAuthority));
  const upstream = net.connect(targetPort, '127.0.0.1', () => {
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
  console.log(`dsh-remote-proxy：127.0.0.1:${LISTEN_PORT} -> 127.0.0.1:${targetPort}（自动探测）`);
  console.log(`  接受域名：${AUTHORITY}`);
  console.log(`  凭据文件：${CREDENTIALS}`);
  console.log('  手机打开：https://' + AUTHORITY + '/（首次会自动种 30 天 cookie）');
});
