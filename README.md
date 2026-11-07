# @xyit-team/wellspring-gateway

Wellspring 网关插件：把所有插件服务收敛到一个对外入口——单端口、路径路由、TLS、统一登录与访问日志。

## 架构

```text
浏览器 / 客户端
      │  单一外部端口（默认 127.0.0.1:8780）
      ▼
wellspring-gateway  ──路由/鉴权/TLS──▶  127.0.0.1:8787   wellspring-web（hostApi.http 直连）
                     ─────────────────▶  127.0.0.1:8788   wellspring-code
```

- 网关是平台里唯一对外监听的插件，`sandbox.network: true`，自己持有端口
- 消费者插件仍用宿主原语 `hostApi.http.createServer` 监听 loopback，不经过事件总线转发
- 登录在网关完成，通过 `x-wellspring-user` 头传给上游；客户端伪造的同名头会被丢弃
- 上游只应监听 loopback，并且只在网关后面使用这些信任头

## 安装与加载

```bash
wellspring plugin install npm:@xyit-team/wellspring-gateway
# 或
wellspring plugin install github:xyit-team/wellspring-gateway

# 本地开发
wellspring plugin link "$PWD"
wellspring start
```

需要宿主 >= 1.7.6：`sandbox.network: true` 在 Node permission model 层放行 `--allow-net` 从这个版本开始。

配置文件：`<configDir>/plugins/wellspring-gateway.json`（不存在时全部用默认值）。

## 配置

```json
{
    "host": "127.0.0.1",
    "port": 8780,
    "tls": { "certFile": "cert.pem", "keyFile": "key.pem" },
    "routes": [
        { "prefix": "/web", "target": "http://127.0.0.1:8787" },
        { "prefix": "/code", "target": "http://127.0.0.1:8788", "stripPrefix": false },
        { "prefix": "/healthz", "target": "http://127.0.0.1:8787", "public": true, "timeoutMs": 5000 }
    ],
    "auth": {
        "enabled": true,
        "sessionHours": 168,
        "maxAttempts": 5,
        "windowMs": 60000
    },
    "upstreamTimeoutMs": 120000,
    "accessLog": true
}
```

| 字段                   | 默认        | 说明                                                     |
| ---------------------- | ----------- | -------------------------------------------------------- |
| `host`                 | `127.0.0.1` | 监听地址；`0.0.0.0` 对外时配 TLS 与强密码                |
| `port`                 | `8780`      | 监听端口，`0` 为随机端口                                 |
| `tls.certFile`         | 无          | 相对插件数据目录的 PEM 证书                              |
| `tls.keyFile`          | 无          | 相对插件数据目录的 PEM 私钥                              |
| `routes[].prefix`      | 必填        | 外部路径前缀，`/` 为兜底                                 |
| `routes[].target`      | 必填        | 上游地址，只接受 `http(s)://`                            |
| `routes[].stripPrefix` | `true`      | 转发前去掉前缀；`false` 时上游收到完整路径               |
| `routes[].public`      | `false`     | 免登录路由；登录状态下仍会带上用户头                     |
| `routes[].timeoutMs`   | 全局值      | 该路由的上游空闲超时覆盖                                 |
| `auth.enabled`         | `true`      | 统一登录开关                                             |
| `auth.sessionHours`    | `168`       | 会话有效期                                               |
| `auth.maxAttempts`     | `5`         | 窗口内允许的登录失败次数                                 |
| `auth.windowMs`        | `60000`     | 失败计数窗口                                             |
| `upstreamTimeoutMs`    | `120000`    | 上游空闲超时，`0` 不限                                   |
| `accessLog`            | `true`      | 每条请求输出访问日志（方法/路径/状态/耗时/上游）         |

路由按前缀最长匹配，按段边界比较：`/web` 匹配 `/web/x`，不匹配 `/web2`。多个路由命中时取最长前缀。

TLS 证书文件放在插件数据目录：`<dataDir>/plugin-data/wellspring-gateway/`。

## 插件运行时注册上游

消费者插件启动时把 loopback 地址注册给网关，不用改配置文件：

