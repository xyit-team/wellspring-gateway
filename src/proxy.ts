/*
 * 反向代理：HTTP 请求与 WebSocket 升级
 *
 * 网关只转发字节，不解析上游响应；转发头统一由网关生成，客户端传入的
 * x-wellspring-* / x-forwarded-* 一律丢弃
 */

import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http"
import { request as httpsRequest } from "node:https"
import { connect as netConnect, type Socket } from "node:net"
import { connect as tlsConnect } from "node:tls"
import type { Duplex } from "node:stream"

import { SESSION_COOKIE } from "./auth.ts"

const HOP_BY_HOP = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
])

export interface ProxyLogger {
    warn(fields: Record<string, unknown>, message: string): void
}

export interface ForwardOptions {
    readonly target: URL
    readonly upstreamPath: string
    readonly prefix: string
    readonly remoteAddress: string | null
    readonly secure: boolean
    /** 已通过鉴权的用户标识；auth 关闭时为 null */
    readonly user: string | null
    readonly timeoutMs: number
    readonly logger?: ProxyLogger
}

function isPlainHeader(name: string): boolean {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower)) {
        return false
    }
    if (lower.startsWith("x-wellspring-") || lower.startsWith("x-forwarded-")) {
        return false
    }
    return true
}

function cookieValue(headers: IncomingMessage["headers"], name: string): string | undefined {
    const header = headers.cookie
    if (header === undefined) {
        return undefined
    }
    for (const part of header.split(";")) {
        const index = part.indexOf("=")
        if (index === -1) {
            continue
        }
        if (part.slice(0, index).trim() === name) {
            return part.slice(index + 1).trim()
        }
    }
    return undefined
}

export function sessionTokenFrom(headers: IncomingMessage["headers"]): string | undefined {
    return cookieValue(headers, SESSION_COOKIE)
}

function filteredCookie(headers: IncomingMessage["headers"]): string | null {
    const header = headers.cookie
    if (header === undefined) {
        return null
    }
    const kept = header
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part !== "" && !part.startsWith(`${SESSION_COOKIE}=`))
    return kept.length === 0 ? null : kept.join("; ")
}

function forwardedHeaders(req: IncomingMessage, options: ForwardOptions): Record<string, string> {
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined || !isPlainHeader(name)) {
            continue
        }
        headers[name] = Array.isArray(value) ? value.join(", ") : value
    }
    const cookie = filteredCookie(req.headers)
    if (cookie !== null) {
        headers["cookie"] = cookie
    } else {
        delete headers["cookie"]
    }
    headers["x-forwarded-for"] = options.remoteAddress ?? ""
    headers["x-forwarded-proto"] = options.secure ? "https" : "http"
    headers["x-forwarded-host"] = String(req.headers.host ?? "")
    headers["x-forwarded-prefix"] = options.prefix
    headers["x-wellspring-gateway"] = "1"
    if (options.user !== null) {
        headers["x-wellspring-user"] = options.user
    }
    return headers
}

function responseHeaders(headers: IncomingMessage["headers"]): Record<string, string | string[]> {
    const result: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(headers)) {
        if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) {
            continue
        }
        /* set-cookie 需要逐条下发 */
        if (name.toLowerCase() === "set-cookie") {
            result[name] = Array.isArray(value) ? value : [value]
            continue
        }
        result[name] = Array.isArray(value) ? value.join(", ") : value
    }
    return result
}

function upstreamHost(target: URL): string {
    if (target.port !== "") {
        return `${target.hostname}:${target.port}`
    }
    return target.hostname
}

function sendProxyError(res: ServerResponse, status: number, message: string): void {
    if (res.headersSent) {
        res.destroy()
        return
    }
    const body = `${message}\n`
    res.writeHead(status, {
        "content-type": "text/plain; charset=utf-8",
        "content-length": String(Buffer.byteLength(body)),
        "cache-control": "no-store",
    })
    res.end(body)
}

export function forwardRequest(
    req: IncomingMessage,
    res: ServerResponse,
    options: ForwardOptions,
): Promise<void> {
    return new Promise((resolve) => {
        let settled = false
        let timedOut = false
        const finish = (): void => {
            if (settled) {
                return
            }
            settled = true
            resolve()
        }

        const requestFn = options.target.protocol === "https:" ? httpsRequest : httpRequest
        const upstream = requestFn({
            protocol: options.target.protocol,
            hostname: options.target.hostname,
            port: options.target.port === "" ? undefined : Number(options.target.port),
            method: req.method,
            path: options.upstreamPath,
            headers: forwardedHeaders(req, options),
        })

        if (options.timeoutMs > 0) {
            upstream.setTimeout(options.timeoutMs, () => {
                timedOut = true
                upstream.destroy(new Error("upstream timeout"))
            })
        }

        upstream.on("response", (response) => {
            res.writeHead(response.statusCode ?? 502, response.statusMessage, responseHeaders(response.headers))
            response.pipe(res)
            response.on("end", finish)
            response.on("error", (error) => {
                options.logger?.warn({ error: String(error) }, "上游响应中断")
                res.destroy()
                finish()
            })
        })

        upstream.on("error", (error) => {
            options.logger?.warn(
                { error: error instanceof Error ? error.message : String(error), target: options.target.href },
                "上游请求失败",
            )
            if (timedOut) {
                sendProxyError(res, 504, "上游超时")
            } else {
                sendProxyError(res, 502, "上游服务不可用")
            }
            finish()
        })

        res.on("close", () => {
            if (!res.writableEnded) {
                upstream.destroy()
            }
            finish()
        })

        req.pipe(upstream)
    })
}

/** WebSocket / 其它 Upgrade 请求：原样转发字节流 */
export function forwardUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    options: ForwardOptions,
): void {
    const secure = options.target.protocol === "https:"
    const port = options.target.port === "" ? (secure ? 443 : 80) : Number(options.target.port)
    const headers = forwardedHeaders(req, options)
    const upgrade = req.headers.upgrade ?? "websocket"
    const lines = [
        `${req.method ?? "GET"} ${options.upstreamPath} HTTP/1.1`,
        `host: ${upstreamHost(options.target)}`,
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        "connection: Upgrade",
        `upgrade: ${upgrade}`,
    ]

    const connect = secure
        ? (callback: () => void) =>
              tlsConnect(
                  {
                      host: options.target.hostname,
                      port,
                      servername: options.target.hostname,
                      rejectUnauthorized: false,
                  },
                  callback,
              )
        : (callback: () => void) => netConnect({ host: options.target.hostname, port }, callback)

    const upstream: Socket = connect(() => {
        upstream.write(`${lines.join("\r\n")}\r\n\r\n`)
        if (head.length > 0) {
            upstream.write(head)
        }
        socket.pipe(upstream).pipe(socket)
    })

    const fail = (message: string): void => {
        options.logger?.warn({ error: message, target: options.target.href }, "上游升级失败")
        upstream.destroy()
        socket.destroy()
    }
    upstream.on("error", (error) => fail(error instanceof Error ? error.message : String(error)))
    socket.on("error", () => upstream.destroy())
    socket.on("close", () => upstream.destroy())
    upstream.on("close", () => socket.destroy())
}
