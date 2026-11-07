import assert from "node:assert/strict"
import {
    createServer,
    request as httpRequest,
    type IncomingMessage,
    type ServerResponse,
} from "node:http"
import { type AddressInfo } from "node:net"
import { test } from "node:test"

import { AuthStore, SESSION_COOKIE, sessionTokenHash } from "../src/auth.ts"
import { parseGatewayConfig, type RouteConfig } from "../src/config.ts"
import { createGateway, type GatewayHandle } from "../src/server.ts"
import {
    SSO_DISCOVERY_FILE,
    SSO_LOGIN_PATH,
    SSO_SESSIONS_FILE,
    SSO_VERIFY_PATH,
    buildSsoDiscovery,
    corsHeaders,
    formatHostForUrl,
    normalizeHostName,
    originAllowed,
    preflightHeaders,
    isLocalAddress,
    redirectContextOf,
    requestProtocol,
    resolveRedirect,
    sessionSnapshotJson,
} from "../src/sso.ts"

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

interface GatewayFixture {
    readonly gateway: GatewayHandle
    readonly storage: MemoryStorage
    close(): Promise<void>
}

async function startGateway(
    routes: RouteConfig[] = [],
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
        writeText: (path, text) => storage.writeText(path, text),
    })
    await gateway.start()
    return { gateway, storage, close: () => gateway.close() }
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

function cookieOf(response: Response): string {
    const setCookies = response.headers.getSetCookie()
    assert.ok(setCookies.length > 0, "缺少 Set-Cookie")
    return (setCookies[0] ?? "").split(";")[0] ?? ""
}

function tokenOf(cookie: string): string {
    const index = cookie.indexOf("=")
    return index === -1 ? "" : cookie.slice(index + 1)
}

/** 首次访问：设置密码并登录，返回会话 cookie */
async function login(gateway: GatewayHandle, next = "/", password = "secret123"): Promise<string> {
    const response = await postForm(`${gateway.url}${SSO_LOGIN_PATH}`, {
        password,
        confirm: password,
        next,
    })
    assert.equal(response.status, 302, await response.text())
    return cookieOf(response)
}

function verifyUrl(gateway: GatewayHandle): string {
    return `${gateway.url}${SSO_VERIFY_PATH}`
}

function readSessions(storage: MemoryStorage): Array<{ hash: string; expiresAt: number }> {
    const text = storage.files.get(SSO_SESSIONS_FILE)
    assert.ok(text !== undefined, "缺少会话快照")
    const parsed = JSON.parse(text) as { sessions?: Array<{ hash: string; expiresAt: number }> }
    assert.ok(Array.isArray(parsed.sessions), "会话快照格式不合法")
    return parsed.sessions
}

interface RawResponse {
    readonly status: number
    readonly headers: IncomingMessage["headers"]
    readonly body: string
}

function rawGet(
    port: number,
    path: string,
    headers: Record<string, string>,
): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
        const request = httpRequest(
            { host: "127.0.0.1", port, path, method: "GET", headers },
            (response: IncomingMessage) => {
                const chunks: Buffer[] = []
                response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
                response.on("end", () => {
                    resolve({
                        status: response.statusCode ?? 0,
                        headers: response.headers,
                        body: Buffer.concat(chunks).toString("utf8"),
                    })
                })
            },
        )
        request.on("error", reject)
        request.end()
    })
}

/* ---------- 纯函数 ---------- */

test("normalizeHostName：主机名、端口、IPv6 与非法值", () => {
    assert.equal(normalizeHostName("127.0.0.1"), "127.0.0.1")
    assert.equal(normalizeHostName("127.0.0.1:8780"), "127.0.0.1")
    assert.equal(normalizeHostName("LOCALHOST:8787"), "localhost")
    assert.equal(normalizeHostName("[::1]:8780"), "[::1]")
    assert.equal(normalizeHostName("::1"), "[::1]")
    assert.equal(normalizeHostName(""), null)
    assert.equal(normalizeHostName("bad host"), null)
    assert.equal(normalizeHostName("http://127.0.0.1"), null)
    assert.equal(normalizeHostName("127.0.0.1/x"), null)
    assert.equal(normalizeHostName("user@127.0.0.1"), null)
})

