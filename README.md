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
    "auth": { "enabled": true, "sessionHours": 168, "maxAttempts": 5, "windowMs": 60000 },
    "upstreamTimeoutMs": 120000,
    "accessLog": true
}
```

| 字段                | 默认        | 说明                                                     |
| ------------------- | ----------- | -------------------------------------------------------- |
| `host`              | `127.0.0.1` | 监听地址；`0.0.0.0` 对外时配 TLS 与强密码                |
| `port`              | `8780`      | 监听端口，`0` 为随机端口                                 |
| `tls.certFile`      | 无          | 相对插件数据目录的 PEM 证书                              |
| `tls.keyFile`       | 无          | 相对插件数据目录的 PEM 私钥                              |
| `routes[].prefix`   | 必填        | 外部路径前缀，`/` 为兜底                                 |
| `routes[].target`   | 必填        | 上游地址，只接受 `http(s)://`                            |
| `routes[].stripPrefix` | `true`   | 转发前去掉前缀；`false` 时上游收到完整路径               |
| `routes[].public`   | `false`     | 免登录路由；登录状态下仍会带上用户头                     |
| `routes[].timeoutMs`| 全局值      | 该路由的上游空闲超时覆盖                                 |
| `auth.enabled`      | `true`      | 统一登录开关                                             |
| `auth.sessionHours` | `168`       | 会话有效期                                               |
| `auth.maxAttempts`  | `5`         | 窗口内允许的登录失败次数                                 |
| `auth.windowMs`     | `60000`     | 失败计数窗口                                             |
| `upstreamTimeoutMs` | `120000`    | 上游空闲超时，`0` 不限                                   |
| `accessLog`         | `true`      | 每条请求输出访问日志（方法/路径/状态/耗时/上游）         |

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

## 首页与诊断

- `GET /`：登录后显示已注册服务列表（路径、来源），可直接点进各入口；配置了 `/` 路由时走代理
- `GET /__gateway/health`：无需登录，返回 `{ status, auth }`
- `GET /__gateway/status`：登录后返回版本、运行时长、认证状态、全部路由与上游连通性（TCP 探测，3 秒缓存）

## 统一登录

- 首次访问任意受保护页面跳转 `/login`，设置管理密码（6–200 位）
- 密码哈希（scrypt）保存在插件数据目录的 `auth.json`；会话 token 只在内存，重启后需重新登录
- 登录失败按来源 IP 限流，超限返回 429
- `/login` 后的 `next` 参数只接受站内路径，拒绝开放重定向
- 修改密码：`/__gateway/password`（需登录），修改后所有旧会话失效
- 注销：`POST /logout`
- 健康检查：`GET /__gateway/health`（无需登录）

`/login`、`/logout`、`/__gateway/*` 是网关保留路径，不能作为路由前缀。

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
- 会话只存在内存，服务重启后需要重新登录
- 不做响应压缩、缓存与内容改写（上游自行处理）
- 上游来自静态配置或插件注册；消费者崩溃未注销时路由保留到重启（status 显示 down）
- WebSocket 只做字节流转发，不解析帧

## 开发

```bash
npm install
npm run typecheck
npm test              # 配置/鉴权单测 + 代理集成测试（真实 HTTP/HTTPS/WS）
npm run build:zip     # release/wellspring-gateway-<version>.zip
```

## 发布

```bash
# 改 package.json 的 version，提交后推同名 tag
git tag -a v0.2.1 -m "v0.2.1"
git push origin master refs/tags/v0.2.1
```

推 `v*` 标签触发 `release.yml`（zip + SHA256SUMS 挂 GitHub Release）与 `publish-npm.yml`
（Trusted Publishing / OIDC 发 npm，已发布版本自动跳过）。手动触发发布默认只做 dry-run 演练。
