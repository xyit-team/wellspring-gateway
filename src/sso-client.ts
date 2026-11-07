/*
 * 跨端口单点登录客户端助手
 *
 * 网关在 127.0.0.1 上挂 host-only 会话 cookie；其它 loopback 端口的插件
 * 通过本文件校验会话。文件只依赖 node:crypto，可整份复制到其他 wellspring 插件
 *
 * 校验方式二选一，见 createSsoClient：
 * - 本地：读网关写出的 sessions.json 快照，不产生网络请求
 * - HTTP：GET <gatewayUrl>/__gateway/auth/verify
 */

import { createHash } from "node:crypto"

export const SSO_COOKIE_NAME = "wellspring_session"
export const SSO_VERIFY_PATH = "/__gateway/auth/verify"
export const SSO_LOGIN_PATH = "/login"
export const SSO_LOGOUT_PATH = "/logout"
export const SSO_DISCOVERY_FILE = "sso.json"
export const SSO_SESSIONS_FILE = "sessions.json"

const DEFAULT_TIMEOUT_MS = 3000
const DEFAULT_CACHE_TTL_MS = 0

export type SsoHeaders = Record<string, string | string[] | undefined>

export interface SsoSession {
    readonly ok: true
    /** 网关未启用鉴权时为 null */
    readonly user: string | null
    /** 会话过期毫秒时间戳；未知或未启用鉴权时为 null */
    readonly expiresAt: number | null
}

export type SsoFailureReason = "missing" | "invalid" | "unreachable"

export interface SsoFailure {
    readonly ok: false
    readonly reason: SsoFailureReason
}

export type SsoResult = SsoSession | SsoFailure

export interface SsoDiscovery {
    readonly version: number
    readonly url: string
    readonly authEnabled: boolean
    readonly cookieName: string
    readonly loginPath: string
    readonly logoutPath: string
    readonly verifyPath: string
    readonly sessionsFile: string
    readonly updatedAt?: string
}

export interface SsoDiscoveryReader {
    readJson<T = unknown>(path: string): Promise<T | null>
}

export interface SsoClientOptions {
    /** 网关对外地址，例如 http://127.0.0.1:8780 */
    readonly gatewayUrl: string
    /** 网关是否启用鉴权（sso.json 的 authEnabled）；false 时所有请求直接放行，默认 true */
    readonly authEnabled?: boolean
    readonly cookieName?: string
    readonly loginPath?: string
    readonly verifyPath?: string
    /** 本地校验会话快照的读取器（插件里通常传 api.pluginData("wellspring-gateway") 的 readJson）；提供后不走 HTTP */
    readonly sessions?: () => Promise<unknown>
    /** 校验结果缓存毫秒；0 不缓存（默认 0） */
    readonly cacheTtlMs?: number
    /** HTTP 校验超时毫秒，默认 3000 */
    readonly timeoutMs?: number
    readonly fetch?: typeof fetch
}

export interface SsoHttpResponse {
    readonly status: number
    readonly headers: Record<string, string>
    readonly body: string
}

export interface SsoClient {
    readonly gatewayUrl: string
    readonly cookieName: string
    readonly authEnabled: boolean
    sessionToken(headers: SsoHeaders): string | null
    verify(headers: SsoHeaders): Promise<SsoResult>
    loginUrl(returnUrl?: string): string
    redirectToLogin(returnUrl: string): SsoHttpResponse
    unauthorized(): SsoHttpResponse
    reset(): void
}

interface CachedSession {
    readonly result: SsoSession
    readonly checkedAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** 取非空字符串（去掉首尾空白）；其它类型与空串返回 null */
function textValue(value: unknown): string | null {
    if (typeof value !== "string") {
        return null
    }
    const trimmed = value.trim()
    return trimmed === "" ? null : trimmed
}

/** 头名先按原样查，再大小写不敏感兜底；Node 的 IncomingMessage 头名已是小写 */
function lookupHeader(headers: SsoHeaders, name: string): string | string[] | undefined {
    const direct = headers[name]
    if (direct !== undefined) {
        return direct
    }
    const lowered = name.toLowerCase()
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === lowered) {
            return value
        }
    }
    return undefined
}

function headerText(value: string | string[] | undefined, separator: string): string | undefined {
    if (value === undefined) {
        return undefined
    }
    return Array.isArray(value) ? value.join(separator) : value
}