test("redirectContextOf：协议与当前 Host", () => {
    assert.equal(requestProtocol(false), "http:")
    assert.equal(requestProtocol(true), "https:")
    const insecure = redirectContextOf("127.0.0.1:8780", false)
    assert.deepEqual(insecure, { protocol: "http:", hostname: "127.0.0.1" })
    const secure = redirectContextOf(undefined, true)
    assert.equal(secure.protocol, "https:")
    assert.equal(secure.hostname, null)
})

test("resolveRedirect：站内路径、本机地址与同主机绝对地址", () => {
    const context = redirectContextOf("127.0.0.1:8780", false)
    assert.equal(resolveRedirect(undefined, context), "/")
    assert.equal(resolveRedirect("", context), "/")
    assert.equal(resolveRedirect("/web?x=1", context), "/web?x=1")
    assert.equal(resolveRedirect("//evil.example/", context), "/")
    assert.equal(resolveRedirect("/\\evil.example", context), "/")
    assert.equal(resolveRedirect("not a url", context), "/")
    assert.equal(resolveRedirect("/web\r\nSet-Cookie: x=y", context), "/")

    assert.equal(resolveRedirect("127.0.0.1:8787", context), "http://127.0.0.1:8787/")
    assert.equal(
        resolveRedirect("127.0.0.1:8787/deep/link?x=1", context),
        "http://127.0.0.1:8787/deep/link?x=1",
    )
    assert.equal(
        resolveRedirect("192.168.31.138:8787", context),
        "http://192.168.31.138:8787/",
    )
    assert.equal(
        resolveRedirect("http://192.168.31.138:8787/page", context),
        "http://192.168.31.138:8787/page",
    )
    assert.equal(
        resolveRedirect("http://127.0.0.1:8787/page?x=1", context),
        "http://127.0.0.1:8787/page?x=1",
    )
    assert.equal(resolveRedirect("https://127.0.0.1:8787/", context), "/")

    /* 协议一致：https 网关下 bare 地址回退 */
    const httpsContext = redirectContextOf("127.0.0.1:8780", true)
    assert.equal(resolveRedirect("127.0.0.1:8787", httpsContext), "/")
    assert.equal(resolveRedirect("http://127.0.0.1:8787/", httpsContext), "/")
    assert.equal(
        resolveRedirect("https://127.0.0.1:8787/", httpsContext),
        "https://127.0.0.1:8787/",
    )

    /* 外站、公网 IP、userinfo、陌生主机名 */
    assert.equal(resolveRedirect("http://evil.example/", context), "/")
    assert.equal(resolveRedirect("//evil.example/", context), "/")
    assert.equal(resolveRedirect("8.8.8.8:8787", context), "/")
    assert.equal(resolveRedirect("http://user:pass@127.0.0.1:8787/", context), "/")
    assert.equal(resolveRedirect("http://127.0.0.1:8787@evil.example/", context), "/")
    assert.equal(resolveRedirect("http://127.0.0.1.evil.com:8787/", context), "/")
    assert.equal(resolveRedirect("localhost:8787", context), "/")
    assert.equal(resolveRedirect("ftp://127.0.0.1:8787/", context), "/")

    const localhostContext = redirectContextOf("localhost:8780", false)
    assert.equal(
        resolveRedirect("localhost:8787/page", localhostContext),
        "http://localhost:8787/page",
    )
    assert.equal(
        resolveRedirect("localhost.:8787/page", localhostContext),
        "http://localhost.:8787/page",
    )
})

