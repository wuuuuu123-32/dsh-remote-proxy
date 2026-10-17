# dsh-remote-proxy

> 用 Tailscale 把电脑上的 **DSH 桌面端** 安全地开放给手机 —— 免费、HTTPS、可装 PWA、**手机不用带 token**。

DSH（DeepSeek Harness）桌面端内置的 Web 服务只监听回环地址（0.2.0 及更早固定 `127.0.0.1:19387`，**0.2.1 起由系统分配、每次启动可能不同**），手机够不着。
Tailscale 能把请求从外面送进来，但还有两个拦路虎，这个小代理一次解决：

1. **403：DSH 的信任栅栏** —— 它检查 Host 头，默认只放行 `127.0.0.1` 和局域网 IP，`xxx.ts.net` 会被拒。
2. **无限 303：跨站导航丢掉 cookie** —— 从微信/短信点开链接属于跨站导航，浏览器不会带上
   `SameSite=Strict` 的登录 cookie，于是来回跳转直到 `ERR_TOO_MANY_REDIRECTS`。

## 原理

```
手机浏览器
  └─ https://<机器名>.<tailnet>.ts.net     ← Tailscale 自动签发 TLS 证书
       │  （加密隧道，只在你自己登录的设备之间）
       ▼
  电脑上的 Tailscale 客户端
       └─ tailscale serve → http://127.0.0.1:3080
                              │
                              ▼
                        proxy.mjs（本仓库）
                          · 转发前把 Host/Origin 换成回环，并换签回环 cookie
                          · 用 DSH 自己的密钥签一个登录 cookie 替手机带上
                          · 401 时换新 cookie 自己重取一次（浏览器侧零跳转 → 不可能循环）
                              │
                              ▼
                        DSH 桌面端 127.0.0.1:<DSH 端口>（自动探测）
```

**关键点：DSH 完全不用改监听地址**，仍然只听回环。是 Tailscale 在本地帮它做了 HTTPS 反代。

### 端口自动探测（0.2.1 起）

DSH 桌面端 0.2.0 及更早固定监听 `19387`；**0.2.1 起改为系统分配**，每次启动都可能换一个。
代理因此不再写死端口，而是：

1. 启动时用 `GetExtendedTcpTable` 反查「哪个进程是 `DeepSeek Harness.exe` 且处于 LISTENING」；
2. 之后每 5 分钟复查一次；某次请求连不上时**立刻**补探一次 —— 换端口后下一个请求自动跟上；
3. 只有设置 `DSH_TARGET_PORT` 时才完全跳过探测。

所以 DSH 升级、重启换端口，代理这边都不用改。

### 为什么每个请求都要改写成回环 Host

0.2.1 起，DSH 对**数据面**的栅栏比页面更严：`/api/*` 和 WebSocket 都
**只认「回环 Host + 回环 Origin + authority 为回环的 cookie」**。域名 Host/Origin 即使在
`trustedHosts` 里也一律 `403 forbidden`（body 只有 9 字节 `forbidden`），而**同一个域名去取
首页 HTML 却是 200** —— 这个不对称正是最坑的地方。

所以代理对所有请求（不只是 `upgrade`）都把这三样统一改写成回环：
`Host: 127.0.0.1:<DSH 端口>`、`Origin` 同步、cookie 换成回环 authority 签的那枚，
并把上游种的 `dsh-auth-*` 响应 cookie 剥掉、只发域名这一份。来源 Host 在上一步已经校验过，
改写不会放宽任何外部可达性。

> ❗别只改 WebSocket。只改它的话，表现是**手机能打开页面、侧栏也在，但对话列表和一切数据全空**
> （首页 HTML 200，所有 `/api` 请求 403）。1.0.0 是纯透传，症状是「对话发不出去一直转圈」；
> 1.1.0 修了 WebSocket 但没修 HTTP，症状变成「界面空壳」；1.1.1 才把两者一起修掉。

## 前置条件

- **DSH 桌面端**（本项目在 `0.2.0-rc.2` 上验证通过）
- **Tailscale**（个人版免费，最多 100 台设备）
- **Node.js 18+**

## 快速开始

### 1. 装 Tailscale（电脑 + 手机，登录同一个账号）

- 电脑：https://tailscale.com/download
- 手机：应用商店搜 **Tailscale**

**两边必须在同一个 tailnet（同一账号）**，否则互相看不见。

### 2. 开启 HTTPS 并启动 serve

