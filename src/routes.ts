/*
 * 路由表：静态配置 + 插件运行时注册
 *
 * 同名注册覆盖上一条；前缀不能与静态配置或其它注册方冲突
 */

import {
    normalizeRoutePrefix,
    parseTarget,
    type RouteConfig,
} from "./config.ts"
import type { GatewayRegistration } from "./protocol.ts"

export interface RouteEntry {
    readonly config: RouteConfig
    readonly source: "config" | "plugin"
    /** 注册方标识；静态配置为 null */
    readonly name: string | null
}

export type AddUpstreamResult =
    | { readonly ok: true; readonly entry: RouteEntry; readonly replaced: boolean }
    | { readonly ok: false; readonly error: string }

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function parseRegistration(value: unknown): GatewayRegistration | string {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return "注册负载必须是对象"
    }
    const input = value as Record<string, unknown>
    const name = typeof input["name"] === "string" ? input["name"].trim() : ""
    if (!NAME_PATTERN.test(name)) {
        return `注册方名称不合法：${String(input["name"])}`
    }
    const rawPrefix = typeof input["prefix"] === "string" ? input["prefix"].trim() : ""
    const prefix = normalizeRoutePrefix(rawPrefix)
    if (prefix === null) {
        return `前缀不合法：${String(input["prefix"])}`
    }
    const rawTarget = typeof input["target"] === "string" ? input["target"].trim() : ""
    if (parseTarget(rawTarget) === null) {
        return `上游地址不合法：${String(input["target"])}`
    }
    const stripPrefix = input["stripPrefix"]
    if (stripPrefix !== undefined && typeof stripPrefix !== "boolean") {
        return "stripPrefix 不是布尔值"
    }
    const isPublic = input["public"]
    if (isPublic !== undefined && typeof isPublic !== "boolean") {
        return "public 不是布尔值"
    }
    const timeoutMs = input["timeoutMs"]
    if (
        timeoutMs !== undefined &&
        (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0)
    ) {
        return "timeoutMs 必须是正整数"
    }
    const registration: GatewayRegistration = {
        name,
        prefix,
        target: rawTarget,
        ...(typeof stripPrefix === "boolean" ? { stripPrefix } : {}),
        ...(typeof isPublic === "boolean" ? { public: isPublic } : {}),
        ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
    }
    return registration
}

export class RouteTable {
    readonly #static: RouteEntry[]
    readonly #dynamic = new Map<string, RouteEntry>()

    constructor(routes: readonly RouteConfig[]) {
        this.#static = routes.map((config) => ({ config, source: "config", name: null }))
    }

    list(): RouteEntry[] {
        return [...this.#static, ...this.#dynamic.values()]
    }

    add(value: unknown): AddUpstreamResult {
        const parsed = parseRegistration(value)
        if (typeof parsed === "string") {
            return { ok: false, error: parsed }
        }
        const staticConflict = this.#static.find((entry) => entry.config.prefix === parsed.prefix)
        if (staticConflict !== undefined) {
            return { ok: false, error: `前缀已被配置占用：${parsed.prefix}` }
        }
        for (const [name, entry] of this.#dynamic) {
            if (name !== parsed.name && entry.config.prefix === parsed.prefix) {
                return { ok: false, error: `前缀已被插件占用：${parsed.prefix}` }
            }
        }
        const replaced = this.#dynamic.has(parsed.name)
        const config: RouteConfig = {
            prefix: parsed.prefix,
            target: parsed.target,
            stripPrefix: parsed.stripPrefix ?? true,
            public: parsed.public ?? false,
            timeoutMs: parsed.timeoutMs ?? null,
        }
        const entry: RouteEntry = { config, source: "plugin", name: parsed.name }
        this.#dynamic.set(parsed.name, entry)
        return { ok: true, entry, replaced }
    }

    remove(name: string): boolean {
        return this.#dynamic.delete(name)
    }

    match(pathname: string): { entry: RouteEntry; rest: string } | null {
        let best: { entry: RouteEntry; rest: string } | null = null
        for (const entry of this.list()) {
            const { prefix } = entry.config
            if (prefix === "/") {
                if (best === null) {
                    best = { entry, rest: pathname }
                }
                continue
            }
            if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) {
                continue
            }
            const rest = pathname.slice(prefix.length) || "/"
            if (best === null || prefix.length > best.entry.config.prefix.length) {
                best = { entry, rest }
            }
        }
        return best
    }
}