test("isLocalAddress：loopback、私有网段、链路本地与 IPv6", () => {
    for (const host of [
        "127.0.0.1",
        "127.8.8.8",
        "10.0.0.1",
        "172.16.0.1",
        "172.31.255.254",
        "192.168.31.138",
        "169.254.1.1",
        "[::1]",
        "[fc00::1]",
        "[fd00::1]",
        "[fdff::1]",
        "[fe80::1]",
        "[febf::1]",
    ]) {
        assert.equal(isLocalAddress(host), true, host)
    }
    for (const host of [
        "8.8.8.8",
        "172.32.0.1",
        "192.169.1.1",
        "localhost",
        "evil.example",
        "[2001:db8::1]",
        "127.0.0.1.evil.example",
        "[fc::1]",
        "[fe8::1]",
        "[fea::1]",
        "[fec0::1]",
    ]) {
        assert.equal(isLocalAddress(host), false, host)
    }
})

test("CORS：同主机任意端口为来源，跨协议与陌生来源拒绝", () => {
    const context = redirectContextOf("127.0.0.1:8780", false)
    assert.equal(originAllowed("http://127.0.0.1:8787", context), true)
    assert.equal(originAllowed("http://127.0.0.1", context), true)
    assert.equal(originAllowed("http://localhost:8787", context), false)
    assert.equal(originAllowed("https://127.0.0.1:8787", context), false)
    assert.equal(originAllowed("http://evil.example", context), false)
    assert.equal(originAllowed(undefined, context), false)

    const samePort = corsHeaders("http://127.0.0.1:8787", context)
    assert.deepEqual(samePort, {
        "access-control-allow-origin": "http://127.0.0.1:8787",
        "access-control-allow-credentials": "true",
        vary: "origin",
    })
    assert.deepEqual(corsHeaders("http://evil.example", context), {})

    const preflight = preflightHeaders("http://127.0.0.1:8787", context, "content-type")
    assert.equal(preflight["access-control-allow-methods"], "GET, HEAD, OPTIONS")
    assert.equal(preflight["access-control-allow-headers"], "content-type")
    assert.equal(preflight["access-control-max-age"], "600")
    assert.deepEqual(preflightHeaders("http://evil.example", context, "content-type"), {})
})

test("会话快照与发现文件格式", () => {
    const hash = sessionTokenHash("token-value")
    const snapshot = JSON.parse(
        sessionSnapshotJson([{ hash, expiresAt: 1_700_000_000_000 }], new Date(0)),
    ) as {
        version: number
        updatedAt: string
        sessions: Array<{ hash: string; expiresAt: number }>
    }
    assert.equal(snapshot.version, 1)
    assert.equal(snapshot.updatedAt, new Date(0).toISOString())
    assert.deepEqual(snapshot.sessions, [{ hash, expiresAt: 1_700_000_000_000 }])
    assert.equal(sessionSnapshotJson([]).includes("token-value"), false)

    const discovery = buildSsoDiscovery({
        url: "http://127.0.0.1:8780",
        authEnabled: true,
        cookieName: SESSION_COOKIE,
        now: new Date(0),
    })
    assert.deepEqual(discovery, {
        version: 1,
        url: "http://127.0.0.1:8780",
        authEnabled: true,
        cookieName: SESSION_COOKIE,
        loginPath: SSO_LOGIN_PATH,
        logoutPath: "/logout",
        verifyPath: SSO_VERIFY_PATH,
        sessionsFile: SSO_SESSIONS_FILE,
        updatedAt: new Date(0).toISOString(),
    })
})

/* ---------- 网关集成 ---------- */