/** cookie 名精确匹配、值取第一个 = 之后的内容（不 decode） */
export function sessionTokenOf(headers: SsoHeaders, cookieName?: string): string | null {
    const name = cookieName ?? SSO_COOKIE_NAME
    const header = headerText(lookupHeader(headers, "cookie"), "; ")
    if (header === undefined) {
        return null
    }
    for (const rawPart of header.split(";")) {
        const part = rawPart.trim()
        const index = part.indexOf("=")
        if (index === -1) {
            continue
        }
        if (part.slice(0, index).trim() !== name) {
            continue
        }
        const value = part.slice(index + 1)
        return value === "" ? null : value
    }
    return null
}

export function acceptsHtml(headers: SsoHeaders): boolean {
    const header = headerText(lookupHeader(headers, "accept"), ",")
    if (header === undefined) {
        return false
    }
    return header.includes("text/html") || header.includes("*/*")
}

export function sha256Hex(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex")
}

/** 快照格式 { version: 1, updatedAt, sessions: [{ hash, expiresAt }] }，hash 是 sha256Hex(token) */
export type SsoSnapshotLookup =
    | { readonly state: "found"; readonly expiresAt: number }
    | { readonly state: "missing" }
    | { readonly state: "malformed" }

export function lookupSessionInSnapshot(
    snapshot: unknown,
    token: string,
    now?: number,
): SsoSnapshotLookup {
    if (!isRecord(snapshot)) {
        return { state: "malformed" }
    }
    const sessions = snapshot["sessions"]
    if (!Array.isArray(sessions)) {
        return { state: "malformed" }
    }
    const timestamp = now ?? Date.now()
    const hash = sha256Hex(token)
    for (const entry of sessions) {
        if (!isRecord(entry)) {
            continue
        }
        const entryHash = entry["hash"]
        const expiresAt = entry["expiresAt"]
        if (typeof entryHash !== "string" || typeof expiresAt !== "number") {
            continue
        }
        if (entryHash === hash && expiresAt > timestamp) {
            return { state: "found", expiresAt }
        }
    }
    return { state: "missing" }
}

export function readSsoDiscovery(
    reader: SsoDiscoveryReader | null | undefined,
    path?: string,
): Promise<SsoDiscovery | null> {
    if (reader === null || reader === undefined) {
        return Promise.resolve(null)
    }
    return readSsoDiscoveryFile(reader, path ?? SSO_DISCOVERY_FILE)
}

async function readSsoDiscoveryFile(
    reader: SsoDiscoveryReader,
    path: string,
): Promise<SsoDiscovery | null> {
    try {
        const raw: unknown = await reader.readJson(path)
        if (!isRecord(raw)) {
            return null
        }
        const url = textValue(raw["url"])
        if (url === null) {
            return null
        }
        const version = raw["version"]
        const authEnabled = raw["authEnabled"]
        return {
            version: typeof version === "number" ? version : 1,
            url,
            authEnabled: typeof authEnabled === "boolean" ? authEnabled : true,
            cookieName: textValue(raw["cookieName"]) ?? SSO_COOKIE_NAME,
            loginPath: textValue(raw["loginPath"]) ?? SSO_LOGIN_PATH,
            logoutPath: textValue(raw["logoutPath"]) ?? SSO_LOGOUT_PATH,
            verifyPath: textValue(raw["verifyPath"]) ?? SSO_VERIFY_PATH,
            sessionsFile: textValue(raw["sessionsFile"]) ?? SSO_SESSIONS_FILE,
            ...(typeof raw["updatedAt"] === "string" ? { updatedAt: raw["updatedAt"] } : {}),
        }
    } catch {
        return null
    }
}

function normalizeGatewayUrl(value: string): string {
    const trimmed = value.trim()
    let parsed: URL
    try {
        parsed = new URL(trimmed)
    } catch {
        throw new Error("gatewayUrl 不合法")
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("gatewayUrl 不合法")
    }
    return trimmed.replace(/\/+$/u, "")
}