```ts
import { EventEntity, eventBus, onShutdown } from "wellspring/api/host/index.ts"

// setup(): deps: ["wellspring-gateway"]，清单里 hostApi 至少要有 http 与 event
let handle = null
onShutdown(async () => {
    eventBus.publish("wellspring-gateway:upstream:unregister", EventEntity.create({ name: "wellspring-web" }))
    await handle?.close()
})

export function setup() {
    return {
        deps: ["wellspring-gateway"],
        init: async (api) => {
            handle = await api.http.createServer({ host: "127.0.0.1", port: 8787 }, handler)
            eventBus.publish(
                "wellspring-gateway:upstream:register",
                EventEntity.create({
                    name: "wellspring-web",
                    prefix: "/web",
                    target: `http://${handle.host}:${handle.port}`,
                }),
            )
        },
    }
}
```

- 频道：`wellspring-gateway:upstream:register` / `wellspring-gateway:upstream:unregister`；
  网关每次变化广播 `wellspring-gateway:upstreams` 列表
- 同名注册覆盖上一条；前缀与静态配置或其它插件冲突时注册失败（网关日志 warning + status 里能看到）
- 消费者在 `deps` 里声明 `wellspring-gateway`，保证网关先初始化、事件不会丢
- 消费者崩溃没来得及注销时路由保留到下次重启，`/__gateway/status` 会显示 `upstream: down`

## 页面与诊断

- `GET /`：未登录跳 `/login`；登录后显示账户页（修改密码、运行状态、注销），不再列出已注册服务；配置了 `/` 路由时走代理
- `GET /__gateway/health`：无需登录，返回 `{ status, auth }`
- `GET /__gateway/status`：登录后返回版本、运行时长、认证状态、`sso`（`enabled`、`cookieName`、`loginPath`、`verifyPath`、`sessionsFile`）、全部路由与上游连通性（TCP 探测，3 秒缓存）

## 统一登录

- 首次访问任意受保护页面跳转 `/login`，设置管理密码（6–200 位）
- 密码哈希（scrypt）保存在插件数据目录的 `auth.json`；会话 token 只在内存，重启后需重新登录
- 登录失败按来源 IP 限流，超限返回 429
- 登录回跳参数：`redirect`（推荐）与 `next`（兼容）都支持；值可以是站内路径、`host[:port][/path]` 形式的本机地址，或同主机（任意端口）的绝对地址
- `redirect` / `next` 只接受同主机地址与本机地址（loopback、10/8、172.16/12、192.168/16、169.254/16、IPv6 ::1、ULA、链路本地）；公网地址与陌生主机一律回退 `/`
- 回跳协议必须与当前请求一致：https 网关下 bare 地址（默认 http）与 http 目标回退 `/`
- 其他端口的服务登录回跳格式：`http://127.0.0.1:8780/login?redirect=127.0.0.1%3A8787%2Fpath`，登录后 302 到 `http://127.0.0.1:8787/path`
- 修改密码：`/__gateway/password`（需登录），修改后所有旧会话失效
- 注销：`GET` / `POST /logout`
- 健康检查：`GET /__gateway/health`（无需登录）

`/login`、`/logout`、`/__gateway/auth/verify`、`/__gateway/password`、`/__gateway/health`、`/__gateway/status` 是网关保留路径：这些精确路径由网关优先处理，不会转发到上游；不要把它们配置成路由前缀（子路径仍会被代理，行为容易混淆）。

## 跨端口单点登录（SSO）

网关同时是统一身份提供方：其他插件端口复用网关会话，不再各自维护登录。思路与 accounts.google.com 类似——服务把未登录的浏览器 302 到网关登录页并带回自己的原始地址，登录后网关 302 回原地址。

### 原理