test("会话 cookie：host-only、Path=/、HttpOnly、SameSite=Lax", async () => {
    const fixture = await startGateway()
    try {
        const response = await postForm(`${fixture.gateway.url}${SSO_LOGIN_PATH}`, {
            password: "secret123",
            confirm: "secret123",
        })
        assert.equal(response.status, 302)
        const setCookie = response.headers.getSetCookie()[0] ?? ""
        assert.match(setCookie, new RegExp(`^${SESSION_COOKIE}=`))
        assert.match(setCookie, /; Path=\//)
        assert.match(setCookie, /; HttpOnly/)
        assert.match(setCookie, /; SameSite=Lax/)
        assert.doesNotMatch(setCookie, /Domain=/)
        assert.doesNotMatch(setCookie, /; Secure/)

        const token = tokenOf(cookieOf(response))
        const sessions = readSessions(fixture.storage)
        assert.equal(sessions.length, 1)
        assert.equal(sessions[0]?.hash, sessionTokenHash(token))
        assert.notEqual(sessions[0]?.hash, token)
    } finally {
        await fixture.close()
    }
})

test("校验接口：有效/无效/缺 cookie 与鉴权关闭", async () => {
    const fixture = await startGateway()
    try {
        const anonymous = await fetch(verifyUrl(fixture.gateway), {
            headers: { accept: "application/json" },
        })
        assert.equal(anonymous.status, 401)
        assert.deepEqual(await anonymous.json(), { ok: false, error: "unauthorized" })
        assert.equal(anonymous.headers.get("cache-control"), "no-store")

        const cookie = await login(fixture.gateway)
        const valid = await fetch(verifyUrl(fixture.gateway), {
            headers: { cookie, accept: "application/json" },
        })
        assert.equal(valid.status, 200)
        const payload = (await valid.json()) as Record<string, unknown>
        assert.equal(payload["ok"], true)
        assert.equal(payload["auth"], true)
        assert.equal(payload["user"], "admin")
        assert.equal(payload["cookieName"], SESSION_COOKIE)
        assert.equal(typeof payload["expiresAt"], "number")

        const invalid = await fetch(verifyUrl(fixture.gateway), {
            headers: { cookie: `${SESSION_COOKIE}=forged`, accept: "application/json" },
        })
        assert.equal(invalid.status, 401)

        const wrongMethod = await fetch(verifyUrl(fixture.gateway), {
            method: "POST",
            headers: { accept: "application/json" },
        })
        assert.equal(wrongMethod.status, 405)
        assert.equal(wrongMethod.headers.get("allow"), "GET, HEAD, OPTIONS")
    } finally {
        await fixture.close()
    }

    const disabled = await startGateway([], { auth: { enabled: false } })
    try {
        const response = await fetch(verifyUrl(disabled.gateway), {
            headers: { accept: "application/json" },
        })
        assert.equal(response.status, 200)
        const payload = (await response.json()) as Record<string, unknown>
        assert.equal(payload["ok"], true)
        assert.equal(payload["auth"], false)
        assert.equal(payload["user"], null)
    } finally {
        await disabled.close()
    }
})

test("校验接口：CORS 预检与来源白名单", async () => {
    const fixture = await startGateway()
    try {
        const cookie = await login(fixture.gateway)
        const sameHostOrigin = "http://127.0.0.1:8787"
        const allowed = await fetch(verifyUrl(fixture.gateway), {
            headers: { cookie, origin: sameHostOrigin, accept: "application/json" },
        })
        assert.equal(allowed.status, 200)
        assert.equal(allowed.headers.get("access-control-allow-origin"), sameHostOrigin)
        assert.equal(allowed.headers.get("access-control-allow-credentials"), "true")
        assert.equal(allowed.headers.get("vary"), "origin")

        const preflight = await fetch(verifyUrl(fixture.gateway), {
            method: "OPTIONS",
            headers: {
                origin: sameHostOrigin,
                "access-control-request-method": "GET",
                "access-control-request-headers": "content-type",
            },
        })
        assert.equal(preflight.status, 204)
        assert.equal(preflight.headers.get("access-control-allow-origin"), sameHostOrigin)
        assert.equal(
            preflight.headers.get("access-control-allow-methods"),
            "GET, HEAD, OPTIONS",
        )

        const evil = await fetch(verifyUrl(fixture.gateway), {
            headers: { cookie, origin: "http://evil.example", accept: "application/json" },
        })
        assert.equal(evil.status, 200)
        assert.equal(evil.headers.get("access-control-allow-origin"), null)

        const crossProtocol = await fetch(verifyUrl(fixture.gateway), {
            headers: { cookie, origin: "https://127.0.0.1:8787" },
        })
        assert.equal(crossProtocol.headers.get("access-control-allow-origin"), null)
    } finally {
        await fixture.close()
    }
})

test("会话快照：登录写入、注销清空、改密换新、重启清空", async () => {
    const storage = memoryStorage()
    const fixture = await startGateway([], {}, storage)
    try {
        const cookie = await login(fixture.gateway)
        assert.equal(readSessions(storage).length, 1)

        const logout = await postForm(`${fixture.gateway.url}/logout`, {}, cookie)
        assert.equal(logout.status, 302)
        assert.deepEqual(readSessions(storage), [])

        const beforeChange = await login(fixture.gateway)
        const changed = await postForm(
            `${fixture.gateway.url}/__gateway/password`,
            { current: "secret123", password: "newsecret", confirm: "newsecret" },
            beforeChange,
        )
        assert.equal(changed.status, 302)
        const afterChange = cookieOf(changed)
        const sessions = readSessions(storage)
        assert.equal(sessions.length, 1, "改密后只保留新会话")
        assert.equal(sessions[0]?.hash, sessionTokenHash(tokenOf(afterChange)))
        assert.notEqual(sessions[0]?.hash, sessionTokenHash(tokenOf(beforeChange)))

        const oldToken = await fetch(verifyUrl(fixture.gateway), {
            headers: { cookie: beforeChange, accept: "application/json" },
        })
        assert.equal(oldToken.status, 401)
    } finally {
        await fixture.close()
    }

    /* 重启：会话只存在内存，启动时快照为空 */
    const restarted = await startGateway([], {}, storage)
    try {
        assert.deepEqual(readSessions(storage), [])
        assert.ok(storage.files.has(SSO_DISCOVERY_FILE))
        const discovery = JSON.parse(storage.files.get(SSO_DISCOVERY_FILE) ?? "{}") as Record<
            string,
            unknown
        >
        assert.equal(discovery["url"], restarted.gateway.url)
        assert.equal(discovery["cookieName"], SESSION_COOKIE)
        assert.equal(discovery["verifyPath"], SSO_VERIFY_PATH)
        assert.equal(discovery["sessionsFile"], SSO_SESSIONS_FILE)
        assert.equal(discovery["authEnabled"], true)
    } finally {
        await restarted.close()
    }
})

test("会话快照写入失败会重试：登录成功且快照最终落盘", async () => {
    const storage = memoryStorage()
    let failures = 0
    const flaky = {
        files: storage.files,
        readText: storage.readText,
        writeText: async (path: string, text: string) => {
            if (path === SSO_SESSIONS_FILE && failures > 0) {
                failures -= 1
                throw new Error("EACCES")
            }
            await storage.writeText(path, text)
        },
    }
    const fixture = await startGateway([], {}, flaky)
    try {
        failures = 2
        const cookie = await login(fixture.gateway)
        assert.equal(failures, 0, "第三次写入未成功")
        const sessions = readSessions(storage)
        assert.equal(sessions.length, 1)
        assert.equal(sessions[0]?.hash, sessionTokenHash(tokenOf(cookie)))
    } finally {
        await fixture.close()
    }
})

test("跨端口回跳：同主机任意端口放行，陌生主机回退 /", async () => {
    const fixture = await startGateway()
    try {
        const target = "http://127.0.0.1:8787/page?x=1"
        const response = await postForm(`${fixture.gateway.url}${SSO_LOGIN_PATH}`, {
            password: "secret123",
            confirm: "secret123",
            next: target,
        })
        assert.equal(response.status, 302)
        assert.equal(response.headers.get("location"), target)

        const evil = await postForm(`${fixture.gateway.url}${SSO_LOGIN_PATH}`, {
            password: "secret123",
            next: "http://evil.example/",
        })
        assert.equal(evil.status, 302)
        assert.equal(evil.headers.get("location"), "/")
    } finally {
        await fixture.close()
    }
})

test("已登录访问 /login?next= 直接回跳（跨端口 SSO 的返回路径）", async () => {
    const fixture = await startGateway()
    try {
        const cookie = await login(fixture.gateway)
        const target = "http://127.0.0.1:8787/deep/link"
        const response = await fetch(
            `${fixture.gateway.url}${SSO_LOGIN_PATH}?next=${encodeURIComponent(target)}`,
            { redirect: "manual", headers: { cookie, accept: "text/html" } },
        )
        assert.equal(response.status, 302)
        assert.equal(response.headers.get("location"), target)
    } finally {
        await fixture.close()
    }
})

test("回跳主机以当前请求 Host 为准：同名主机放行，异名主机回退 /", async () => {
    const localhostNext = encodeURIComponent("http://localhost:8787/from-localhost")
    const fixture = await startGateway()
    try {
        const cookie = await login(fixture.gateway)
        const loginPath = `${SSO_LOGIN_PATH}?next=${localhostNext}`

        /* 浏览器从 127.0.0.1 访问网关：localhost 与当前 Host 不同，拒绝 */
        const viaLoopback = await fetch(`${fixture.gateway.url}${loginPath}`, {
            redirect: "manual",
            headers: { cookie, accept: "text/html" },
        })
        assert.equal(viaLoopback.status, 302)
        assert.equal(viaLoopback.headers.get("location"), "/")

        /* 浏览器从 localhost 访问网关：同主机，任意端口放行 */
        const viaLocalhost = await rawGet(fixture.gateway.port, loginPath, {
            host: `localhost:${fixture.gateway.port}`,
            cookie,
            accept: "text/html",
        })
        assert.equal(viaLocalhost.status, 302)
        assert.equal(viaLocalhost.headers.location, "http://localhost:8787/from-localhost")
    } finally {
        await fixture.close()
    }
})

test("注销：JSON 响应与 cookie 清除", async () => {
    const fixture = await startGateway()
    try {
        const cookie = await login(fixture.gateway)
        const response = await fetch(`${fixture.gateway.url}/logout`, {
            method: "POST",
            redirect: "manual",
            headers: { cookie, accept: "application/json" },
        })
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { ok: true })
        const cleared = response.headers.getSetCookie()[0] ?? ""
        assert.match(cleared, /Max-Age=0/)
        assert.doesNotMatch(cleared, /Domain=/)
        const verify = await fetch(verifyUrl(fixture.gateway), {
            headers: { cookie, accept: "application/json" },
        })
        assert.equal(verify.status, 401)
    } finally {
        await fixture.close()
    }
})

