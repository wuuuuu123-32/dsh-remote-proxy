// setup.mjs —— 装机自检：一次跑完，告诉你还差哪一步
//
// 用法：
//   node setup.mjs           只检查，不改动任何东西
//   node setup.mjs --serve   检查完顺手执行 `tailscale serve --bg <端口>`（需要管理员权限）

import fs from 'node:fs';
import path from 'node:path';
import {
  LISTEN_PORT,
  TARGET_PORT,
  DSH_HOME,
  CREDENTIALS,
  PROFILES_DIR,
  findTailscale,
  tailscale,
  detectAuthority,
  loadSecret,
  probeTcp
} from './config.mjs';

const wantServe = process.argv.includes('--serve');
const checks = [];
const record = (label, ok, detail) => { checks.push({ label, ok, detail }); };

// ── 1. Tailscale 客户端 ────────────────────────────────────────────────
const exe = findTailscale();
record('Tailscale 客户端', fs.existsSync(exe) || exe === 'tailscale', exe);

// ── 2. 访问域名（拿不到就没法继续，直接退出）────────────────────────────
let AUTHORITY;
try {
  AUTHORITY = detectAuthority();
  record('访问域名', true, AUTHORITY);
} catch (error) {
  record('访问域名', false, '探测失败');
  report();
  console.error('\n域名探测失败：\n' + error.message + '\n');
  process.exit(1);
}

// ── 3. DSH 凭据文件 ────────────────────────────────────────────────────
try {
  loadSecret();
  record('DSH 凭据文件', true, CREDENTIALS);
} catch {
  record('DSH 凭据文件', false, CREDENTIALS + '（读不到，先启动一次 DSH）');
}

// ── 4./5. 两个端口在不在听 ─────────────────────────────────────────────
const desktop = await probeTcp(TARGET_PORT);
record(`DSH 桌面端 :${TARGET_PORT}`, desktop.ok, desktop.detail);

const proxy = await probeTcp(LISTEN_PORT);
record(`本代理 :${LISTEN_PORT}`, proxy.ok, proxy.ok ? '已在运行' : '还没启动（正常，稍后跑 start-proxy）');

// ── 6. tailscale serve 是否指向本代理 ──────────────────────────────────
let serveWired = false;
let serveDetail;
try {
  const serveText = tailscale(['serve', 'status']);
  serveWired = serveText.includes(String(LISTEN_PORT));
  serveDetail = serveWired ? `已指向 ${LISTEN_PORT}` : `输出里没看到 ${LISTEN_PORT}`;
} catch (error) {
  serveDetail = '读不到状态：' + error.message.split('\n')[0];
}
record('tailscale serve', serveWired, serveDetail);

// ── 7. DSH profile 的信任白名单 ────────────────────────────────────────
const { hits, files } = checkTrustedHosts(AUTHORITY);
record(
  'profile 信任白名单',
  hits.length > 0,
  hits.length > 0 ? `${hits.map((h) => h.profile).join(', ')} 已包含该域名` : `没找到（扫了 ${files.length} 个 profile）`
);

report();

// ───────────────────────────────────────────────────────────────────────

function report() {
  const width = Math.max(...checks.map((c) => c.label.length));
  console.log('\nDSH 远程访问自检');
  console.log('─'.repeat(width + 30));
  for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.label.padEnd(width)}  ${c.detail}`);
  }
  console.log('─'.repeat(width + 30));
}

/** 在 profile 的 cordis.patch.yml 里找 trustedHosts 有没有包含该域名。 */
function checkTrustedHosts(authority) {
  const hits = [];
  const files = [];
  if (!fs.existsSync(PROFILES_DIR)) return { hits, files };
  for (const entry of fs.readdirSync(PROFILES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(PROFILES_DIR, entry.name, 'cordis.patch.yml');
    if (!fs.existsSync(file)) continue;
    files.push(file);
    if (hasTrustedHost(fs.readFileSync(file, 'utf8'), authority)) hits.push({ profile: entry.name, file });
  }
  return { hits, files };
}

/** 只看 trustedHosts: 之下的同级列表项，不误判到别处的同名文本。 */
function hasTrustedHost(text, authority) {
  const lines = text.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*trustedHosts:\s*$/u.test(lines[i])) continue;
    const indent = lines[i].match(/^\s*/u)[0].length;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') continue;
      if (line.match(/^\s*/u)[0].length <= indent) break;
      const m = line.match(/^\s*-\s*(.+?)\s*$/u);
      if (m !== null && m[1].replace(/^["']|["']$/gu, '') === authority) return true;
    }
  }
  return false;
}

// ── 收尾：可选地开 serve；再把还缺的步骤说清楚 ──────────────────────────

if (wantServe) {
  console.log(`\n执行 tailscale serve --bg ${LISTEN_PORT} …`);
  try {
    console.log(tailscale(['serve', '--bg', String(LISTEN_PORT)]).trim());
    const c = checks.find((x) => x.label === 'tailscale serve');
    if (c !== undefined) { c.ok = true; c.detail = `已由本脚本指向 ${LISTEN_PORT}`; }
  } catch (error) {
    console.log('失败：' + error.message);
    console.log('  · Windows 上这一步通常需要管理员权限，换个「以管理员身份运行」的终端再试。');
  }
}

const todo = [];
if (!checks.find((c) => c.label.startsWith('DSH 桌面端'))?.ok) todo.push('先启动 DSH 桌面端（它是被访问的对象）');
if (!checks.find((c) => c.label === 'tailscale serve')?.ok) {
  todo.push(`跑一次 tailscale serve --bg ${LISTEN_PORT}（或 node setup.mjs --serve）`);
}
if (!checks.find((c) => c.label === 'profile 信任白名单')?.ok) {
  const target = files[0] ?? path.join(PROFILES_DIR, '<你的 profile>', 'cordis.patch.yml');
  todo.push(
    '把域名加进 DSH profile 的信任白名单（否则手机打开是 403）：\n' +
      `      文件：${target}\n` +
      '      在 web-runtime 条目下加（注意它和已有键同级、用 2 空格缩进）：\n' +
      '        trustedHosts:\n' +
      `          - ${AUTHORITY}\n` +
      '      ⚠ patch 是整段替换 config，所以要连同 openBrowser / printUrl / surfaceContext 等已有键一起保留。'
  );
}
if (!proxy.ok) todo.push('跑 start-proxy（或 node proxy.mjs）把代理启动起来');

if (todo.length === 0) {
  console.log('\n全部就绪 ✓  手机打开：https://' + AUTHORITY + '/');
} else {
  console.log('\n还差这几步：');
  todo.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
}
console.log('');
