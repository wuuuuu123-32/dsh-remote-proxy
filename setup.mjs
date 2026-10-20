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

// ── 7. DSH profile 的信任白名单（1.1.1 起非必需，只作信息项） ───────────────
// 代理会把转发给 DSH 的 Host 头改写成 127.0.0.1:<端口>，DSH 看到的是回环访问，
// 因此不再需要把 ts.net 域名加进 trustedHosts —— 2026-10-20 在 0.2.1-rc.2 上实测不加也返回 200。
// 以前这项判定为 ✗ 是误报（还会让人去改 cordis.patch.yml，而 0.2.1 下那条 web-runtime 覆盖会让 webRuntime 起不来）。
const { hits, files } = checkTrustedHosts(AUTHORITY);
record(
  'profile 信任白名单',
  true,
  hits.length > 0
    ? `${hits.map((h) => h.profile).join(', ')} 已包含该域名`
    : `不需要（代理已把 Host 改写为回环；扫了 ${files.length} 个 profile）`
);

// ── 8. Tailscale 控制平面连通性 ────────────────────────────────────────
// 为什么单独查这一项：上面 7 项全 ✓ 也可能连不上手机。2026-10-16 实测遇到过 ——
// 服务 RUNNING、本地 3080/19387 全通、serve 与白名单都对，但手机端显示本机 offline。
// 根因是所在网络只放行了控制平面的某一个 IP，tailscaled 挑中别的 IP 就永远建不上连接，
// 而它只在 tailscale status --json 的 Health 里说这件事，不查这项就完全看不出来。
const control = await checkControlPlane();
record('Tailscale 控制平面', control.ok, control.detail);

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

/**
 * 控制平面检查分两层：
 *   ① tailscale 自报的 Health —— 连不上协调服务器时它会明说
 *   ② controlplane.tailscale.com 解析出几个 IPv4
 * 第 ② 层是有意保留的冗余判据：钉过 hosts 的机器这里应该只有 1 个 IP，
 * 一旦又冒出多个，说明 hosts 被覆盖/清掉了，接下来会不会断全看 tailscaled 抽签。
 */
async function checkControlPlane() {
  let state;
  try {
    state = JSON.parse(tailscale(['status', '--json']));
  } catch (error) {
    return { ok: false, detail: '读不到 tailscale 状态：' + String(error.message).split('\n')[0] };
  }

  let ips;
  try {
    const { lookup } = await import('node:dns/promises');
    ips = (await lookup('controlplane.tailscale.com', { all: true })).filter((r) => r.family === 4);
  } catch {
    return { ok: false, detail: 'controlplane.tailscale.com 解析失败（DNS 不通？）' };
  }
  const count = `控制平面解析到 ${ips.length} 个 IP`;

  const health = Array.isArray(state.Health) ? state.Health : [];
  if (health.some((h) => /coordination server/i.test(String(h)))) {
    return { ok: false, detail: `连不上协调服务器 → 手机端会显示本机 offline（${count}）` };
  }
  if (state.Self?.Online === false) {
    return { ok: false, detail: `节点是 offline（${count}）` };
  }
  return {
    ok: true,
    detail: ips.length === 1 ? `已连接，IP 已钉死（${ips[0].address}）` : `已连接，但 ${count}（未钉 hosts，断线后可能抽不中）`
  };
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
if (!proxy.ok) todo.push('跑 start-proxy（或 node proxy.mjs）把代理启动起来');
if (!checks.find((c) => c.label === 'Tailscale 控制平面')?.ok) {
  todo.push(
    'Tailscale 连不上协调服务器 —— 手机端会显示本机 offline，而在电脑上怎么测都正常：\n' +
      '      常见原因是所在网络只放行了控制平面的部分 IP，先换个网络试；\n' +
      '      固定网络下可以把能通的那个 IP 钉进 hosts（域名 controlplane.tailscale.com），\n' +
      '      再 ipconfig /flushdns 并重启 Tailscale 服务。'
  );
}

if (todo.length === 0) {
  console.log('\n全部就绪 ✓  手机打开：https://' + AUTHORITY + '/');
} else {
  console.log('\n还差这几步：');
  todo.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
}
console.log('');
