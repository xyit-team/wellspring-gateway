/*
 * 网关服务
 *
 * 单端口对外：自有端点（登录、密码、健康检查、状态、首页）先处理，其余按路由反代到上游
 * 鉴权开启时，未登录请求重定向到 /login（HTML）或返回 401（其它）；public 路由免登录
 */

import { randomUUID } from "node:crypto"
import {
    createServer as createHttpServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http"
import { createServer as createHttpsServer } from "node:https"
import { connect as netConnect, type AddressInfo } from "node:net"
import type { Duplex } from "node:stream"

import { AuthStore, SESSION_COOKIE, passwordProblem } from "./auth.ts"
import { parseTarget, upstreamPath, type GatewayConfig } from "./config.ts"
import { GATEWAY_VERSION } from "./version.ts"
import { homePage, loginPage, messagePage, passwordPage } from "./pages.ts"
import type { GatewayUpstreamInfo } from "./protocol.ts"
import {
    forwardRequest,
    forwardUpgrade,
    sessionTokenFrom,
    type ProxyLogger,
} from "./proxy.ts"
import { RouteTable, type AddUpstreamResult, type RouteEntry } from "./routes.ts"

const BODY_LIMIT_BYTES = 16 * 1024
const PRUNE_INTERVAL_MS = 10 * 60 * 1000
const PROBE_TIMEOUT_MS = 500
const PROBE_CACHE_MS = 3000
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

const OWN_PATHS = new Set([
    "/login",
    "/logout",
    "/__gateway/password",
    "/__gateway/health",
    "/__gateway/status",
])

const SECURITY_HEADERS = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
} as const

const PAGE_CSP =
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"

export interface GatewayLogger extends ProxyLogger {
    info(fields: Record<string, unknown>, message: string): void
    error(fields: Record<string, unknown>, message: string): void
}

export interface GatewayEnv {
    readonly config: GatewayConfig
    readonly auth: AuthStore
    readonly logger: GatewayLogger
    /** 读取插件数据目录内的文件（TLS 证书） */
    readonly readText: (path: string) => Promise<string | null>
}

export interface GatewayHandle {
    readonly url: string
    readonly secure: boolean
    readonly port: number
    readonly version: string
    start(): Promise<void>
    close(): Promise<void>
    /** 插件注册上游；返回失败原因，由调用方决定是否回给注册方 */
    addUpstream(input: unknown): AddUpstreamResult
    removeUpstream(name: string): boolean
    listUpstreams(): GatewayUpstreamInfo[]
}

class HttpError extends Error {
    readonly status: number

    constructor(status: number, message: string) {
        super(message)
        this.status = status
    }
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function remoteAddressOf(req: IncomingMessage): string {
    return req.socket.remoteAddress ?? ""
}

function cookieToken(req: IncomingMessage): string | undefined {
    return sessionTokenFrom(req.headers)
}

function acceptsHtml(req: IncomingMessage): boolean {
    const accept = req.headers.accept ?? ""
    return accept.includes("text/html") || accept.includes("*/*")
}

function requestIdOf(req: IncomingMessage): string {
    const header = req.headers["x-request-id"]
    const provided = typeof header === "string" ? header : Array.isArray(header) ? header[0] : undefined
    if (provided !== undefined && REQUEST_ID_PATTERN.test(provided)) {
        return provided
    }
    return randomUUID().replaceAll("-", "").slice(0, 16)
}

/** 只接受站内绝对路径，防开放重定向 */
export function safeNext(value: string | null | undefined): string {
    if (typeof value !== "string" || value === "") {
        return "/"
    }
    if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
        return "/"
    }
    return value
}

function htmlResponse(
    res: ServerResponse,
    status: number,
    html: string,
    extraHeaders: Record<string, string> = {},
): void {
    const body = Buffer.from(html, "utf8")
    res.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(body.length),
        "cache-control": "no-store",
        "content-security-policy": PAGE_CSP,
        ...SECURITY_HEADERS,
        ...extraHeaders,
    })
    res.end(body)
}

function jsonResponse(res: ServerResponse, status: number, value: unknown): void {
    const body = Buffer.from(JSON.stringify(value), "utf8")
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": String(body.length),
        "cache-control": "no-store",
        ...SECURITY_HEADERS,
    })
    res.end(body)
}

function redirect(res: ServerResponse, location: string, headers: Record<string, string> = {}): void {
    res.writeHead(302, { location, "cache-control": "no-store", ...headers })
    res.end()
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buffer.length
        if (size > BODY_LIMIT_BYTES) {
            throw new HttpError(413, "表单过大")
        }
        chunks.push(buffer)
    }
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"))
}