/* ---------- 双端口端到端：模拟其他端口上的服务 ---------- */

interface ConsumerFixture {
    readonly url: string
    readonly port: number
    close(): Promise<void>
}

/**
 * 模拟监听在另一个端口的插件服务：读网关会话快照本地校验 cookie，
 * 未登录时 302 到网关登录页并带上自己的原始地址（不依赖出网权限）
 */
async function startConsumer(
    gatewayUrl: string,
    storage: MemoryStorage,
): Promise<ConsumerFixture> {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = req.url ?? "/"
        const cookieHeader = req.headers.cookie ?? ""
        const token = cookieHeader
            .split(";")
            .map((part) => part.trim())
            .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
            ?.slice(SESSION_COOKIE.length + 1)
        const snapshot = JSON.parse(storage.files.get(SSO_SESSIONS_FILE) ?? "{}") as {
            sessions?: Array<{ hash: string; expiresAt: number }>
        }
        const session =
            token === undefined
                ? undefined
                : snapshot.sessions?.find(
                      (entry) => entry.hash === sessionTokenHash(token) && entry.expiresAt > Date.now(),
                  )
        if (session === undefined) {
            if (url.startsWith("/api")) {
                res.writeHead(401, { "content-type": "application/json; charset=utf-8" })
                res.end('{"error":"unauthorized"}')
                return
            }
            const returnUrl = `http://${req.headers.host ?? "127.0.0.1"}${url}`
            res.writeHead(302, {
                location: `${gatewayUrl}${SSO_LOGIN_PATH}?redirect=${encodeURIComponent(returnUrl)}`,
                "cache-control": "no-store",
            })
            res.end()
            return
        }
        if (url.startsWith("/api")) {
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" })
            res.end(JSON.stringify({ user: "admin" }))
            return
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        res.end(`<h1>hello admin</h1>`)
    })
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject)
            resolve()
        })
    })
    const address = server.address() as AddressInfo
    return {
        url: `http://127.0.0.1:${address.port}`,
        port: address.port,
        close: async () => {
            server.closeAllConnections?.()
            await new Promise<void>((resolve) => server.close(() => resolve()))
        },
    }
}