- 会话 cookie `wellspring_session` 是 host-only：`Set-Cookie` 不带 `Domain`，浏览器对同一主机（如 `127.0.0.1`）的任意端口都会带上它。属性为 `Path=/; HttpOnly; SameSite=Lax; Max-Age=<会话秒数>`，TLS 时另加 `Secure`
- 其他端口的服务自行校验这个 cookie：有效就直接服务；未登录就 302 到 `http://127.0.0.1:<网关端口>/login?redirect=<自己的地址>`（地址形如 `127.0.0.1:8787/path`，也可为 `192.168.31.138:8787` 这类本机网卡地址）。网关登录后 302 回该地址，cookie 已经在同一主机上，其他端口自动认证
- 已登录时访问 `/login?redirect=` 直接回跳，不再显示登录页
- 主机名必须一致：`127.0.0.1` 与 `localhost` 是两个不同主机，cookie 不互通
- 协议必须一致：TLS 时 cookie 带 `Secure`，只发给 https 端口；其他端口要与网关同为 http 或同为 https
- 网关无法拦截直连其他端口的请求：其他端口的服务必须自己接入校验，未登录时自己发起跳转

```text
浏览器
  │ ① GET http://127.0.0.1:8787/page
  ▼
其他端口服务（127.0.0.1:8787）
  │ 校验 wellspring_session：无效
  │ ② 302 Location: http://127.0.0.1:8780/login?redirect=<URL 编码的 127.0.0.1:8787/page>
  ▼
浏览器
  │ ③ GET http://127.0.0.1:8780/login?redirect=...
  ▼
网关（127.0.0.1:8780）
  │ ④ 登录成功：Set-Cookie: wellspring_session=...; Path=/; HttpOnly; SameSite=Lax（不带 Domain）
  │ ⑤ 302 Location: http://127.0.0.1:8787/page
  ▼
浏览器
  │ ⑥ GET http://127.0.0.1:8787/page + Cookie: wellspring_session=...
  ▼
其他端口服务
  │ 校验通过 → 200
```

② 的 `redirect` 是 URL 编码后的原始地址；网关回跳前校验它只指向同主机任意端口或本机地址，其它目标回退 `/`。登录地址的主机名沿用浏览器当前使用的主机名（换 `192.168.31.138` 访问 8787 时跳 `192.168.31.138:8780` 登录，网关需要监听该地址）。

### 两种校验方式

| 方式          | 校验依据                                            | 依赖                                                                          | 适用                                                   |
| ---           | ---                                                 | ---                                                                           | ---                                                    |
| 本地会话快照  | 读 `sessions.json`，比对 token 的 sha256 与过期时间 | `deps: ["wellspring-gateway"]`；`hostApi` 含 `fs`，经 `api.pluginData` 读文件 | wellspring 插件；不出网，`sandbox.network: false` 即可 |
| HTTP 校验接口 | 带会话 cookie 请求 `GET /__gateway/auth/verify`     | 能访问网关地址；sandbox 插件需 `sandbox.network: true`                        | 任意服务/语言                                          |

两种方式都只回答「会话是否有效」，不代理业务请求；其他端口的服务自己生成响应。

### 校验接口：/__gateway/auth/verify

| 项目             | 说明                                                                                                        |
| ---              | ---                                                                                                         |
| 路径             | `/__gateway/auth/verify`（网关保留路径，不能作为路由前缀）                                                  |
| 方法             | `GET`、`HEAD`；`OPTIONS` 为 CORS 预检；其他方法返回 `405` 与 `{"ok":false,"error":"method-not-allowed"}`    |
| 请求头           | `Cookie: wellspring_session=<token>`；浏览器跨端口 `fetch` 时另带 `Origin`                                  |
| 有效会话         | `200`，`{"ok":true,"auth":true,"user":"admin","expiresAt":1762473327000,"cookieName":"wellspring_session"}` |
| 无会话或会话无效 | `401`，`{"ok":false,"error":"unauthorized"}`                                                                |
| 鉴权关闭         | `200`，`{"ok":true,"auth":false,"user":null,"expiresAt":null,"cookieName":"wellspring_session"}`            |

`GET`/`HEAD` 响应带 `content-type: application/json; charset=utf-8` 与 `cache-control: no-store`；`405` 响应带 `Allow: GET, HEAD, OPTIONS`；来源允许时附带 CORS 头。该接口不要求登录，也不写入访问日志。

