import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { request as httpsRequest } from "node:https"
import { connect as netConnect, type AddressInfo, type Socket } from "node:net"
import type { Duplex } from "node:stream"
import { join } from "node:path"
import { after, before, test } from "node:test"

import { AuthStore } from "../src/auth.ts"
import { parseGatewayConfig, type RouteConfig } from "../src/config.ts"
import { createGateway, type GatewayHandle } from "../src/server.ts"

const silentLogger = {
    info(): void {},
    warn(): void {},
    error(): void {},
}

interface MemoryStorage {
    readonly files: Map<string, string>
    readText(path: string): Promise<string | null>
    writeText(path: string, text: string): Promise<void>
}

function memoryStorage(initial: Record<string, string> = {}): MemoryStorage {
    const files = new Map<string, string>(Object.entries(initial))
    return {
        files,
        readText: async (path) => files.get(path) ?? null,
        writeText: async (path, text) => {
            files.set(path, text)
        },
    }
}

interface RecordedRequest {
    readonly method: string
    readonly url: string
    readonly headers: IncomingMessage["headers"]
    readonly body: string
}

interface Upstream {
    readonly url: string
    readonly port: number
    readonly requests: RecordedRequest[]
    close(): Promise<void>
}

function listen(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject)
            resolve()
        })
    })
}

function closeServer(server: Server): Promise<void> {
    return new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
    })
}

async function startUpstream(): Promise<Upstream> {
    const requests: RecordedRequest[] = []
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const chunks: Buffer[] = []
        req.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
        req.on("end", () => {
            const url = req.url ?? "/"
            const body = Buffer.concat(chunks).toString("utf8")
            requests.push({ method: req.method ?? "GET", url, headers: req.headers, body })
            if (url.startsWith("/json")) {
                res.writeHead(200, { "content-type": "application/json" })
                res.end(
                    JSON.stringify({
                        path: url,
                        user: req.headers["x-wellspring-user"] ?? null,
                        gateway: req.headers["x-wellspring-gateway"] ?? null,
                        prefix: req.headers["x-forwarded-prefix"] ?? null,
                    }),
                )
                return
            }
            if (url.startsWith("/echo")) {
                res.writeHead(200, { "content-type": "text/plain" })
                res.end(body)
                return
            }
            if (url.startsWith("/sse")) {
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
                res.write("data: a\n\n")
                setTimeout(() => {
                    res.write("data: b\n\n")
                    res.end()
                }, 20)
                return
            }
            if (url.startsWith("/fail")) {
                res.writeHead(500, { "content-type": "text/plain" })
                res.end("boom")
                return
            }
            res.writeHead(200, { "content-type": "text/plain" })
            res.end(`ok ${url}`)
        })
    })
    const upgraded = new Set<Duplex>()
    server.on("upgrade", (_req, socket) => {
        upgraded.add(socket)
        socket.on("close", () => upgraded.delete(socket))
        socket.write("HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\n")
        socket.on("data", (chunk) => socket.write(`echo:${chunk.toString()}`))
    })
    await listen(server)
    const address = server.address() as AddressInfo
    return {
        url: `http://127.0.0.1:${address.port}`,
        port: address.port,
        requests,
        close: () => {
            for (const socket of upgraded) {
                socket.destroy()
            }
            return closeServer(server)
        },
    }
}

interface GatewayFixture {
    readonly gateway: GatewayHandle
    readonly auth: AuthStore
    readonly storage: MemoryStorage
    close(): Promise<void>
}

async function startGateway(
    routes: RouteConfig[],
    overrides: Record<string, unknown> = {},
    storage = memoryStorage(),
): Promise<GatewayFixture> {
    const auth = new AuthStore({
        storage,
        sessionHours: 1,
        maxAttempts: 3,
        windowMs: 60_000,
    })
    await auth.load()
    const { config } = parseGatewayConfig({
        host: "127.0.0.1",
        port: 0,
        accessLog: false,
        auth: { enabled: true },
        routes,
        ...overrides,
    })
    const gateway = createGateway({
        config,
        auth,
        logger: silentLogger,
        readText: (path) => storage.readText(path),
    })
    await gateway.start()
    return { gateway, auth, storage, close: () => gateway.close() }
}

function cookieOf(response: Response): string {
    const setCookies = response.headers.getSetCookie()
    assert.ok(setCookies.length > 0, "缺少 Set-Cookie")
    const cookie = (setCookies[0] ?? "").split(";")[0] ?? ""
    assert.ok(cookie.startsWith("wellspring_session="), cookie)
    return cookie
}

function postForm(
    url: string,
    fields: Record<string, string>,
    cookie?: string,
): Promise<Response> {
    return fetch(url, {
        method: "POST",
        redirect: "manual",
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            ...(cookie === undefined ? {} : { cookie }),
        },
        body: new URLSearchParams(fields),
    })
}

