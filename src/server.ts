/*
 * 网关服务
 *
 * 单端口对外：自有端点（登录、密码、健康检查）先处理，其余按前缀路由反代到上游
 * 鉴权开启时，未登录请求重定向到 /login（HTML）或返回 401（其它）
 */

import {
    createServer as createHttpServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http"
import { createServer as createHttpsServer } from "node:https"
import type { AddressInfo } from "node:net"
import type { Duplex } from "node:stream"

import { AuthStore, SESSION_COOKIE, passwordProblem } from "./auth.ts"
import { matchRoute, parseTarget, upstreamPath, type GatewayConfig } from "./config.ts"
import { loginPage, messagePage, passwordPage } from "./pages.ts"
import {
    forwardRequest,
    forwardUpgrade,
    sessionTokenFrom,
    type ProxyLogger,
} from "./proxy.ts"

const BODY_LIMIT_BYTES = 16 * 1024
const PRUNE_INTERVAL_MS = 10 * 60 * 1000

const OWN_PATHS = new Set(["/login", "/logout", "/__gateway/password", "/__gateway/health"])

const SECURITY_HEADERS = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
} as const

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"

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
    start(): Promise<void>
    close(): Promise<void>
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

export function createGateway(env: GatewayEnv): GatewayHandle {
    const { config, auth, logger } = env
    const secure = config.tls !== null
    let server: Server | null = null
    let actualPort = config.port
    let pruneTimer: ReturnType<typeof setInterval> | null = null

    const sessionCookie = (token: string, maxAgeSeconds: number): string =>
        `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${
            secure ? "; Secure" : ""
        }`

    const clearSessionCookie = (): string =>
        `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`

    function message(
        res: ServerResponse,
        status: number,
        title: string,
        text: string,
    ): void {
        htmlResponse(res, status, messagePage({ title, message: text }))
    }

    function loginNext(url: URL, form: URLSearchParams | null): string {
        return safeNext(form?.get("next") ?? url.searchParams.get("next"))
    }

    function setLoginCookie(res: ServerResponse): void {
        const session = auth.createSession()
        res.setHeader(
            "set-cookie",
            sessionCookie(session.token, Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000))),
        )
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

    async function handlePasswordChange(
        req: IncomingMessage,
        res: ServerResponse,
    ): Promise<void> {
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

    function isAuthorized(req: IncomingMessage): boolean {
        if (!config.auth.enabled) {
            return true
        }
        return auth.validateSession(cookieToken(req))
    }

    async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const startedAt = Date.now()
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
        let upstream: string | null = null
        try {
            const path = url.pathname
            const method = req.method ?? "GET"

            if (path === "/__gateway/health") {
                jsonResponse(res, 200, { status: "ok", auth: config.auth.enabled })
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
                if (!isAuthorized(req)) {
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

            const match = matchRoute(config.routes, path)
            if (!isAuthorized(req)) {
                if (acceptsHtml(req) && (method === "GET" || method === "HEAD")) {
                    const next = encodeURIComponent(`${path}${url.search}`)
                    redirect(res, `/login?next=${next}`)
                    return
                }
                jsonResponse(res, 401, { error: "unauthorized" })
                return
            }
            if (match === null) {
                message(res, 404, "页面不存在", `${method} ${path}`)
                return
            }
            const target = parseTarget(match.route.target)
            if (target === null) {
                message(res, 502, "上游配置错误", match.route.target)
                return
            }
            upstream = target.href
            const pathValue = `${upstreamPath(match.route, match.rest, path)}${url.search}`
            await forwardRequest(req, res, {
                target,
                upstreamPath: pathValue,
                prefix: match.route.prefix,
                remoteAddress: remoteAddressOf(req),
                secure,
                user: config.auth.enabled ? "admin" : null,
                timeoutMs: config.upstreamTimeoutMs,
                logger,
            })
        } catch (error) {
            if (error instanceof HttpError) {
                if (!res.headersSent) {
                    message(res, error.status, "请求失败", error.message)
                }
                return
            }
            logger.error({ error: errorText(error), path: url.pathname }, "网关请求失败")
            if (!res.headersSent) {
                message(res, 500, "网关内部错误", "请求处理失败")
            } else {
                res.destroy()
            }
        } finally {
            if (config.accessLog) {
                logger.info(
                    {
                        method: req.method ?? "GET",
                        path: url.pathname,
                        status: res.statusCode,
                        durationMs: Date.now() - startedAt,
                        upstream,
                    },
                    "access",
                )
            }
        }
    }

    function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
        try {
            const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
            if (OWN_PATHS.has(url.pathname) || !isAuthorized(req)) {
                socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n")
                return
            }
            const match = matchRoute(config.routes, url.pathname)
            if (match === null) {
                socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n")
                return
            }
            const target = parseTarget(match.route.target)
            if (target === null) {
                socket.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n")
                return
            }
            forwardUpgrade(req, socket, head, {
                target,
                upstreamPath: `${upstreamPath(match.route, match.rest, url.pathname)}${url.search}`,
                prefix: match.route.prefix,
                remoteAddress: remoteAddressOf(req),
                secure,
                user: config.auth.enabled ? "admin" : null,
                timeoutMs: config.upstreamTimeoutMs,
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
            const host = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host
            return `${secure ? "https" : "http"}://${host}:${actualPort}`
        },
        get secure(): boolean {
            return secure
        },
        get port(): number {
            return actualPort
        },
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
            actualPort = typeof address === "object" && address !== null ? (address as AddressInfo).port : config.port
            pruneTimer = setInterval(() => auth.prune(), PRUNE_INTERVAL_MS)
            pruneTimer.unref()
            logger.info({ url: this.url, routes: config.routes.length, auth: config.auth.enabled }, "网关已启动")
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
    }
}
