/*
 * 网关配置
 *
 * 配置文件：<configDir>/plugins/wellspring-gateway.json
 * 路由按前缀最长匹配；自有端点占用 /login、/logout、/__gateway/* 命名空间
 */

export interface RouteConfig {
    /** 外部路径前缀，以 / 开头；"/" 为兜底 */
    readonly prefix: string
    /** 上游地址：http://127.0.0.1:8787 */
    readonly target: string
    /** 转发前去掉前缀，默认 true */
    readonly stripPrefix: boolean
    /** 免登录路由，默认 false */
    readonly public: boolean
    /** 该路由的上游空闲超时；缺省用全局配置 */
    readonly timeoutMs: number | null
}

export interface TlsConfig {
    /** 相对插件数据目录的证书路径 */
    readonly certFile: string
    /** 相对插件数据目录的私钥路径 */
    readonly keyFile: string
}

export interface AuthConfig {
    readonly enabled: boolean
    /** 会话有效期（小时） */
    readonly sessionHours: number
    /** 窗口内允许的失败次数 */
    readonly maxAttempts: number
    /** 失败计数窗口（毫秒） */
    readonly windowMs: number
}

export interface GatewayConfig {
    readonly host: string
    readonly port: number
    readonly tls: TlsConfig | null
    readonly routes: readonly RouteConfig[]
    readonly auth: AuthConfig
    /** 上游空闲超时（毫秒），0 表示不设上限 */
    readonly upstreamTimeoutMs: number
    readonly accessLog: boolean
}

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
    host: "127.0.0.1",
    port: 8780,
    tls: null,
    routes: [],
    auth: {
        enabled: true,
        sessionHours: 24 * 7,
        maxAttempts: 5,
        windowMs: 60_000,
    },
    upstreamTimeoutMs: 120_000,
    accessLog: true,
}

export interface ParsedConfig {
    readonly config: GatewayConfig
    /** 被忽略或纠正的字段说明，init 时打 warning */
    readonly warnings: readonly string[]
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringField(value: unknown): string | null {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null
}

function integerField(value: unknown, min: number, max: number): number | null {
    return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
        ? value
        : null
}

export function normalizeRoutePrefix(value: string): string | null {
    if (!value.startsWith("/")) {
        return null
    }
    if (value === "/") {
        return "/"
    }
    return value.replace(/\/+$/, "")
}

export function parseTarget(value: string): URL | null {
    try {
        const url = new URL(value)
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return null
        }
        if (url.hostname === "") {
            return null
        }
        return url
    } catch {
        return null
    }
}

function parseRoutes(value: unknown, warnings: string[]): readonly RouteConfig[] {
    if (value === undefined) {
        return []
    }
    if (!Array.isArray(value)) {
        warnings.push("routes 不是数组")
        return []
    }
    const routes: RouteConfig[] = []
    for (const [index, item] of value.entries()) {
        if (!isObject(item)) {
            warnings.push(`routes[${index}] 不是对象`)
            continue
        }
        const rawPrefix = stringField(item["prefix"])
        const rawTarget = stringField(item["target"])
        if (rawPrefix === null) {
            warnings.push(`routes[${index}].prefix 缺失`)
            continue
        }
        const prefix = normalizeRoutePrefix(rawPrefix)
        if (prefix === null) {
            warnings.push(`routes[${index}].prefix 必须以 / 开头：${rawPrefix}`)
            continue
        }
        if (rawTarget === null || parseTarget(rawTarget) === null) {
            warnings.push(`routes[${index}].target 不是 http(s) 地址：${rawTarget ?? ""}`)
            continue
        }
        const stripPrefix = item["stripPrefix"] === undefined ? true : item["stripPrefix"]
        if (typeof stripPrefix !== "boolean") {
            warnings.push(`routes[${index}].stripPrefix 不是布尔值`)
            continue
        }
        const rawPublic = item["public"]
        const isPublic = rawPublic === undefined || rawPublic === null ? false : rawPublic
        if (typeof isPublic !== "boolean") {
            warnings.push(`routes[${index}].public 不是布尔值`)
            continue
        }
        const rawTimeout = item["timeoutMs"]
        const timeoutMs =
            rawTimeout === undefined || rawTimeout === null
                ? null
                : integerField(rawTimeout, 1, 24 * 60 * 60 * 1000)
        if (rawTimeout !== undefined && rawTimeout !== null && timeoutMs === null) {
            warnings.push(`routes[${index}].timeoutMs 不合法`)
            continue
        }
        routes.push({ prefix, target: rawTarget, stripPrefix, public: isPublic, timeoutMs })
    }
    return routes
}