function sameOrigin(req: IncomingMessage, secure: boolean): boolean {
    const origin = req.headers.origin
    if (origin === undefined) {
        return true
    }
    const host = req.headers.host
    if (host === undefined) {
        return false
    }
    return origin.toLowerCase() === `${secure ? "https" : "http"}://${host}`.toLowerCase()
}

function passwordErrorMessage(problem: "too-short" | "too-long"): string {
    return problem === "too-short" ? "密码长度至少 6 位" : "密码长度最多 200 位"
}

function upstreamInfo(entry: RouteEntry): GatewayUpstreamInfo {
    return {
        name: entry.name,
        prefix: entry.config.prefix,
        target: entry.config.target,
        stripPrefix: entry.config.stripPrefix,
        public: entry.config.public,
        timeoutMs: entry.config.timeoutMs,
        source: entry.source,
    }
}

export function createGateway(env: GatewayEnv): GatewayHandle {
    const { config, auth, logger } = env
    const secure = config.tls !== null
    const routeTable = new RouteTable(config.routes)
    const startedAt = Date.now()
    const probeCache = new Map<string, { ok: boolean; checkedAt: number }>()
    let server: Server | null = null
    let actualPort = config.port
    let pruneTimer: ReturnType<typeof setInterval> | null = null

    function gatewayUrl(): string {
        const host = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host
        return `${secure ? "https" : "http"}://${host}:${actualPort}`
    }

    const sessionCookie = (token: string, maxAgeSeconds: number): string =>
        `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${
            secure ? "; Secure" : ""
        }`

    const clearSessionCookie = (): string =>
        `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`

    function message(res: ServerResponse, status: number, title: string, text: string): void {
        htmlResponse(res, status, messagePage({ title, message: text }))
    }

    function loginNext(url: URL, form: URLSearchParams | null): string {
        return safeNext(form?.get("next") ?? url.searchParams.get("next"))
    }

    function setLoginCookie(res: ServerResponse): void {
        const session = auth.createSession()
        res.setHeader(
            "set-cookie",
            sessionCookie(
                session.token,
                Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000)),
            ),
        )
    }

    function isAuthorized(req: IncomingMessage): boolean {
        if (!config.auth.enabled) {
            return true
        }
        return auth.validateSession(cookieToken(req))
    }

    function unauthorized(req: IncomingMessage, res: ServerResponse, url: URL): void {
        const method = req.method ?? "GET"
        if (acceptsHtml(req) && (method === "GET" || method === "HEAD")) {
            const next = encodeURIComponent(`${url.pathname}${url.search}`)
            redirect(res, `/login?next=${next}`)
            return
        }
        jsonResponse(res, 401, { error: "unauthorized" })
    }

    async function handleLogin(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
        if (!sameOrigin(req, secure)) {
            message(res, 403, "请求被拒绝", "Origin 校验失败")
            return
        }
        const form = await readForm(req)
        const next = loginNext(url, form)
        const ip = remoteAddressOf(req)

        if (!auth.hasPassword) {
            const password = form.get("password") ?? ""
            const confirm = form.get("confirm") ?? ""
            const problem = passwordProblem(password)
            if (problem !== null) {
                message(res, 400, "设置密码", passwordErrorMessage(problem))
                return
            }
            if (password !== confirm) {
                message(res, 400, "设置密码", "两次输入不一致")
                return
            }
            await auth.setPassword(password)
            setLoginCookie(res)
            logger.info({ ip }, "管理密码已设置")
            redirect(res, next)
            return
        }

        if (auth.isBlocked(ip)) {
            message(res, 429, "尝试次数过多", "稍后再试")
            return
        }
        const password = form.get("password") ?? ""
        if (!(await auth.verifyPassword(password))) {
            auth.recordFailure(ip)
            logger.warn({ ip }, "登录失败")
            const blocked = auth.isBlocked(ip)
            message(res, blocked ? 429 : 401, "登录失败", blocked ? "尝试次数过多" : "密码错误")
            return
        }
        auth.clearFailures(ip)
        setLoginCookie(res)
        redirect(res, next)
    }

    async function handlePasswordChange(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!sameOrigin(req, secure)) {
            message(res, 403, "请求被拒绝", "Origin 校验失败")
            return
        }
        const form = await readForm(req)
        const current = form.get("current") ?? ""
        const password = form.get("password") ?? ""
        const confirm = form.get("confirm") ?? ""
        if (!(await auth.verifyPassword(current))) {
            htmlResponse(res, 401, passwordPage({ error: "当前密码错误" }))
            return
        }
        const problem = passwordProblem(password)
        if (problem !== null) {
            htmlResponse(res, 400, passwordPage({ error: passwordErrorMessage(problem) }))
            return
        }
        if (password !== confirm) {
            htmlResponse(res, 400, passwordPage({ error: "两次输入不一致" }))
            return
        }
        await auth.setPassword(password)
        setLoginCookie(res)
        logger.info({}, "管理密码已修改")
        redirect(res, "/")
    }

    async function probeUpstream(target: URL): Promise<boolean> {
        const key = target.href
        const cached = probeCache.get(key)
        if (cached !== undefined && Date.now() - cached.checkedAt < PROBE_CACHE_MS) {
            return cached.ok
        }
        const port = target.port === "" ? (target.protocol === "https:" ? 443 : 80) : Number(target.port)
        const ok = await new Promise<boolean>((resolve) => {
            const socket = netConnect({ host: target.hostname, port })
            const timer = setTimeout(() => {
                socket.destroy()
                resolve(false)
            }, PROBE_TIMEOUT_MS)
            socket.once("connect", () => {
                clearTimeout(timer)
                socket.destroy()
                resolve(true)
            })
            socket.once("error", () => {
                clearTimeout(timer)
                resolve(false)
            })
        })
        probeCache.set(key, { ok, checkedAt: Date.now() })
        return ok
    }

    async function statusPayload(): Promise<Record<string, unknown>> {
        const routes = await Promise.all(
            routeTable.list().map(async (entry) => {
                const target = parseTarget(entry.config.target)
                const reachable = target === null ? false : await probeUpstream(target)
                return { ...upstreamInfo(entry), upstream: reachable ? "up" : "down" }
            }),
        )
        return {
            version: GATEWAY_VERSION,
            url: gatewayUrl(),
            secure,
            uptimeMs: Date.now() - startedAt,
            auth: { enabled: config.auth.enabled, hasPassword: auth.hasPassword },
            routes,
        }
    }

    async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const requestStart = Date.now()
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
        const requestId = requestIdOf(req)
        res.setHeader("x-request-id", requestId)
        let upstream: string | null = null
        let actor: string | null = null
        try {
            const path = url.pathname
            const method = req.method ?? "GET"
            const authorized = isAuthorized(req)

            if (path === "/__gateway/health") {
                jsonResponse(res, 200, { status: "ok", auth: config.auth.enabled })
                return
            }
            if (path === "/__gateway/status") {
                if (config.auth.enabled && !authorized) {
                    unauthorized(req, res, url)
                    return
                }
                jsonResponse(res, 200, await statusPayload())
                return
            }
            if (path === "/login") {
                if (!config.auth.enabled) {
                    redirect(res, "/")
                    return
                }
                if (method === "POST") {
                    await handleLogin(req, res, url)
                    return
                }
                if (method !== "GET" && method !== "HEAD") {
                    message(res, 405, "不支持的请求", "GET / POST")
                    return
                }
                const next = safeNext(url.searchParams.get("next"))
                htmlResponse(res, 200, loginPage({ hasPassword: auth.hasPassword, next }))
                return
            }
            if (path === "/logout") {
                if (method !== "POST" && method !== "GET") {
                    message(res, 405, "不支持的请求", "GET / POST")
                    return
                }
                auth.destroySession(cookieToken(req))
                redirect(res, "/login", { "set-cookie": clearSessionCookie() })
                return
            }
            if (path === "/__gateway/password") {
                if (!authorized) {
                    redirect(res, "/login?next=%2F__gateway%2Fpassword")
                    return
                }
                if (method === "POST") {
                    await handlePasswordChange(req, res)
                    return
                }
                htmlResponse(res, 200, passwordPage({}))
                return
            }

            const match = routeTable.match(path)
            if (match === null) {
                if (!authorized) {
                    unauthorized(req, res, url)
                    return
                }
                if (path === "/" || path === "") {
                    htmlResponse(
                        res,
                        200,
                        homePage({ routes: routeTable.list().map((entry) => ({
                            prefix: entry.config.prefix,
                            name: entry.name,
                            source: entry.source,
                        })) }),
                    )
                    return
                }
                message(res, 404, "页面不存在", `${method} ${path}`)
                return
            }

            const entry = match.entry
            if (!entry.config.public && !authorized) {
                unauthorized(req, res, url)
                return
            }
            actor = config.auth.enabled && authorized ? "admin" : null
            const target = parseTarget(entry.config.target)
            if (target === null) {
                message(res, 502, "上游配置错误", entry.config.target)
                return
            }
            upstream = target.href
            const pathValue = `${upstreamPath(entry.config, match.rest, path)}${url.search}`
            await forwardRequest(req, res, {
                target,
                upstreamPath: pathValue,
                prefix: entry.config.prefix,
                remoteAddress: remoteAddressOf(req),
                secure,
                user: actor,
                timeoutMs: entry.config.timeoutMs ?? config.upstreamTimeoutMs,
                requestId,
                logger,
            })
        } catch (error) {
            if (error instanceof HttpError) {
                if (!res.headersSent) {
                    message(res, error.status, "请求失败", error.message)
                }
                return
            }
            logger.error({ error: errorText(error), path: url.pathname, requestId }, "网关请求失败")
            if (!res.headersSent) {
                message(res, 500, "网关内部错误", "请求处理失败")
            } else {
                res.destroy()
            }
        } finally {
            if (config.accessLog) {
                logger.info(
                    {
                        requestId,
                        method: req.method ?? "GET",
                        path: url.pathname,
                        status: res.statusCode,
                        durationMs: Date.now() - requestStart,
                        upstream,
                        user: actor,
                    },
                    "access",
                )
            }
        }
    }

    function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
        try {
            const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
            if (OWN_PATHS.has(url.pathname)) {
                socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n")
                return
            }
            const match = routeTable.match(url.pathname)
            if (match === null) {
                socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n")
                return
            }
            const authorized = isAuthorized(req)
            if (!match.entry.config.public && !authorized) {
                socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n")
                return
            }
            const target = parseTarget(match.entry.config.target)
            if (target === null) {
                socket.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n")
                return
            }
            forwardUpgrade(req, socket, head, {
                target,
                upstreamPath: `${upstreamPath(match.entry.config, match.rest, url.pathname)}${url.search}`,
                prefix: match.entry.config.prefix,
                remoteAddress: remoteAddressOf(req),
                secure,
                user: config.auth.enabled && authorized ? "admin" : null,
                timeoutMs: match.entry.config.timeoutMs ?? config.upstreamTimeoutMs,
                requestId: requestIdOf(req),
                logger,
            })
        } catch (error) {
            logger.warn({ error: errorText(error) }, "上游升级失败")
            socket.destroy()
        }
    }

    function handler(req: IncomingMessage, res: ServerResponse): void {
        void handleRequest(req, res).catch((error) => {
            logger.error({ error: errorText(error) }, "网关请求失败")
            if (!res.headersSent) {
                res.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
                res.end("gateway error\n")
            } else {
                res.destroy()
            }
        })
    }

    return {
        get url(): string {
            return gatewayUrl()
        },
        get secure(): boolean {
            return secure
        },
        get port(): number {
            return actualPort
        },
        version: GATEWAY_VERSION,
        async start(): Promise<void> {
            if (server !== null) {
                return
            }
            if (config.tls === null) {
                server = createHttpServer(handler)
            } else {
                const cert = await env.readText(config.tls.certFile)
                const key = await env.readText(config.tls.keyFile)
                if (cert === null) {
                    throw new Error(`TLS 证书不存在：${config.tls.certFile}`)
                }
                if (key === null) {
                    throw new Error(`TLS 私钥不存在：${config.tls.keyFile}`)
                }
                server = createHttpsServer({ cert, key }, handler)
            }
            const current = server
            current.on("clientError", (_error, socket) => {
                socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n")
            })
            current.on("upgrade", handleUpgrade)
            await new Promise<void>((resolve, reject) => {
                const onError = (error: Error): void => {
                    current.off("listening", onListening)
                    reject(error)
                }
                const onListening = (): void => {
                    current.off("error", onError)
                    resolve()
                }
                current.once("error", onError)
                current.once("listening", onListening)
                current.listen(config.port, config.host)
            })
            const address = current.address()
            actualPort =
                typeof address === "object" && address !== null
                    ? (address as AddressInfo).port
                    : config.port
            pruneTimer = setInterval(() => auth.prune(), PRUNE_INTERVAL_MS)
            pruneTimer.unref()
            logger.info(
                { url: gatewayUrl(), routes: routeTable.list().length, auth: config.auth.enabled },
                "网关已启动",
            )
        },
        async close(): Promise<void> {
            if (pruneTimer !== null) {
                clearInterval(pruneTimer)
                pruneTimer = null
            }
            const current = server
            server = null
            if (current === null) {
                return
            }
            await new Promise<void>((resolve) => {
                current.close(() => resolve())
                current.closeIdleConnections?.()
                const force = setTimeout(() => {
                    current.closeAllConnections?.()
                    resolve()
                }, 800)
                force.unref()
            })
        },
        addUpstream(input: unknown): AddUpstreamResult {
            const result = routeTable.add(input)
            if (!result.ok) {
                logger.warn({ error: result.error }, "上游注册失败")
                return result
            }
            logger.info(
                {
                    name: result.entry.name,
                    prefix: result.entry.config.prefix,
                    target: result.entry.config.target,
                    replaced: result.replaced,
                },
                "上游已注册",
            )
            return result
        },
        removeUpstream(name: string): boolean {
            const removed = routeTable.remove(name)
            if (removed) {
                logger.info({ name }, "上游已注销")
            }
            return removed
        },
        listUpstreams(): GatewayUpstreamInfo[] {
            return routeTable.list().map(upstreamInfo)
        },
    }
}