async function login(gateway: GatewayHandle, password = "secret123"): Promise<string> {
    const response = await postForm(`${gateway.url}/login`, {
        password,
        confirm: password,
        next: "/",
    })
    assert.equal(response.status, 302)
    return cookieOf(response)
}

let upstream: Upstream
let gateway: GatewayFixture

before(async () => {
    upstream = await startUpstream()
    gateway = await startGateway([
        { prefix: "/web", target: upstream.url, stripPrefix: true },
        { prefix: "/raw", target: upstream.url, stripPrefix: false },
    ])
})

after(async () => {
    await gateway.close()
    await upstream.close()
})

test("健康检查不需要登录", async () => {
    const response = await fetch(`${gateway.gateway.url}/__gateway/health`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { status: "ok", auth: true })
})

test("未登录：HTML 请求重定向到登录页", async () => {
    const response = await fetch(`${gateway.gateway.url}/web/json`, {
        redirect: "manual",
        headers: { accept: "text/html" },
    })
    assert.equal(response.status, 302)
    assert.equal(response.headers.get("location"), "/login?next=%2Fweb%2Fjson")
})

test("未登录：接口请求返回 401 JSON", async () => {
    const response = await fetch(`${gateway.gateway.url}/web/json`, {
        redirect: "manual",
        headers: { accept: "application/json" },
    })
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: "unauthorized" })
})

test("首次访问设置密码并登录", async () => {
    const cookie = await login(gateway.gateway)
    assert.ok(gateway.storage.files.has("auth.json"))
    const response = await fetch(`${gateway.gateway.url}/web/json`, { headers: { cookie } })
    assert.equal(response.status, 200)
})

test("转发：去前缀、注入身份头、丢弃客户端伪造头", async () => {
    const cookie = await login(gateway.gateway)
    const response = await fetch(`${gateway.gateway.url}/web/json?a=1`, {
        headers: {
            cookie,
            "x-wellspring-user": "hacker",
            "x-wellspring-gateway": "spoof",
            "x-forwarded-prefix": "/fake",
        },
    })
    assert.equal(response.status, 200)
    const payload = (await response.json()) as Record<string, unknown>
    assert.equal(payload["path"], "/json?a=1")
    assert.equal(payload["user"], "admin")
    assert.equal(payload["gateway"], "1")
    assert.equal(payload["prefix"], "/web")

    const recorded = upstream.requests[upstream.requests.length - 1]
    assert.ok(recorded !== undefined)
    assert.equal(recorded.headers["x-wellspring-user"], "admin")
    assert.equal(recorded.headers["x-forwarded-prefix"], "/web")
})

test("转发：不删前缀的路由", async () => {
    const cookie = await login(gateway.gateway)
    const response = await fetch(`${gateway.gateway.url}/raw/json`, { headers: { cookie } })
    assert.equal(response.status, 200)
    const recorded = upstream.requests[upstream.requests.length - 1]
    assert.equal(recorded?.url, "/raw/json")
})

test("转发：请求体透传", async () => {
    const cookie = await login(gateway.gateway)
    const response = await fetch(`${gateway.gateway.url}/web/echo`, {
        method: "POST",
        headers: { cookie, "content-type": "text/plain" },
        body: "hello gateway",
    })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), "hello gateway")
    const recorded = upstream.requests[upstream.requests.length - 1]
    assert.equal(recorded?.body, "hello gateway")
})

test("转发：SSE 分片原样透传", async () => {
    const cookie = await login(gateway.gateway)
    const response = await fetch(`${gateway.gateway.url}/web/sse`, { headers: { cookie } })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), "data: a\n\ndata: b\n\n")
})

test("转发：上游错误状态原样返回", async () => {
    const cookie = await login(gateway.gateway)
    const response = await fetch(`${gateway.gateway.url}/web/fail`, { headers: { cookie } })
    assert.equal(response.status, 500)
    assert.equal(await response.text(), "boom")
})

test("未匹配路由返回 404", async () => {
    const cookie = await login(gateway.gateway)
    const response = await fetch(`${gateway.gateway.url}/unknown`, { headers: { cookie } })
    assert.equal(response.status, 404)
})

test("注销后会话失效", async () => {
    const cookie = await login(gateway.gateway)
    const logout = await postForm(`${gateway.gateway.url}/logout`, {}, cookie)
    assert.equal(logout.status, 302)
    const response = await fetch(`${gateway.gateway.url}/web/json`, {
        redirect: "manual",
        headers: { cookie, accept: "text/html" },
    })
    assert.equal(response.status, 302)
})

test("登录失败限流", async () => {
    const isolated = await startGateway([{ prefix: "/web", target: upstream.url, stripPrefix: true }])
    try {
        await login(isolated.gateway)
        let last = 0
        for (let index = 0; index < 3; index += 1) {
            const response = await postForm(`${isolated.gateway.url}/login`, { password: "wrong" })
            last = response.status
        }
        assert.equal(last, 429)
        const blocked = await postForm(`${isolated.gateway.url}/login`, { password: "secret123" })
        assert.equal(blocked.status, 429)
    } finally {
        await isolated.close()
    }
})