function parseAuth(value: unknown, warnings: string[]): AuthConfig {
    const defaults = DEFAULT_GATEWAY_CONFIG.auth
    if (value === undefined) {
        return defaults
    }
    if (!isObject(value)) {
        warnings.push("auth 不是对象")
        return defaults
    }
    const enabled = value["enabled"]
    if (enabled !== undefined && typeof enabled !== "boolean") {
        warnings.push("auth.enabled 不是布尔值")
    }
    const sessionHours = integerField(value["sessionHours"], 1, 24 * 365)
    const maxAttempts = integerField(value["maxAttempts"], 1, 1000)
    const windowMs = integerField(value["windowMs"], 1_000, 24 * 60 * 60 * 1000)
    return {
        enabled: typeof enabled === "boolean" ? enabled : defaults.enabled,
        sessionHours: sessionHours ?? defaults.sessionHours,
        maxAttempts: maxAttempts ?? defaults.maxAttempts,
        windowMs: windowMs ?? defaults.windowMs,
    }
}

function parseTls(value: unknown, warnings: string[]): TlsConfig | null {
    if (value === undefined || value === null) {
        return null
    }
    if (!isObject(value)) {
        warnings.push("tls 不是对象")
        return null
    }
    const certFile = stringField(value["certFile"])
    const keyFile = stringField(value["keyFile"])
    if (certFile === null || keyFile === null) {
        warnings.push("tls 需要 certFile 与 keyFile")
        return null
    }
    return { certFile, keyFile }
}

export function parseGatewayConfig(raw: unknown): ParsedConfig {
    if (raw !== undefined && !isObject(raw)) {
        return { config: DEFAULT_GATEWAY_CONFIG, warnings: ["插件配置不是对象"] }
    }
    const input = isObject(raw) ? raw : {}
    const warnings: string[] = []
    const defaults = DEFAULT_GATEWAY_CONFIG

    const rawHost = stringField(input["host"])
    const hostValid = rawHost !== null && !/\s/.test(rawHost)
    if (input["host"] !== undefined && !hostValid) {
        warnings.push(`host 不合法：${String(input["host"])}`)
    }
    const host = hostValid ? rawHost : defaults.host
    const port = integerField(input["port"], 0, 65_535)
    if (input["port"] !== undefined && port === null) {
        warnings.push(`port 不合法：${String(input["port"])}`)
    }
    const upstreamTimeoutMs = integerField(input["upstreamTimeoutMs"], 0, 24 * 60 * 60 * 1000)
    if (input["upstreamTimeoutMs"] !== undefined && upstreamTimeoutMs === null) {
        warnings.push(`upstreamTimeoutMs 不合法：${String(input["upstreamTimeoutMs"])}`)
    }
    const accessLog = input["accessLog"]
    if (accessLog !== undefined && typeof accessLog !== "boolean") {
        warnings.push("accessLog 不是布尔值")
    }

    return {
        config: {
            host: host ?? defaults.host,
            port: port ?? defaults.port,
            tls: parseTls(input["tls"], warnings),
            routes: parseRoutes(input["routes"], warnings),
            auth: parseAuth(input["auth"], warnings),
            upstreamTimeoutMs: upstreamTimeoutMs ?? defaults.upstreamTimeoutMs,
            accessLog: typeof accessLog === "boolean" ? accessLog : defaults.accessLog,
        },
        warnings,
    }
}

export interface RouteMatch {
    readonly route: RouteConfig
    /** 去掉前缀后的剩余路径，以 / 开头 */
    readonly rest: string
}

/** 前缀最长匹配；前缀与路径按段边界比较 */
export function matchRoute(
    routes: readonly RouteConfig[],
    pathname: string,
): RouteMatch | null {
    let best: RouteMatch | null = null
    for (const route of routes) {
        const { prefix } = route
        if (prefix === "/") {
            if (best === null || best.route.prefix.length < 1) {
                best = { route, rest: pathname }
            }
            continue
        }
        if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) {
            continue
        }
        const rest = pathname.slice(prefix.length) || "/"
        if (best === null || route.prefix.length > best.route.prefix.length) {
            best = { route, rest }
        }
    }
    return best
}

/** 上游请求路径：stripPrefix 时用剩余路径，否则保留原始路径 */
export function upstreamPath(route: RouteConfig, rest: string, original: string): string {
    const path = route.stripPrefix ? rest : original
    return path.startsWith("/") ? path : `/${path}`
}
