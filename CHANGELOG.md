# 更新日志

## 1.1.1 — 2026-10-17

### 修复

- **手机能打开页面、但对话列表和所有数据全空**：1.1.0 只改写了 WebSocket 的 Host/Origin，
  普通 HTTP 请求仍原样透传域名 —— 而 DSH 0.2.1 对 `/api/*` 同样只认回环 Host，一律
  `403 forbidden`（同一个域名取首页 HTML 却是 200，所以症状是「界面壳在、数据全空」）。
  现在**所有**请求（不只 `upgrade`）都把 Host/Origin 改写成回环、cookie 重签成回环 authority，
  并剥掉上游的 `dsh-auth-*` 响应 cookie、只发域名这一份。
- `check.mjs` 新增 `POST /api/session/list` 探针 —— 只看首页 200 会漏掉这个故障。

## 1.1.0 — 2026-10-17

### 修复

- **DSH 0.2.1 起端口由系统分配**：代理不再写死 `19387`。启动时用 `GetExtendedTcpTable` 反查
  `DeepSeek Harness.exe` 的监听端口，之后每 5 分钟复查；某次请求连不上时**立刻**补探一次，
  换端口后下一个请求自动跟上。`DSH_TARGET_PORT` 可显式接管。
- **手机端"页面能开、对话不通"**：DSH 的 WebSocket（`/api/remote.mux`）只认「回环 Host +
  回环 Origin + authority 为回环的 cookie」，域名 Host/Origin 即使已进 `trustedHosts` 也一律 403。
  代理现在在 `upgrade` 时把三者统一改写成回环（来源 Host 已在上一步校验，改写是安全的），
  实测拿到 `101 Switching Protocols`。

### 其它

- `check.mjs` 输出标注端口来源（自动探测 / `DSH_TARGET_PORT`）。
- README 补「端口自动探测」一节、WebSocket 限制说明；排错表新增 **502** 与「对话不通」两行。
