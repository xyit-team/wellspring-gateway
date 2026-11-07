/*
 * 跨端口单点登录
 *
 * 会话 cookie 不带 Domain（host-only）：浏览器对同一主机的所有端口都会带上它，
 * 其他 loopback 端口的服务据此校验会话，未登录时跳回网关登录页并带原始地址
 *
 * 本模块只放纯函数与数据结构：主机名解析、next 回跳校验、CORS 头、会话快照与发现文件
 * 会话 cookie 由 server.ts 下发，会话快照由 server.ts 落盘，其他插件按 README 的接入说明读
 */

export const SSO_VERIFY_PATH = "/__gateway/auth/verify"
export const SSO_LOGIN_PATH = "/login"
export const SSO_LOGOUT_PATH = "/logout"
export const SSO_DISCOVERY_FILE = "sso.json"
export const SSO_SESSIONS_FILE = "sessions.json"
export const SSO_VERSION = 1

const INVALID_HOST_CHARS = /[\s/\\?#@]/
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
const SAFE_HEADER_LIST = /^[A-Za-z0-9 ,_-]{1,200}$/

/** 会话快照条目：只存 token 的 sha256，原文不落盘 */
export interface SessionSnapshotEntry {
    readonly hash: string
    readonly expiresAt: number
}

export interface SessionSnapshot {
    readonly version: typeof SSO_VERSION
    readonly updatedAt: string
    readonly sessions: readonly SessionSnapshotEntry[]
}

/** 网关写进插件数据目录的 sso.json，供其他插件发现地址与路径 */
export interface SsoDiscovery {
    readonly version: typeof SSO_VERSION
    readonly url: string
    readonly authEnabled: boolean
    readonly cookieName: string
    readonly loginPath: string
    readonly logoutPath: string
    readonly verifyPath: string
    readonly sessionsFile: string
    readonly updatedAt: string
}

/** 一次请求的回跳上下文：协议与当前 Host 的主机名 */
export interface RedirectContext {
    readonly protocol: "http:" | "https:"
    /** 当前请求 Host 的主机名；Host 头缺失或非法时为 null */
    readonly hostname: string | null
}

/** 解析主机名：接受 localhost、127.0.0.1:8780、[::1]:8780、::1，返回小写主机名 */
export function normalizeHostName(value: string): string | null {
    const trimmed = value.trim().toLowerCase()
    if (trimmed === "" || INVALID_HOST_CHARS.test(trimmed)) {
        return null
    }
    const candidates =
        trimmed.includes(":") && !trimmed.startsWith("[") ? [trimmed, `[${trimmed}]`] : [trimmed]
    for (const candidate of candidates) {
        try {
            const hostname = new URL(`http://${candidate}`).hostname.toLowerCase()
            if (hostname !== "") {
                return hostname
            }
        } catch {
            /* 换一种写法再试 */
        }
    }
    return null
}

export function requestProtocol(secure: boolean): "http:" | "https:" {
    return secure ? "https:" : "http:"
}

/** 拼接 URL 时给 IPv6 字面量补方括号 */
export function formatHostForUrl(host: string): string {
    if (host.startsWith("[")) {
        return host
    }
    return host.includes(":") ? `[${host}]` : host
}

export function redirectContextOf(hostHeader: string | undefined, secure: boolean): RedirectContext {
    return {
        protocol: requestProtocol(secure),
        hostname: hostHeader === undefined ? null : normalizeHostName(hostHeader),
    }
}

/** 规范化 Origin；协议或主机不一致时返回 null（端口不参与比较） */
export function allowedOrigin(
    origin: string | undefined,
    context: RedirectContext,
): string | null {
    if (origin === undefined || origin === "") {
        return null
    }
    let parsed: URL
    try {
        parsed = new URL(origin)
    } catch {
        return null
    }
    if (parsed.protocol !== context.protocol) {
        return null
    }
    if (context.hostname === null || parsed.hostname.toLowerCase() !== context.hostname) {
        return null
    }
    return parsed.origin
}

export function originAllowed(origin: string | undefined, context: RedirectContext): boolean {
    return allowedOrigin(origin, context) !== null
}

/** 校验接口的 CORS 头；来源不允许时返回空对象 */
export function corsHeaders(
    origin: string | undefined,
    context: RedirectContext,
): Record<string, string> {
    const allowed = allowedOrigin(origin, context)
    if (allowed === null) {
        return {}
    }
    return {
        "access-control-allow-origin": allowed,
        "access-control-allow-credentials": "true",
        vary: "origin",
    }
}

/** 预检响应头；来源不允许时为空对象 */
export function preflightHeaders(
    origin: string | undefined,
    context: RedirectContext,
    requestedHeaders?: string,
): Record<string, string> {
    const headers = corsHeaders(origin, context)
    if (Object.keys(headers).length === 0) {
        return headers
    }
    headers["access-control-allow-methods"] = "GET, HEAD, OPTIONS"
    headers["access-control-allow-headers"] =
        requestedHeaders !== undefined && SAFE_HEADER_LIST.test(requestedHeaders)
            ? requestedHeaders
            : "content-type"
    headers["access-control-max-age"] = "600"
    return headers
}

/** 登录后的回跳目标：站内相对路径，或同主机（任意端口）同协议的绝对地址 */
export function resolveNext(raw: string | null | undefined, context: RedirectContext): string {
    if (typeof raw !== "string" || raw === "" || raw.includes("\\")) {
        return "/"
    }
    if (CONTROL_CHARS.test(raw)) {
        return "/"
    }
    if (raw.startsWith("/")) {
        /* 协议相对地址（//host）是开放重定向，一律拒绝 */
        if (raw.startsWith("//")) {
            return "/"
        }
        return raw
    }
    let target: URL
    try {
        target = new URL(raw)
    } catch {
        return "/"
    }
    if (target.protocol !== context.protocol) {
        return "/"
    }
    if (target.username !== "" || target.password !== "") {
        return "/"
    }
    if (context.hostname === null || target.hostname.toLowerCase() !== context.hostname) {
        return "/"
    }
    return target.href
}

export function sessionSnapshotJson(
    sessions: readonly SessionSnapshotEntry[],
    now = new Date(),
): string {
    const snapshot: SessionSnapshot = {
        version: SSO_VERSION,
        updatedAt: now.toISOString(),
        sessions: [...sessions],
    }
    return `${JSON.stringify(snapshot, null, 4)}\n`
}

export interface SsoDiscoveryInput {
    readonly url: string
    readonly authEnabled: boolean
    readonly cookieName: string
    readonly now?: Date
}

export function buildSsoDiscovery(input: SsoDiscoveryInput): SsoDiscovery {
    return {
        version: SSO_VERSION,
        url: input.url,
        authEnabled: input.authEnabled,
        cookieName: input.cookieName,
        loginPath: SSO_LOGIN_PATH,
        logoutPath: SSO_LOGOUT_PATH,
        verifyPath: SSO_VERIFY_PATH,
        sessionsFile: SSO_SESSIONS_FILE,
        updatedAt: (input.now ?? new Date()).toISOString(),
    }
}

export function discoveryJson(input: SsoDiscoveryInput): string {
    return `${JSON.stringify(buildSsoDiscovery(input), null, 4)}\n`
}
