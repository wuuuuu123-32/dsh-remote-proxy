// check.mjs —— 远程访问自检：手机入口是否真的通到桌面端
//
// 用法：node check.mjs
//
// 判读（从下往上依次是链路的每一段）：
//   桌面端端口在监听            -> 链路最里面那一段通了（端口自动探测）
//   域名 / 无 cookie            -> HTTP 200 且下发 cookie = 代理自动登录正常（期望状态）
//   域名 / 带伪造旧 cookie      -> HTTP 200                    = 残留旧 cookie 会被代理换掉
//   本机 3080 / 无 cookie       -> HTTP 200                    = 代理本身活着
//   域名 WSS /api/remote.mux    -> 101                         = 对话的实时通道可用
//
//   502          = 代理在跑，但 DSH 桌面端没开
//   403          = DSH 的信任栅栏拒绝了该域名（profile 里没配 trustedHosts）
//   连接失败/超时 = Tailscale serve 或隧道有问题
//   303          = 还有旧版代理在跑（结束掉旧 node 进程后重跑）

import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { LISTEN_PORT, TARGET_PORT, TARGET_PORT_OVERRIDE, b64u, detectAuthority, loadSecret, probeTcp } from './config.mjs';

let AUTHORITY;
try {
  AUTHORITY = detectAuthority();
  loadSecret(); // 只验能不能读到，密钥本身下面用不到
} catch (error) {
  console.error('自检无法开始：\n' + error.message);
  process.exit(1);
}

const NAME = 'dsh-auth-' + b64u(crypto.createHash('sha256').update(AUTHORITY).digest());

function getHttps(cookieValue) {
  return new Promise((resolve) => {
    const headers = { Host: AUTHORITY };
    if (cookieValue !== undefined) headers.Cookie = cookieValue;
    const started = Date.now();
    const req = https.request({ host: AUTHORITY, port: 443, path: '/', method: 'GET', headers, servername: AUTHORITY }, (res) => {
      let bytes = 0;
      res.on('data', (c) => (bytes += c.length));
      res.on('end', () =>
        resolve(`HTTP ${res.statusCode}${res.headers.location ? ' location=' + res.headers.location : ''} bytes=${bytes} set-cookie=${res.headers['set-cookie'] ? '有' : '无'} ${Date.now() - started}ms`)
      );
    });
    req.on('error', (e) => resolve('失败 ' + (e.code ?? e.message)));
    req.setTimeout(15000, () => { req.destroy(); resolve('超时'); });
    req.end();
  });
}

function getLocal(cookieValue) {
  return new Promise((resolve) => {
    const headers = { Host: '127.0.0.1:' + LISTEN_PORT };
    if (cookieValue !== undefined) headers.Cookie = cookieValue;
    const req = http.request({ host: '127.0.0.1', port: LISTEN_PORT, path: '/', method: 'GET', headers }, (res) => {
      let bytes = 0;
      res.on('data', (c) => (bytes += c.length));
      res.on('end', () => resolve(`HTTP ${res.statusCode} bytes=${bytes} set-cookie=${res.headers['set-cookie'] ? '有' : '无'}`));
    });
    req.on('error', (e) => resolve('失败 ' + (e.code ?? e.message)));
    req.end();
  });
}

function wsProbe() {
  return new Promise((resolve) => {
    const sock = tls.connect({ host: AUTHORITY, port: 443, servername: AUTHORITY }, () => {
      const key = crypto.randomBytes(16).toString('base64');
      sock.write(
        `GET /api/remote.mux HTTP/1.1\r\nHost: ${AUTHORITY}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: https://${AUTHORITY}\r\n\r\n`
      );
    });
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n')) { resolve(buf.split('\r\n')[0]); sock.destroy(); }
    });
    sock.on('error', (e) => resolve('失败 ' + e.code));
    setTimeout(() => { resolve('超时 ' + JSON.stringify(buf.slice(0, 60))); sock.destroy(); }, 8000);
  });
}

const desktop = await probeTcp(TARGET_PORT);
console.log('目标：https://' + AUTHORITY + '/');
console.log(`  DSH 桌面端 127.0.0.1:${TARGET_PORT}${TARGET_PORT_OVERRIDE === undefined ? '（自动探测）' : '（DSH_TARGET_PORT）'}  -> ${desktop.ok ? '在监听' : '不通（' + desktop.detail + '）'}`);
console.log('  无 cookie（模拟新手机）       ->', await getHttps(undefined));
console.log('  带伪造的同名旧 cookie         ->', await getHttps(NAME + '=v1.bogus.bogus'));
console.log(`  本机 127.0.0.1:${LISTEN_PORT} 无 cookie ->`, await getLocal(undefined));
console.log('  WSS /api/remote.mux           ->', await wsProbe());
