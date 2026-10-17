// config.mjs —— 三个脚本共用的环境探测：找 tailscale、解析访问域名、定位 DSH 凭据
//
// 设计原则：**零配置优先**。所有需要的值都能自动探测出来，探测不到才报错并告诉用户怎么补。
// 每个值都可以用环境变量覆盖（见 README「环境变量」一节）。

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const LISTEN_PORT = Number(process.env.DSH_REMOTE_PORT ?? 3080);
export const TARGET_PORT = Number(process.env.DSH_TARGET_PORT ?? 19387);
export const COOKIE_DAYS = 30; // 与 DSH 自己的 cookie 上限一致，签更长会被服务端拒收
export const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
export const CREDENTIALS = process.env.DSH_CREDENTIALS ?? path.join(DSH_HOME, '.credentials.yaml');
export const PROFILES_DIR = path.join(DSH_HOME, 'profiles');

export const b64u = (v) =>
  Buffer.from(v).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');

/** 找 tailscale 可执行文件：各平台的默认安装位置优先，最后交给 PATH。 */
export function findTailscale() {
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe'),
        path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Tailscale', 'tailscale.exe')
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale']
      : ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/usr/sbin/tailscale'];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'tailscale'; // 交给 PATH；找不到时 execFileSync 抛 ENOENT，由调用方接住
}

/** 跑一条 tailscale 子命令，返回 stdout；失败时抛出带上下文的错误。 */
export function tailscale(args, timeout = 20000) {
  const exe = findTailscale();
  try {
    return execFileSync(exe, args, { encoding: 'utf8', timeout, windowsHide: true });
  } catch (error) {
    const detail = typeof error.stderr === 'string' && error.stderr.trim() !== ''
      ? error.stderr.trim()
      : error.message;
    throw new Error(`调不动 tailscale（${exe} ${args.join(' ')}）：${detail}`);
  }
}

/**
 * 解析出本机的访问域名。
 * `tailscale status --json` 的 Self.DNSName 形如 "host.tailnet.ts.net."（◆ 带尾点，必须去掉）。
 */
export function detectAuthority() {
  const explicit = process.env.DSH_AUTHORITY;
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim().replace(/\.$/u, '');

  const json = tailscale(['status', '--json']);

  let dnsName;
  try {
    dnsName = JSON.parse(json)?.Self?.DNSName;
  } catch {
    dnsName = undefined; // 落到下面统一的报错
  }
  if (typeof dnsName !== 'string' || dnsName === '') {
    throw new Error(
      'tailscale status --json 里没有 Self.DNSName —— Tailscale 可能还没登录，或还没分配 MagicDNS 名。\n' +
        '  登录后可用 `tailscale status` 确认，或显式指定 DSH_AUTHORITY。'
    );
  }
  return dnsName.replace(/\.$/u, '');
}

/** 读出与 DSH 各实例共享的 cookie 签名密钥（32 字节）。 */
export function loadSecret() {
  if (!fs.existsSync(CREDENTIALS)) {
    throw new Error(
      `找不到 DSH 凭据文件：${CREDENTIALS}\n` +
        `  · 这个文件由 DSH 自己生成，先启动一次 DSH 再回来；\n` +
        `  · 如果你的 DSH 数据目录不在默认位置，用 DSH_HOME 或 DSH_CREDENTIALS 指过去。`
    );
  }
  const raw = fs.readFileSync(CREDENTIALS, 'utf8');
  const m = raw.match(/client-connection\/browser-session:[\s\S]{0,400}?secret:\s*([A-Za-z0-9_-]+)/);
  if (m === null) {
    throw new Error(
      `凭据文件里找不到 client-connection/browser-session 的 secret：${CREDENTIALS}\n` +
        `  · 启动一次 DSH，让它把这个条目写进去。`
    );
  }
  const secret = Buffer.from(m[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  if (secret.length !== 32) throw new Error('secret 长度不是 32 字节，拒绝使用');
  return secret;
}

// ---------------- Host / authority 判定（纯函数，便于单测） ----------------

/** 去掉默认端口，避免 https 默认 443 有无端口的写法被当成两个域名 */
export const stripDefaultPort = (host) => host.replace(/:(?:443|80)$/u, '');

/**
 * 域名大小写不敏感：DSH_AUTHORITY 写成 DSH.TS.NET 与 dsh.ts.net 必须被视为同一站点。
 * ❗曾经直接拿 URL 规范化后的 host 与配置原文做 === 比较，配置写大写时永远不相等 → 全部 403
 * （2026-10-17 独立评审指出）。浏览器发来的 Host 一律小写，所以统一归一到小写再比较与签 cookie。
 */
export const normalizeHost = (host) => stripDefaultPort(host).toLowerCase();

const LOOPBACK_HOST_RE = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\])(?::\d+)?$/iu;

/** 请求是不是真的从本机回环发来的（不是"Host 头写着回环"） */
export const fromLoopback = (ip) =>
  typeof ip === 'string' && /^(?:127\.|::1$|::ffff:127\.)/u.test(ip);

/**
 * 返回规范化后的 authority；不是允许的站点就返回 undefined。
 * 调用方拿到 undefined 必须直接 403，不能「不签 cookie 但还是转发」。
 *
 * @param headers          请求头（只看 host）
 * @param remoteAddress    socket 的 remoteAddress，用于判断是否真的来自本机
 * @param expected         配置里期望的域名（原文，大小写无所谓）
 * @param allowLoopback    是否放行回环 Host（必须同时是回环来源，见下）
 */
export function matchAuthority(headers, remoteAddress, expected, allowLoopback = false) {
  const host = headers.host;
  if (typeof host !== 'string' || host === '') return undefined;
  let canonical;
  try { canonical = new URL('http://' + host).host; } catch { return undefined; }
  if (canonical === '') return undefined;
  if (normalizeHost(canonical) === normalizeHost(expected)) return normalizeHost(canonical);
  // ❗调试放行必须同时满足：显式开启 + 物理上来自回环。
  // 只看 Host 的话，远端只要把 Host 改成 127.0.0.1 就能重新打开原来那个绕过面（2026-10-17 评审指出）。
  if (allowLoopback && fromLoopback(remoteAddress) && LOOPBACK_HOST_RE.test(canonical)) return normalizeHost(canonical);
  return undefined;
}

/** 探测某个本地端口有没有在监听（用来确认 DSH 桌面端开着）。 */
export function probeTcp(port, host = '127.0.0.1', timeout = 2000) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok, detail) => { socket.destroy(); resolve({ ok, detail }); };
    socket.setTimeout(timeout);
    socket.on('connect', () => done(true, '在监听'));
    socket.on('timeout', () => done(false, '超时'));
    socket.on('error', (error) => done(false, error.code ?? error.message));
  });
}