```bash
tailscale serve --bg 3080
```

第一次跑会弹出同意页面引导你开启 HTTPS。成功后它会打印你的访问域名：

```
https://<机器名>.<tailnet>.ts.net
```

> Windows 上这一步通常需要**管理员权限**的终端。

### 3. 让 DSH 接受这个域名

编辑 DSH profile 的 `cordis.patch.yml`（通常在 `~/.dsh/profiles/<profile>/cordis.patch.yml`），
在 `web-runtime` 条目里加 `trustedHosts`：

```yaml
- id: web-runtime
  name: "@deepseek-ai/dsh-web-app"
  config:
    openBrowser: false
    printUrl: true
    surfaceContext: true
    trustedHosts:
      - <机器名>.<tailnet>.ts.net
```

> ⚠️ profile patch 是**整段替换** config，所以要连同已有的键一起保留，不能只写 `trustedHosts`。
> ⚠️ 改这个文件前先备份 —— 写坏了 DSH 会起不来。

**然后重启 DSH 桌面端。**

### 4. 启动代理

```bash
node setup.mjs      # 先自检，看还差哪一步
node proxy.mjs      # 启动代理
```

Windows 上双击 `start-proxy.cmd` 也行（要保持窗口开着）。

### 5. 手机打开

```
https://<机器名>.<tailnet>.ts.net/
```

**不需要 token** —— 代理会自动帮你登录，并种一个 30 天有效的 cookie。

想当 App 用：用浏览器菜单「添加到主屏幕」（iPhone 必须用 **Safari**，Chrome 不支持）。

## 验证

两个脚本，用途不同：

```bash
node setup.mjs    # 装机自检：8 项逐一检查，告诉你还差哪一步
node check.mjs    # 链路自检：实测手机入口是否真的通到桌面端
```

`setup.mjs` 的输出长这样：

```
DSH 远程访问自检
─────────────────────────────────────────────
  ✓ Tailscale 客户端    C:\Program Files\Tailscale\tailscale.exe
  ✓ 访问域名             <机器名>.<tailnet>.ts.net
  ✓ DSH 凭据文件         C:\Users\you\.dsh\.credentials.yaml
  ✓ DSH 桌面端 :63645   在监听（自动探测）
  ✓ 本代理 :3080        已在运行
  ✓ tailscale serve   已指向 3080
  ✓ profile 信任白名单   desktop 已包含该域名
  ✓ Tailscale 控制平面   已连接，IP 已钉死（192.200.0.109）
─────────────────────────────────────────────

全部就绪 ✓  手机打开：https://<机器名>.<tailnet>.ts.net/
```

`check.mjs` 会实测四条：新手机（无 cookie）、残留旧 cookie、本机直连、对话的实时通道（WSS）。
期望看到 `HTTP 200` + `set-cookie=有`，以及 `101 Switching Protocols`。

## 环境变量

