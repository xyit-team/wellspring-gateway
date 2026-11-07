import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { type AddressInfo } from "node:net"
import { test } from "node:test"

import { AuthStore } from "../src/auth.ts"
import { parseGatewayConfig } from "../src/config.ts"
import { createGateway, type GatewayHandle } from "../src/server.ts"
import {
    acceptsHtml,
    createSsoClient,
    readSsoDiscovery,
    type SsoClient,
    type SsoDiscovery,
    type SsoResult,
} from "../src/sso-client.ts"

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

function memoryStorage(): MemoryStorage {
    const files = new Map<string, string>()
    return {
        files,
        readText: async (path) => files.get(path) ?? null,
        writeText: async (path, text) => {
            files.set(path, text)
        },
    }
}

function storageReader(storage: MemoryStorage): {
    readJson<T = unknown>(path: string): Promise<T | null>
} {
    return {
        async readJson<T = unknown>(path: string): Promise<T | null> {
            const text = storage.files.get(path)
            if (text === undefined) {
                return null
            }
            return JSON.parse(text) as T
        },
    }
}

async function startGateway(storage = memoryStorage()): Promise<GatewayHandle> {
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
        routes: [],
    })
    const gateway = createGateway({
        config,
        auth,
        logger: silentLogger,
        readText: (path) => storage.readText(path),
        writeText: (path, text) => storage.writeText(path, text),
    })
    await gateway.start()
    return gateway
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

interface ConsumerFixture {
    readonly url: string
    readonly port: number
    close(): Promise<void>
}