test("登录 next 参数拒绝开放重定向", async () => {
    const isolated = await startGateway([{ prefix: "/web", target: upstream.url, stripPrefix: true }])
    try {
        const response = await postForm(`${isolated.gateway.url}/login`, {
            password: "secret123",
            confirm: "secret123",
            next: "//evil.example/",
        })
        assert.equal(response.status, 302)
        assert.equal(response.headers.get("location"), "/")
    } finally {
        await isolated.close()
    }
})

test("修改密码后旧会话失效", async () => {
    const isolated = await startGateway([{ prefix: "/web", target: upstream.url, stripPrefix: true }])
    try {
        const oldCookie = await login(isolated.gateway)
        const changed = await postForm(
            `${isolated.gateway.url}/__gateway/password`,
            { current: "secret123", password: "newsecret", confirm: "newsecret" },
            oldCookie,
        )
        assert.equal(changed.status, 302)
        const newCookie = cookieOf(changed)

        const withOld = await fetch(`${isolated.gateway.url}/web/json`, {
            redirect: "manual",
            headers: { cookie: oldCookie, accept: "text/html" },
        })
        assert.equal(withOld.status, 302)
        const withNew = await fetch(`${isolated.gateway.url}/web/json`, {
            headers: { cookie: newCookie },
        })
        assert.equal(withNew.status, 200)
    } finally {
        await isolated.close()
    }
})

test("上游不可用返回 502", async () => {
    const closed = await startUpstream()
    const port = closed.port
    await closed.close()
    const isolated = await startGateway([
        { prefix: "/web", target: `http://127.0.0.1:${port}`, stripPrefix: true },
    ])
    try {
        await login(isolated.gateway)
        const cookie = cookieOf(
            await postForm(`${isolated.gateway.url}/login`, { password: "secret123" }),
        )
        const response = await fetch(`${isolated.gateway.url}/web/json`, { headers: { cookie } })
        assert.equal(response.status, 502)
    } finally {
        await isolated.close()
    }
})

test("鉴权关闭：直接转发且不注入用户", async () => {
    const isolated = await startGateway(
        [{ prefix: "/web", target: upstream.url, stripPrefix: true }],
        { auth: { enabled: false } },
    )
    try {
        const response = await fetch(`${isolated.gateway.url}/web/json`)
        assert.equal(response.status, 200)
        const payload = (await response.json()) as Record<string, unknown>
        assert.equal(payload["user"], null)
        assert.equal(payload["gateway"], "1")
    } finally {
        await isolated.close()
    }
})

test("WebSocket 升级转发", async () => {
    const cookie = await login(gateway.gateway)
    const port = gateway.gateway.port
    const result = await new Promise<string>((resolve, reject) => {
        const socket: Socket = netConnect(port, "127.0.0.1")
        const timer = setTimeout(() => {
            socket.destroy()
            reject(new Error("升级超时"))
        }, 5_000)
        let received = ""
        socket.on("connect", () => {
            socket.write(
                [
                    "GET /web/ws HTTP/1.1",
                    `host: 127.0.0.1:${port}`,
                    "connection: Upgrade",
                    "upgrade: websocket",
                    `cookie: ${cookie}`,
                    "",
                    "",
                ].join("\r\n"),
            )
        })
        socket.on("data", (chunk) => {
            received += chunk.toString()
            if (received.includes("101 Switching Protocols") && !received.includes("echo:")) {
                socket.write("hi")
                return
            }
            if (received.includes("echo:hi")) {
                clearTimeout(timer)
                socket.destroy()
                resolve(received)
            }
        })
        socket.on("error", (error) => {
            clearTimeout(timer)
            reject(error)
        })
    })
    assert.match(result, /101 Switching Protocols/)
    assert.match(result, /echo:hi/)
})

test("TLS 监听", async () => {
    const cert = await readFile(join(import.meta.dirname, "fixtures", "tls", "cert.pem"), "utf8")
    const key = await readFile(join(import.meta.dirname, "fixtures", "tls", "key.pem"), "utf8")
    const storage = memoryStorage({ "cert.pem": cert, "key.pem": key })
    const isolated = await startGateway(
        [],
        { tls: { certFile: "cert.pem", keyFile: "key.pem" } },
        storage,
    )
    try {
        const status = await new Promise<number>((resolve, reject) => {
            const request = httpsRequest(
                {
                    hostname: "127.0.0.1",
                    port: isolated.gateway.port,
                    path: "/__gateway/health",
                    rejectUnauthorized: false,
                },
                (response) => {
                    response.resume()
                    resolve(response.statusCode ?? 0)
                },
            )
            request.on("error", reject)
            request.end()
        })
        assert.equal(status, 200)
        assert.equal(isolated.gateway.secure, true)
    } finally {
        await isolated.close()
    }
})
