/*
 * 网关鉴权
 *
 * 单用户密码：scrypt 哈希存 <插件数据目录>/auth.json
 * 会话 token 只保存在内存，重启后需要重新登录；其他端口的服务通过会话快照校验 token
 */

import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto"

export const AUTH_FILE = "auth.json"
export const SESSION_COOKIE = "wellspring_session"
export const PASSWORD_MIN_LENGTH = 6
export const PASSWORD_MAX_LENGTH = 200
/** 网关单用户身份；转发头与校验接口都用它 */
export const GATEWAY_USER = "admin"

/** 会话 token 的 sha256；会话快照只存哈希，不落原文 */
export function sessionTokenHash(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex")
}

export interface SessionListEntry {
    readonly hash: string
    readonly expiresAt: number
}

const SCRYPT_KEYLEN = 64
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1 } as const

export interface AuthStorage {
    readText(path: string): Promise<string | null>
    writeText(path: string, text: string): Promise<void>
}

export interface AuthFile {
    readonly version: 1
    readonly algorithm: "scrypt"
    readonly salt: string
    readonly hash: string
    readonly keylen: number
    readonly n: number
    readonly r: number
    readonly p: number
    readonly updatedAt: string
}

export interface AuthStoreOptions {
    readonly storage: AuthStorage
    readonly sessionHours: number
    readonly maxAttempts: number
    readonly windowMs: number
    /** 测试注入时钟 */
    readonly now?: () => number
}

export type PasswordProblem = "too-short" | "too-long" | null

export function passwordProblem(password: string): PasswordProblem {
    if (password.length < PASSWORD_MIN_LENGTH) {
        return "too-short"
    }
    if (password.length > PASSWORD_MAX_LENGTH) {
        return "too-long"
    }
    return null
}

function scrypt(password: string, salt: Uint8Array, keylen: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        scryptCallback(
            password,
            salt,
            keylen,
            { N: SCRYPT_OPTIONS.N, r: SCRYPT_OPTIONS.r, p: SCRYPT_OPTIONS.p },
            (error, derived) => {
                if (error) {
                    reject(error)
                    return
                }
                resolve(derived)
            },
        )
    })
}

export async function createAuthFile(password: string, now = Date.now()): Promise<AuthFile> {
    const salt = randomBytes(16)
    const hash = await scrypt(password, salt, SCRYPT_KEYLEN)
    return {
        version: 1,
        algorithm: "scrypt",
        salt: salt.toString("base64"),
        hash: hash.toString("base64"),
        keylen: SCRYPT_KEYLEN,
        n: SCRYPT_OPTIONS.N,
        r: SCRYPT_OPTIONS.r,
        p: SCRYPT_OPTIONS.p,
        updatedAt: new Date(now).toISOString(),
    }
}

export async function verifyAuthFile(password: string, file: AuthFile): Promise<boolean> {
    if (file.algorithm !== "scrypt") {
        return false
    }
    const salt = Buffer.from(file.salt, "base64")
    const expected = Buffer.from(file.hash, "base64")
    if (salt.length === 0 || expected.length === 0) {
        return false
    }
    const derived = await scrypt(password, salt, file.keylen > 0 ? file.keylen : SCRYPT_KEYLEN)
    if (derived.length !== expected.length) {
        return false
    }
    return timingSafeEqual(derived, expected)
}

function isAuthFile(value: unknown): value is AuthFile {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false
    }
    const record = value as Record<string, unknown>
    return (
        record["version"] === 1 &&
        record["algorithm"] === "scrypt" &&
        typeof record["salt"] === "string" &&
        typeof record["hash"] === "string"
    )
}

interface AttemptWindow {
    count: number
    startedAt: number
}

export class AuthStore {
    readonly #storage: AuthStorage
    readonly #sessionMs: number
    readonly #maxAttempts: number
    readonly #windowMs: number
    readonly #now: () => number
    #file: AuthFile | null = null
    readonly #sessions = new Map<string, number>()
    readonly #attempts = new Map<string, AttemptWindow>()