test("双端口 SSO：登录网关后其他端口页面自动认证", async () => {
    const storage = memoryStorage()
    const fixture = await startGateway([], {}, storage)
    const consumer = await startConsumer(fixture.gateway.url, storage)
    try {
        /* 1. 未登录直接访问其他端口：跳网关登录页，redirect 是原始地址 */
        const anonymous = await fetch(`${consumer.url}/deep/link?x=1`, {
            redirect: "manual",
            headers: { accept: "text/html" },
        })
        assert.equal(anonymous.status, 302)
        const loginLocation = anonymous.headers.get("location") ?? ""
        assert.ok(loginLocation.startsWith(`${fixture.gateway.url}${SSO_LOGIN_PATH}?redirect=`))
        const next = new URL(loginLocation).searchParams.get("redirect")
        assert.equal(next, `${consumer.url}/deep/link?x=1`)

        /* 2. 在网关登录（首次设置密码），拿会话 cookie */
        const loginResponse = await postForm(`${fixture.gateway.url}${SSO_LOGIN_PATH}`, {
            password: "secret123",
            confirm: "secret123",
            redirect: next ?? "/",
        })
        assert.equal(loginResponse.status, 302)
        assert.equal(loginResponse.headers.get("location"), next)
        const cookie = cookieOf(loginResponse)

        /* 3. 浏览器带着同一个 cookie 再访问其他端口：自动认证 */
        const authed = await fetch(`${consumer.url}/deep/link?x=1`, {
            headers: { cookie, accept: "text/html" },
        })
        assert.equal(authed.status, 200)
        assert.match(await authed.text(), /hello admin/)

        /* 4. 同一个 cookie 在网关校验接口也有效（两个端口共享 host-only cookie） */
        const verify = await fetch(verifyUrl(fixture.gateway), {
            headers: { cookie, accept: "application/json" },
        })
        assert.equal(verify.status, 200)

        /* 5. 网关注销后，其他端口立即失效 */
        const logout = await postForm(`${fixture.gateway.url}/logout`, {}, cookie)
        assert.equal(logout.status, 302)
        const afterLogout = await fetch(`${consumer.url}/deep/link?x=1`, {
            redirect: "manual",
            headers: { cookie, accept: "text/html" },
        })
        assert.equal(afterLogout.status, 302)
        const api = await fetch(`${consumer.url}/api`, {
            headers: { cookie, accept: "application/json" },
        })
        assert.equal(api.status, 401)
    } finally {
        await consumer.close()
        await fixture.close()
    }
})
