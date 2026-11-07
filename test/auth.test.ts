import assert from "node:assert/strict"
import { test } from "node:test"

import {
    AUTH_FILE,
    AuthStore,
    createAuthFile,
    passwordProblem,
    sessionTokenHash,
    verifyAuthFile,
} from "../src/auth.ts"

function memoryStorage(): {
    files: Map<string, string>
    readText(path: string): Promise<string | null>
    writeText(path: string, text: string): Promise<void>
} {
    const files = new Map<string, string>()
    return {
        files,
        readText: async (path) => files.get(path) ?? null,
        writeText: async (path, text) => {
            files.set(path, text)
        },
    }
}

function store(
    storage = memoryStorage(),
    options: { now?: () => number } = {},
): { store: AuthStore; storage: ReturnType<typeof memoryStorage> } {
    return {
        store: new AuthStore({
            storage,
            sessionHours: 1,
            maxAttempts: 3,
            windowMs: 60_000,
            ...options,
        }),
        storage,
    }
}

test("密码长度 6–200", () => {
    assert.equal(passwordProblem("12345"), "too-short")
    assert.equal(passwordProblem("123456"), null)
    assert.equal(passwordProblem("x".repeat(200)), null)
    assert.equal(passwordProblem("x".repeat(201)), "too-long")
})

test("scrypt 哈希写入与校验", async () => {
    const file = await createAuthFile("secret123", 0)
    assert.equal(file.algorithm, "scrypt")
    assert.equal(await verifyAuthFile("secret123", file), true)
    assert.equal(await verifyAuthFile("wrong", file), false)
    const serialized = JSON.parse(JSON.stringify(file)) as typeof file
    assert.equal(await verifyAuthFile("secret123", serialized), true)
})

test("AuthStore：设置密码、持久化与加载", async () => {
    const first = store()
    await first.store.load()
    assert.equal(first.store.hasPassword, false)
    await first.store.setPassword("secret123")
    assert.equal(first.store.hasPassword, true)
    assert.ok(first.storage.files.has(AUTH_FILE))

    const second = store(first.storage)
    await second.store.load()
    assert.equal(second.store.hasPassword, true)
    assert.equal(await second.store.verifyPassword("secret123"), true)
    assert.equal(await second.store.verifyPassword("nope"), false)
})

test("AuthStore：损坏 auth.json 按不可用处理", async () => {
    const storage = memoryStorage()
    storage.files.set(AUTH_FILE, "{ not json")
    const { store: auth } = store(storage)
    const loaded = await auth.load()
    assert.equal(loaded.ok, false)
    assert.equal(auth.hasPassword, false)
})

test("会话：创建、校验、注销与过期", async () => {
    let now = 1_000_000
    const { store: auth } = store(memoryStorage(), { now: () => now })
    await auth.load()
    const session = auth.createSession()
    assert.equal(auth.validateSession(session.token), true)
    auth.destroySession(session.token)
    assert.equal(auth.validateSession(session.token), false)

    const second = auth.createSession()
    now += 2 * 60 * 60 * 1000
    assert.equal(auth.validateSession(second.token), false)
})

test("失败限流：窗口内计数、成功后清空", async () => {
    let now = 1_000_000
    const { store: auth } = store(memoryStorage(), { now: () => now })
    await auth.load()
    auth.recordFailure("ip")
    auth.recordFailure("ip")
    assert.equal(auth.isBlocked("ip"), false)
    auth.recordFailure("ip")
    assert.equal(auth.isBlocked("ip"), true)
    auth.clearFailures("ip")
    assert.equal(auth.isBlocked("ip"), false)

    auth.recordFailure("ip")
    now += 61_000
    assert.equal(auth.isBlocked("ip"), false)
})

test("会话哈希与快照列表：只暴露哈希，过期会话被清理", async () => {
    let now = 1_000_000
    const { store: auth } = store(memoryStorage(), { now: () => now })
    await auth.load()
    assert.equal(
        sessionTokenHash("abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
    const session = auth.createSession()
    assert.equal(auth.sessionExpiresAt(session.token), session.expiresAt)
    const list = auth.listSessions()
    assert.equal(list.length, 1)
    assert.equal(list[0]?.hash, sessionTokenHash(session.token))
    assert.equal(list[0]?.expiresAt, session.expiresAt)
    assert.equal(JSON.stringify(list).includes(session.token), false)

    now += 2 * 60 * 60 * 1000
    assert.equal(auth.sessionExpiresAt(session.token), null)
    assert.deepEqual(auth.listSessions(), [])
})