    constructor(options: AuthStoreOptions) {
        this.#storage = options.storage
        this.#sessionMs = options.sessionHours * 60 * 60 * 1000
        this.#maxAttempts = options.maxAttempts
        this.#windowMs = options.windowMs
        this.#now = options.now ?? Date.now
    }

    /** 读取 auth.json；文件缺失或损坏按未设置处理 */
    async load(): Promise<{ ok: boolean; error?: string }> {
        let text: string | null
        try {
            text = await this.#storage.readText(AUTH_FILE)
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
        if (text === null) {
            return { ok: true }
        }
        try {
            const parsed: unknown = JSON.parse(text)
            if (!isAuthFile(parsed)) {
                return { ok: false, error: "auth.json 格式不合法" }
            }
            this.#file = parsed
            return { ok: true }
        } catch (error) {
            return { ok: false, error: `auth.json 解析失败：${String(error)}` }
        }
    }

    get hasPassword(): boolean {
        return this.#file !== null
    }

    async setPassword(password: string): Promise<void> {
        const file = await createAuthFile(password, this.#now())
        await this.#storage.writeText(AUTH_FILE, `${JSON.stringify(file, null, 4)}\n`)
        this.#file = file
        this.#sessions.clear()
    }

    async verifyPassword(password: string): Promise<boolean> {
        const file = this.#file
        if (file === null) {
            return false
        }
        try {
            return await verifyAuthFile(password, file)
        } catch {
            return false
        }
    }

    createSession(): { token: string; expiresAt: number } {
        const token = randomBytes(32).toString("base64url")
        const expiresAt = this.#now() + this.#sessionMs
        this.#sessions.set(token, expiresAt)
        return { token, expiresAt }
    }

    validateSession(token: string | undefined): boolean {
        return this.sessionExpiresAt(token) !== null
    }

    /** 会话过期时间；token 缺失、无效或过期返回 null */
    sessionExpiresAt(token: string | undefined): number | null {
        if (token === undefined || token === "") {
            return null
        }
        const expiresAt = this.#sessions.get(token)
        if (expiresAt === undefined) {
            return null
        }
        if (expiresAt <= this.#now()) {
            this.#sessions.delete(token)
            return null
        }
        return expiresAt
    }

    /** 当前有效会话的哈希与过期时间（跨端口校验用的快照） */
    listSessions(): readonly SessionListEntry[] {
        const now = this.#now()
        const sessions: SessionListEntry[] = []
        for (const [token, expiresAt] of this.#sessions) {
            if (expiresAt <= now) {
                this.#sessions.delete(token)
                continue
            }
            sessions.push({ hash: sessionTokenHash(token), expiresAt })
        }
        sessions.sort(
            (left, right) =>
                left.expiresAt - right.expiresAt || left.hash.localeCompare(right.hash),
        )
        return sessions
    }

    destroySession(token: string | undefined): void {
        if (token !== undefined) {
            this.#sessions.delete(token)
        }
    }

    clearSessions(): void {
        this.#sessions.clear()
    }

    sessionTtlSeconds(): number {
        return Math.floor(this.#sessionMs / 1000)
    }

    /** 窗口内失败次数达到上限即拒绝 */
    isBlocked(key: string): boolean {
        const window = this.#attempts.get(key)
        if (window === undefined) {
            return false
        }
        if (this.#now() - window.startedAt >= this.#windowMs) {
            this.#attempts.delete(key)
            return false
        }
        return window.count >= this.#maxAttempts
    }

    recordFailure(key: string): void {
        const now = this.#now()
        const window = this.#attempts.get(key)
        if (window === undefined || now - window.startedAt >= this.#windowMs) {
            this.#attempts.set(key, { count: 1, startedAt: now })
            return
        }
        window.count += 1
    }

    clearFailures(key: string): void {
        this.#attempts.delete(key)
    }

    /** 清理过期会话与失败窗口 */
    prune(): void {
        const now = this.#now()
        for (const [token, expiresAt] of this.#sessions) {
            if (expiresAt <= now) {
                this.#sessions.delete(token)
            }
        }
        for (const [key, window] of this.#attempts) {
            if (now - window.startedAt >= this.#windowMs) {
                this.#attempts.delete(key)
            }
        }
    }
}