export function createSsoClient(options: SsoClientOptions): SsoClient {
    const gatewayUrl = normalizeGatewayUrl(options.gatewayUrl)
    const authEnabled = options.authEnabled ?? true
    const cookieName = textValue(options.cookieName) ?? SSO_COOKIE_NAME
    const loginPath = textValue(options.loginPath) ?? SSO_LOGIN_PATH
    const verifyPath = textValue(options.verifyPath) ?? SSO_VERIFY_PATH
    const cacheTtlMs = Math.max(0, options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS)
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const fetchImpl: typeof fetch =
        options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    const cache = new Map<string, CachedSession>()

    /** 本地模式：快照里查到未过期会话即通过；网关是单用户，用户固定为 admin */
    async function verifyWithSnapshot(token: string, now: number): Promise<SsoResult> {
        const sessions = options.sessions
        if (sessions === undefined) {
            return { ok: false, reason: "unreachable" }
        }
        let snapshot: unknown
        try {
            snapshot = await sessions()
        } catch {
            return { ok: false, reason: "unreachable" }
        }
        if (snapshot === null || snapshot === undefined) {
            return { ok: false, reason: "unreachable" }
        }
        const lookup = lookupSessionInSnapshot(snapshot, token, now)
        if (lookup.state === "malformed") {
            return { ok: false, reason: "unreachable" }
        }
        if (lookup.state === "missing") {
            return { ok: false, reason: "invalid" }
        }
        return { ok: true, user: "admin", expiresAt: lookup.expiresAt }
    }

    /** HTTP 模式：网关校验接口只认 cookie，返回 JSON 结果 */
    async function verifyOverHttp(token: string): Promise<SsoResult> {
        let response: Response
        try {
            response = await fetchImpl(`${gatewayUrl}${verifyPath}`, {
                method: "GET",
                headers: {
                    accept: "application/json",
                    cookie: `${cookieName}=${token}`,
                    "cache-control": "no-store",
                },
                redirect: "manual",
                signal: AbortSignal.timeout(timeoutMs),
            })
        } catch {
            return { ok: false, reason: "unreachable" }
        }
        if (response.status === 401 || response.status === 403) {
            return { ok: false, reason: "invalid" }
        }
        if (response.status !== 200) {
            return { ok: false, reason: "unreachable" }
        }
        let body: unknown
        try {
            body = JSON.parse(await response.text())
        } catch {
            return { ok: false, reason: "unreachable" }
        }
        if (!isRecord(body) || body["ok"] !== true) {
            return { ok: false, reason: "unreachable" }
        }
        const user = body["user"]
        const expiresAt = body["expiresAt"]
        return {
            ok: true,
            user: typeof user === "string" ? user : null,
            expiresAt: typeof expiresAt === "number" ? expiresAt : null,
        }
    }

    function sessionToken(headers: SsoHeaders): string | null {
        return sessionTokenOf(headers, cookieName)
    }

    async function verify(headers: SsoHeaders): Promise<SsoResult> {
        if (!authEnabled) {
            return { ok: true, user: null, expiresAt: null }
        }
        const token = sessionTokenOf(headers, cookieName)
        if (token === null) {
            return { ok: false, reason: "missing" }
        }
        const now = Date.now()
        if (cacheTtlMs > 0) {
            const cached = cache.get(token)
            if (cached !== undefined) {
                const fresh = now - cached.checkedAt < cacheTtlMs
                const alive = cached.result.expiresAt === null || cached.result.expiresAt > now
                if (fresh && alive) {
                    return cached.result
                }
                cache.delete(token)
            }
        }
        const result =
            options.sessions === undefined
                ? await verifyOverHttp(token)
                : await verifyWithSnapshot(token, now)
        if (result.ok && cacheTtlMs > 0) {
            cache.set(token, { result, checkedAt: now })
        }
        return result
    }

    function loginUrl(returnUrl?: string): string {
        const login = `${gatewayUrl}${loginPath}`
        if (returnUrl === undefined || returnUrl === "") {
            return login
        }
        return `${login}?redirect=${encodeURIComponent(returnUrl)}`
    }

    function redirectToLogin(returnUrl: string): SsoHttpResponse {
        return {
            status: 302,
            headers: {
                location: loginUrl(returnUrl),
                "cache-control": "no-store",
            },
            body: "",
        }
    }

    function unauthorized(): SsoHttpResponse {
        return {
            status: 401,
            headers: {
                "content-type": "application/json; charset=utf-8",
                "cache-control": "no-store",
            },
            body: '{"error":"unauthorized"}',
        }
    }

    function reset(): void {
        cache.clear()
    }

    return {
        gatewayUrl,
        cookieName,
        authEnabled,
        sessionToken,
        verify,
        loginUrl,
        redirectToLogin,
        unauthorized,
        reset,
    }
}