全部有默认值，**通常一个都不用设**。

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_AUTHORITY` | 自动探测 | 访问域名。探测方式：`tailscale status --json` 的 `Self.DNSName` |
| `DSH_REMOTE_PORT` | `3080` | 代理监听端口（要和 `tailscale serve` 的目标一致） |
| `DSH_TARGET_PORT` | 自动探测 | DSH 桌面端 Web 端口。**不设则自动探测**（0.2.1 起由系统分配）；显式设置则完全接管、不再探测 |
| `DSH_HOME` | `~/.dsh` | DSH 数据目录 |
| `DSH_CREDENTIALS` | `<DSH_HOME>/.credentials.yaml` | 凭据文件路径 |

## 排错

| 症状 | 原因 / 解决 |
|---|---|
| 自检说「探测失败」 | Tailscale 没装或没登录。托盘图标右键 → Log in |
| 手机 / 电脑打开 **502** | 代理连不上 DSH：桌面端没启动，或端口探测失败。可 `netstat -ano \| findstr LISTENING` 看实际端口，必要时用 `DSH_TARGET_PORT` 显式指定 |
| 手机能打开页面、但对话一直转圈 | WebSocket 被 DSH 拒了。1.1.0 起代理会自动改写 Host/Origin；旧版请升级 |
| 手机能打开页面、但**对话列表和所有数据空白** | `/api/*` 被 DSH 拒了（403）。1.1.1 起普通请求也做回环改写；旧版请升级 |
| 手机打开 **403** | profile 没配 `trustedHosts`，或域名写错。改完要**重启 DSH** |
| 手机打开 **502** | 代理活着但 DSH 桌面端没开 |
| **证书错误** | HTTPS 没启用。跑一次不带 `--bg` 的 `tailscale serve` 走完同意流程 |
| 手机打不开页面 | 手机 Tailscale 没开，或没登同一账号 |
| **无限跳转 303** | 还有旧版代理在跑。结束掉旧 node 进程后重启 |
| 界面残缺（没输入框） | 浏览器缓存了旧前端壳。代理已对 HTML 加 `no-store`，硬刷新一次 |
| serve 重启后失效 | 重新跑 `tailscale serve --bg 3080` |
| **手机显示电脑「离线 / 断联」**，电脑上一切正常 | Tailscale 连不上协调服务器（见下节）。`node setup.mjs` 第 8 项会报红 |

## 手机显示电脑离线，电脑上却一切正常

**症状**：手机端 Tailscale 把电脑标成 offline，但在电脑上自检 8 项全绿、`tailscale serve status`
也正常、浏览器打开自己那个 `*.ts.net` 域名还是 200。

**原因**：`tailscale serve` 和 MagicDNS 走的是**本地回环**，压根不经过 Tailscale 的协调服务器；
而「手机能不能看到电脑在线」靠的正是协调服务器。有些校园网 / 企业网只放行了
`controlplane.tailscale.com` 的**部分 IP**，tailscaled 挑中其它 IP 就永远建不上连接，
云端于是把你标成 offline —— 本地一切正常，远端全断。

换个网络通常立刻恢复；但在固定网络（宿舍、公司）下它会**反复复发**：连接一断，
tailscaled 重新挑 IP，挑不中就又是几十分钟不通。

**判据**（`node setup.mjs` 第 8 项会自动查，也可以手动看）：

```bash
tailscale status --json     # Health 里出现 "Unable to connect to the Tailscale coordination server" 即是
```

**根治：把能通的那个 IP 钉死**。Windows 上编辑 `C:\Windows\System32\drivers\etc\hosts`（需管理员）：

```
# Tailscale controlplane: this network only allows one of its IPs (measured 2026-10-16)
192.200.0.109	controlplane.tailscale.com
```

```powershell
ipconfig /flushdns
Restart-Service Tailscale -Force
```

怎么知道该钉哪个：把 `controlplane.tailscale.com` 解析出来的 8 个 IPv4 逐个连一下 443 端口，
留下能通的那个。

> ⚠️ 这个 IP **不保证长期有效**（对方会调整）。自检第 8 项显示绿色即为当前有效；哪天变红，
> 重新测一遍再改 hosts。

> ⚠️ 验证 hosts 是否生效请用 `ping controlplane.tailscale.com` 或
> `[System.Net.Dns]::GetHostAddresses('controlplane.tailscale.com')`，
> **不要用 `Resolve-DnsName -DnsOnly`** —— 那个参数的字面意思就是绕过 hosts 只查 DNS，
> 返回一堆轮询 IP，看着像失效。

## 安全性

- **代理只监听 `127.0.0.1`**，不向局域网暴露任何端口。关掉 Tailscale 就完全够不着。
- **只对匹配域名的 Host 签 cookie**，其它 Host 一律不签，交给 DSH 自己的信任栅栏处理。
- **密钥不外传**：从本地凭据文件读，只用于本地签 cookie，不发往任何第三方。
- **数据路径只在你自己的设备之间**，不经过任何中继服务器（除 Tailscale 打洞失败时的官方 DERP 中继，端到端加密）。

> 隐私提醒：启用 Tailscale HTTPS 后，你的**机器名**和 tailnet 名会出现在公开的证书透明度（CT）账本里。
> 机器名含敏感信息的话，先去 https://console.tailscale.com/admin/machines 改名。

## 已知限制

- **依赖 DSH 的内部实现** —— cookie 签名格式（`v1.<payload>.<hmac>`）和凭据文件里
  `client-connection/browser-session` 的结构都不是公开 API，**DSH 升级后可能失效**。
- **只在 Windows + DSH 桌面端 `0.2.0-rc.2` 上实测过**。代码本身没有平台相关的依赖
  （macOS / Linux 的 tailscale 路径也都考虑了），但这两个平台**没有实测**。
- 手机上看到的是 **DSH 原生桌面布局**，会挤一些。这个工具只管网络，不管界面。

## 许可

MIT