/** 另一个端口上的服务：用客户端助手校验会话，未登录跳网关登录页 */
async function startConsumer(client: SsoClient): Promise<ConsumerFixture> {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const headers = req.headers as Record<string, string | string[] | undefined>
        let result: SsoResult
        try {
            result = await client.verify(headers)
        } catch {
            result = { ok: false as const, reason: "unreachable" as const }
        }
        if (!result.ok) {
            const response = acceptsHtml(headers)
                ? client.redirectToLogin(
                      `http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`,
                  )
                : client.unauthorized()
            res.writeHead(response.status, response.headers)
            res.end(response.body)
            return
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" })
        res.end(JSON.stringify({ user: result.user }))
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

function localClient(discovery: SsoDiscovery, storage: MemoryStorage): SsoClient {
    const reader = storageReader(storage)
    return createSsoClient({
        gatewayUrl: discovery.url,
        authEnabled: discovery.authEnabled,
        cookieName: discovery.cookieName,
        sessions: async () => await reader.readJson(discovery.sessionsFile),
    })
}

/** 走完「未登录 → 网关登录 → 带着 cookie 回来」的浏览器流程 */
async function loginThroughGateway(
    gatewayUrl: string,
    returnUrl: string,
    password = "secret123",
): Promise<string> {
    const response = await postForm(`${gatewayUrl}/login`, {
        password,
        confirm: password,
        redirect: returnUrl,
    })
    assert.equal(response.status, 302)
    assert.equal(response.headers.get("location"), returnUrl)
    return cookieOf(response)
}

test("sso.json 可被其他插件发现（deps 后经 api.pluginData 读取）", async () => {
    const storage = memoryStorage()
    const gateway = await startGateway(storage)
    try {
        const discovery = await readSsoDiscovery(storageReader(storage))
        assert.ok(discovery !== null)
        assert.equal(discovery.url, gateway.url)
        assert.equal(discovery.cookieName, "wellspring_session")
        assert.equal(discovery.loginPath, "/login")
        assert.equal(discovery.verifyPath, "/__gateway/auth/verify")
        assert.equal(discovery.sessionsFile, "sessions.json")
        assert.equal(discovery.authEnabled, true)
    } finally {
        await gateway.close()
    }
})

test("本地快照模式：跨端口服务无需出网即可自动认证", async () => {
    const storage = memoryStorage()
    const gateway = await startGateway(storage)
    try {
        const discovery = await readSsoDiscovery(storageReader(storage))
        assert.ok(discovery !== null)
        const client = localClient(discovery, storage)
        const consumer = await startConsumer(client)
        try {
            /* 未登录：跳网关登录页，next 指向自己的原始地址 */
            const anonymous = await fetch(`${consumer.url}/deep/link?x=1`, {
                redirect: "manual",
                headers: { accept: "text/html" },
            })
            assert.equal(anonymous.status, 302)
            const loginLocation = anonymous.headers.get("location") ?? ""
            assert.ok(loginLocation.startsWith(`${discovery.url}/login?redirect=`))
            const next = new URL(loginLocation).searchParams.get("redirect")
            assert.equal(next, `${consumer.url}/deep/link?x=1`)

            const cookie = await loginThroughGateway(discovery.url, next ?? "/")

            /* 同一个 host-only cookie 带给其他端口的服务：本地快照命中，自动认证 */
            const authed = await fetch(`${consumer.url}/deep/link?x=1`, {
                headers: { cookie, accept: "text/html" },
            })
            assert.equal(authed.status, 200)
            assert.deepEqual(await authed.json(), { user: "admin" })

            /* API 请求未登录返回 401 */
            const api = await fetch(`${consumer.url}/api`, {
                headers: { accept: "application/json" },
            })
            assert.equal(api.status, 401)

            /* 网关注销后快照清空，其他端口立即失效 */
            assert.equal((await postForm(`${discovery.url}/logout`, {}, cookie)).status, 302)
            const afterLogout = await fetch(`${consumer.url}/deep/link?x=1`, {
                redirect: "manual",
                headers: { cookie, accept: "text/html" },
            })
            assert.equal(afterLogout.status, 302)
        } finally {
            await consumer.close()
        }
    } finally {
        await gateway.close()
    }
})

test("HTTP 校验模式：跨端口服务调网关校验接口", async () => {
    const storage = memoryStorage()
    const gateway = await startGateway(storage)
    try {
        const discovery = await readSsoDiscovery(storageReader(storage))
        assert.ok(discovery !== null)
        const client = createSsoClient({ gatewayUrl: discovery.url })
        const consumer = await startConsumer(client)
        try {
            const anonymous = await fetch(`${consumer.url}/page`, {
                redirect: "manual",
                headers: { accept: "text/html" },
            })
            assert.equal(anonymous.status, 302)
            const next = new URL(anonymous.headers.get("location") ?? "").searchParams.get("redirect")
            const cookie = await loginThroughGateway(discovery.url, next ?? "/")

            const authed = await fetch(`${consumer.url}/page`, { headers: { cookie } })
            assert.equal(authed.status, 200)
            assert.deepEqual(await authed.json(), { user: "admin" })

            /* 伪造 cookie 无效：API 风格请求直接 401 */
            const forged = await fetch(`${consumer.url}/page`, {
                redirect: "manual",
                headers: { cookie: "wellspring_session=forged", accept: "application/json" },
            })
            assert.equal(forged.status, 401)

            /* 浏览器式请求：跳回登录页 */
            const forgedHtml = await fetch(`${consumer.url}/page`, {
                redirect: "manual",
                headers: { cookie: "wellspring_session=forged", accept: "text/html" },
            })
            assert.equal(forgedHtml.status, 302)
        } finally {
            await consumer.close()
        }
    } finally {
        await gateway.close()
    }
})

test("HTTP 校验模式：网关不可达时失败关闭（跳登录）", async () => {
    const storage = memoryStorage()
    const gateway = await startGateway(storage)
    const discovery = await readSsoDiscovery(storageReader(storage))
    assert.ok(discovery !== null)
    const client = createSsoClient({ gatewayUrl: discovery.url, timeoutMs: 500 })
    const consumer = await startConsumer(client)
    const cookie = await loginThroughGateway(discovery.url, "/")
    try {
        const before = await fetch(`${consumer.url}/page`, { headers: { cookie } })
        assert.equal(before.status, 200)
    } finally {
        await gateway.close()
    }
    try {
        const after = await fetch(`${consumer.url}/page`, {
            redirect: "manual",
            headers: { cookie, accept: "text/html" },
        })
        assert.equal(after.status, 302)
    } finally {
        await consumer.close()
    }
})

test("鉴权关闭：本地快照模式直接放行（authEnabled 来自 sso.json）", async () => {
    const storage = memoryStorage()
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
        auth: { enabled: false },
        routes: [],
    })
    const gateway = createGateway({
        config,
        auth,
        logger: silentLogger,
        readText: (path) => storage.readText(path),
        writeText: (path, text) => storage.writeText(path, text),
    })
    await gateway.start()
    try {
        const discovery = await readSsoDiscovery(storageReader(storage))
        assert.ok(discovery !== null)
        assert.equal(discovery.authEnabled, false)
        const client = localClient(discovery, storage)
        const consumer = await startConsumer(client)
        try {
            const response = await fetch(`${consumer.url}/page`)
            assert.equal(response.status, 200)
            assert.deepEqual(await response.json(), { user: null })
        } finally {
            await consumer.close()
        }
    } finally {
        await gateway.close()
    }
})