```bash
# 有效会话：200
curl -i http://127.0.0.1:8780/__gateway/auth/verify \
    -H "Cookie: wellspring_session=<token>"

# 无会话或会话无效：401
curl -i http://127.0.0.1:8780/__gateway/auth/verify
```

### 会话快照与发现文件

网关在插件数据目录 `<dataDir>/plugin-data/wellspring-gateway/` 写出两个文件：

- `sessions.json`：有效会话快照，只存 token 的 sha256，不存 token 原文；在启动、登录、修改密码、注销与定时清理过期会话时重写，写入失败会重试并尽快补写
- `sso.json`：网关地址与路径等发现信息，在启动时写入

`sessions.json`：

```json
{
    "version": 1,
    "updatedAt": "2026-11-08T05:55:27.000Z",
    "sessions": [
        {
            "hash": "<token 的 sha256 十六进制>",
            "expiresAt": 1762473327000
        }
    ]
}
```

| 字段                   | 说明                          |
| ---                    | ---                           |
| `version`              | 固定 `1`                      |
| `updatedAt`            | 写入时间，ISO 8601            |
| `sessions[].hash`      | 会话 token 的 sha256 十六进制 |
| `sessions[].expiresAt` | 会话过期时间，毫秒时间戳      |

`sso.json`：

```json
{
    "version": 1,
    "url": "http://127.0.0.1:8780",
    "authEnabled": true,
    "cookieName": "wellspring_session",
    "loginPath": "/login",
    "logoutPath": "/logout",
    "verifyPath": "/__gateway/auth/verify",
    "sessionsFile": "sessions.json",
    "updatedAt": "2026-11-08T05:55:27.000Z"
}
```

| 字段           | 说明                                                    |
| ---            | ---                                                     |
| `version`      | 固定 `1`                                                |
| `url`          | 网关对外地址                                            |
| `authEnabled`  | 与配置 `auth.enabled` 一致；为 `false` 时客户端直接放行 |
| `cookieName`   | 会话 cookie 名，固定 `wellspring_session`               |
| `loginPath`    | 登录页路径，固定 `/login`                               |
| `logoutPath`   | 注销路径，固定 `/logout`                                |
| `verifyPath`   | 校验接口路径，固定 `/__gateway/auth/verify`             |
| `sessionsFile` | 会话快照文件名，固定 `sessions.json`                    |
| `updatedAt`    | 写入时间，ISO 8601                                      |

消费者在 `deps` 里声明 `wellspring-gateway` 后，用 `api.pluginData("wellspring-gateway")` 取得数据目录的 `HostFileApi`，再用 `readJson` 读取这两个文件。

### CORS

浏览器从其他端口 `fetch` 校验接口属于跨源请求，网关按来源决定是否回 CORS 头：

- 同主机任意端口的 `Origin` 放行：协议与网关一致，且 `Origin` 的主机名等于当前请求 `Host` 的主机名（不比较端口）
- 放行时返回 `access-control-allow-origin: <Origin>`、`access-control-allow-credentials: true`、`vary: origin`
- 外站与跨协议来源不加 CORS 头；来源允许时 `401` 响应同样带 CORS 头，浏览器能读到校验失败结果
- 预检 `OPTIONS` 返回 `204`，放行 `GET, HEAD, OPTIONS`，`access-control-max-age: 600`；`access-control-allow-headers` 回显请求头（仅安全字符）或 `content-type`
- 浏览器 `fetch` 需要 `credentials: "include"` 才会发送 host-only cookie

### 注销

- `GET` / `POST /logout` 销毁会话并下发 `Set-Cookie: wellspring_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`（不带 `Domain`），同一主机的所有端口同时登出；本地快照写入失败时网关会重试并记 error，其他端口的失效可能短暂滞后（见「限制」）
- `Accept: application/json` 时返回 `200 {"ok":true}`，否则 302 到 `/login`
- 其他端口的服务若配置了 `cacheTtlMs > 0`，在自己处理登出后调用客户端的 `reset()` 清缓存；默认不缓存无需处理

### 接入示例

`src/sso-client.ts` 只依赖 `node:crypto`，可以整份复制到其他插件。下面的 wellspring 插件监听 `127.0.0.1:8787`，用本地会话快照校验：

```ts
import type { PluginApi } from "wellspring/api/host/index.ts"

import { acceptsHtml, createSsoClient, readSsoDiscovery } from "./sso-client.ts"

export function setup() {
    return {
        id: "my-web",
        name: "My Web",
        version: "0.1.0",
        status: "ok" as const,
        // 宿主先启动网关；依赖关系同时允许 api.pluginData 读取网关的数据目录
        deps: ["wellspring-gateway"],
        init: async (api: PluginApi) => {
            const data = await api.pluginData("wellspring-gateway")
            const discovery = await readSsoDiscovery(data)
            if (discovery === null) {
                api.logger.warn({}, "未找到网关 SSO 发现文件，跳过会话校验")
                return
            }
            // 本地模式：每次 verify 读一次快照，不出网
            const sso = createSsoClient({
                gatewayUrl: discovery.url,
                authEnabled: discovery.authEnabled,
                sessions: async () => await data?.readJson(discovery.sessionsFile),
            })
            await api.http.createServer({ host: "127.0.0.1", port: 8787 }, async (request) => {
                const result = await sso.verify(request.headers)
                if (!result.ok) {
                    const host = request.headers["host"] ?? "127.0.0.1:8787"
                    /* 回跳地址用 host[:port]/path，网关登录后补全协议并跳回 */
                    const current = `${host}${request.url}`
                    // handler 返回 { status, headers, body }，助手结果可以直接返回
                    return acceptsHtml(request.headers)
                        ? sso.redirectToLogin(current)
                        : sso.unauthorized()
                }
                return {
                    status: 200,
                    headers: { "content-type": "text/html; charset=utf-8" },
                    body: `<h1>${result.user ?? "anonymous"}</h1>`,
                }
            })
        },
    }
}
```

- `verify(headers)` 返回 `{ ok: true, user, expiresAt }` 或 `{ ok: false, reason }`，`reason` 为 `missing`（无 cookie）、`invalid`（会话无效）或 `unreachable`（本地快照读不到 / 网关不可达）；三者都按未登录处理
- `authEnabled: false` 时 `verify` 直接返回 `{ ok: true, user: null, expiresAt: null }`，不校验 cookie
- 本地快照模式固定返回 `user: "admin"`（网关单用户）；默认每次校验都读文件，`cacheTtlMs > 0` 才缓存
- HTTP 模式不传 `sessions`，`verify` 改为请求网关校验接口；默认超时 3000 毫秒，网关不可达按未登录处理
- `acceptsHtml(headers)` 在 `Accept` 含 `text/html` 或 `*/*` 时返回 `true`，用来区分页面请求（跳登录）与显式 API 请求（401 JSON）
- `readSsoDiscovery` 在文件缺失、格式不合法或无读取权限时返回 `null`
- `loginUrl(returnUrl?)` 生成 `<网关>/login?redirect=<编码后的回跳地址>`；回跳地址用 `host[:port][/path]` 或绝对地址
- 浏览器用局域网地址访问其他端口时，登录地址的主机名应换成请求 Host 的主机名（`wellspring-web` 的 `src/session.ts` 是完整实现）
- 客户端还提供 `sessionToken(headers)`、`loginUrl(returnUrl?)`、`reset()`；模块另外导出 `sessionTokenOf`、`sha256Hex`、`lookupSessionInSnapshot`、`acceptsHtml`，便于自定义接入
- `createSsoClient` 选项：`gatewayUrl`（必填）、`authEnabled`、`cookieName`、`loginPath`、`verifyPath`、`sessions`、`cacheTtlMs`、`timeoutMs`、`fetch`；返回对象含 `verify`、`sessionToken`、`loginUrl`、`redirectToLogin`、`unauthorized`、`reset` 与 `gatewayUrl`、`cookieName`、`authEnabled`

`package.json` 的 sandbox 声明：本地模式不需要出网。

```json
{
    "wellspring": {
        "sandbox": {
            "network": false,
            "hostApi": ["http", "fs"]
        }
    }
}
```

- `hostApi` 至少要有 `http`（监听端口）与 `fs`（`api.pluginData` 读取网关数据目录）；若还要注册上游、订阅事件，再补 `event`
- HTTP 校验模式把 `network` 改为 `true`；不用 `api.pluginData`、直接写死网关地址时可以去掉 `fs`

## 转发约定

网关对每个上游请求：

- 丢弃客户端传入的 `x-wellspring-*`、`x-forwarded-*` 头，重新生成
- `x-wellspring-user: admin`（登录后）、`x-wellspring-gateway: 1`
- `x-forwarded-for` / `x-forwarded-proto` / `x-forwarded-host` / `x-forwarded-prefix`
- `x-request-id`：网关生成或沿用客户端传来的合法值，访问日志与上游都能看到；响应头回同一个值
- 去掉网关自己的会话 cookie，其它 cookie 原样转发
- 请求体与响应体流式透传，不设体积上限（网关不做缓冲）
- 支持 WebSocket 升级转发（需要登录）

上游如需生成绝对 URL / 重定向，按 `x-forwarded-host` + `x-forwarded-prefix` 拼接。

## 限制

- 单用户、单密码；没有多用户与权限模型
- 会话只存在内存，服务重启后需要重新登录；网关启动时清空 `sessions.json` 快照
- 不做响应压缩、缓存与内容改写（上游自行处理）
- 上游来自静态配置或插件注册；消费者崩溃未注销时路由保留到重启（status 显示 down）
- WebSocket 只做字节流转发，不解析帧
- 跨端口 SSO 只复用网关会话：其他端口的服务必须自己接入校验并自己发起登录跳转，网关无法拦截直连这些端口的请求
- 登录回跳允许本机与局域网地址：构造 `redirect` 链接可把已登录用户带向局域网内其它主机页面（host-only cookie 不随跳转外泄，风险为钓鱼/误导），`redirect` 只应来自受信服务
- TLS 网关下直连 http 端口无法复用会话：`Secure` cookie 不发给 http，跨协议回跳会被拒绝
- 跨端口会话要求主机名与协议一致：`127.0.0.1` 与 `localhost` 不互通；TLS 的 `Secure` cookie 不会发给 http 端口
- 反向代理必须保留浏览器原始 `Host`：网关用 `Host` 判断回跳目标是否同源，并校验登录 `POST` 的 `Origin`；改写 `Host` 会让登录返回 403
- 本地快照是近实时镜像：快照在启动、登录、注销、改密与定时清理时重写，写入失败会重试并尽快补写；磁盘持续故障时其他端口的会话状态可能滞后。要求登出/改密立即全端口生效时用 HTTP 校验模式
- 本地快照模式在网关停止期间仍会按最后一次成功快照放行（离线设计）
- 直连端口的服务不要信任客户端传来的 `x-wellspring-user` 头（浏览器可以伪造），以 cookie 校验结果为准
- 安全边界：host-only cookie 会发给同一主机上任意端口的本地 HTTP 服务（SSO 机制本身）；同一用户的本机进程可以读取或重放 cookie，也能直接访问这些端口。服务只应监听 loopback，不要把端口暴露到本机之外；校验接口不要求登录，任意本机来源都能探测会话是否有效（只返回是否有效、用户与过期时间）

## 开发

```bash
npm install
npm run typecheck
npm test              # 配置/鉴权/SSO 单测 + 代理与双端口 SSO 集成测试（真实 HTTP/HTTPS/WS）
npm run build:zip     # release/wellspring-gateway-<version>.zip
```

## 发布

```bash
# 改 package.json 的 version，提交后推同名 tag
git tag -a v0.5.0 -m "v0.5.0"
git push origin master refs/tags/v0.5.0
```

推 `v*` 标签触发 `release.yml`（zip + SHA256SUMS 挂 GitHub Release）与 `publish-npm.yml`
（Trusted Publishing / OIDC 发 npm，已发布版本自动跳过）。手动触发发布默认只做 dry-run 演练。
