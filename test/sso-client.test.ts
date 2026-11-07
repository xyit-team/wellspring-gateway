import assert from "node:assert/strict"
import { test } from "node:test"

import {
    acceptsHtml,
    createSsoClient,
    lookupSessionInSnapshot,
    readSsoDiscovery,
    sessionTokenOf,
    sha256Hex,
    SSO_COOKIE_NAME,
    SSO_DISCOVERY_FILE,
    SSO_LOGIN_PATH,
    SSO_LOGOUT_PATH,
    SSO_SESSIONS_FILE,
    SSO_VERIFY_PATH,
    type SsoClient,
    type SsoClientOptions,
    type SsoDiscovery,
    type SsoDiscoveryReader,
    type SsoHeaders,
} from "../src/sso-client.ts"

const GATEWAY_URL = "http://127.0.0.1:8780"
const NOW = Date.now()
const FUTURE = NOW + 60 * 60 * 1000

function cookieHeaders(token: string): SsoHeaders {
    return { cookie: `${SSO_COOKIE_NAME}=${token}` }
}

function snapshotOf(sessions: readonly unknown[]): unknown {
    return { version: 1, sessions }
}

function requestUrl(input: string | URL | Request): string {
    if (typeof input === "string") {
        return input
    }
    return input instanceof URL ? input.href : input.url
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
    return new Headers(init?.headers).get(name)
}

const forbiddenFetch: typeof fetch = async () => {
    throw new Error("本地模式不应发起 HTTP 请求")
}

function localClient(
    sessions: () => Promise<unknown>,
    options: Partial<SsoClientOptions> = {},
): SsoClient {
    return createSsoClient({
        gatewayUrl: GATEWAY_URL,
        sessions,
        fetch: forbiddenFetch,
        ...options,
    })
}

function httpClient(fetchImpl: typeof fetch, options: Partial<SsoClientOptions> = {}): SsoClient {
    return createSsoClient({ gatewayUrl: GATEWAY_URL, fetch: fetchImpl, ...options })
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status })
}

interface FetchCall {
    readonly url: string
    readonly init: RequestInit | undefined
}

function recordingFetch(
    handler: (call: FetchCall) => Response | Promise<Response>,
): { readonly calls: FetchCall[]; readonly fetch: typeof fetch } {
    const calls: FetchCall[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
        const call: FetchCall = { url: requestUrl(input), init }
        calls.push(call)
        return await handler(call)
    }
    return { calls, fetch: fetchImpl }
}

function discoveryReader(
    read: (path: string) => unknown,
    paths: string[] = [],
): SsoDiscoveryReader {
    const readJson = async (path: string): Promise<unknown> => {
        paths.push(path)
        return await read(path)
    }
    return { readJson: readJson as SsoDiscoveryReader["readJson"] }
}

test("sessionTokenOf：缺失、空串与非目标 cookie", () => {
    assert.equal(sessionTokenOf({}), null)
    assert.equal(sessionTokenOf({ cookie: "" }), null)
    assert.equal(sessionTokenOf({ cookie: "a=1; b=2" }), null)
    assert.equal(sessionTokenOf({ cookie: `${SSO_COOKIE_NAME}=` }), null)
    assert.equal(sessionTokenOf({ cookie: `${SSO_COOKIE_NAME}_extra=tok` }), null)
    assert.equal(sessionTokenOf({ cookie: `other=${SSO_COOKIE_NAME}` }), null)
})

test("sessionTokenOf：单个与多个 cookie", () => {
    assert.equal(sessionTokenOf({ cookie: `${SSO_COOKIE_NAME}=tok` }), "tok")
    assert.equal(sessionTokenOf({ cookie: `a=1; ${SSO_COOKIE_NAME}=tok; b=2` }), "tok")
    assert.equal(sessionTokenOf({ cookie: `a=1; ${SSO_COOKIE_NAME}=tok` }), "tok")
})

test("sessionTokenOf：数组头、含 = 的值与自定义 cookie 名", () => {
    assert.equal(sessionTokenOf({ cookie: ["a=1", `${SSO_COOKIE_NAME}=tok`] }), "tok")
    assert.equal(sessionTokenOf({ cookie: `${SSO_COOKIE_NAME}=ab=cd` }), "ab=cd")
    assert.equal(sessionTokenOf({ cookie: "custom=tok" }, "custom"), "tok")
    assert.equal(sessionTokenOf({ cookie: `${SSO_COOKIE_NAME}=tok` }, "custom"), null)
})

test("acceptsHtml：text/html、*/*、json 与数组头", () => {
    assert.equal(acceptsHtml({ accept: "text/html" }), true)
    assert.equal(acceptsHtml({ accept: "text/html,application/xhtml+xml;q=0.9" }), true)
    assert.equal(acceptsHtml({ accept: "*/*" }), true)
    assert.equal(acceptsHtml({ accept: "application/json" }), false)
    assert.equal(acceptsHtml({ accept: ["application/json", "text/html"] }), true)
    assert.equal(acceptsHtml({}), false)
})

test("sha256Hex：已知向量", () => {
    assert.equal(
        sha256Hex("abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
})

test("loginUrl：默认、returnUrl 编码与结尾斜杠归一化", () => {
    const client = createSsoClient({ gatewayUrl: GATEWAY_URL })
    assert.equal(client.loginUrl(), `${GATEWAY_URL}${SSO_LOGIN_PATH}`)
    assert.equal(client.loginUrl(""), `${GATEWAY_URL}${SSO_LOGIN_PATH}`)

    const target = "/app/page?a=1&b=2"
    assert.equal(
        client.loginUrl(target),
        `${GATEWAY_URL}${SSO_LOGIN_PATH}?redirect=${encodeURIComponent(target)}`,
    )
    const returnUrl = client.loginUrl(target).split("?redirect=")[1]
    assert.equal(returnUrl, "%2Fapp%2Fpage%3Fa%3D1%26b%3D2")

    const trailing = createSsoClient({ gatewayUrl: `${GATEWAY_URL}/` })
    assert.equal(trailing.gatewayUrl, GATEWAY_URL)
    assert.equal(trailing.loginUrl(), `${GATEWAY_URL}${SSO_LOGIN_PATH}`)
})

test("createSsoClient：gatewayUrl 非法时抛错", () => {
    assert.throws(() => createSsoClient({ gatewayUrl: "not a url" }), /gatewayUrl 不合法/)
    assert.throws(() => createSsoClient({ gatewayUrl: "ftp://127.0.0.1:8780" }), /gatewayUrl 不合法/)
    assert.throws(() => createSsoClient({ gatewayUrl: "" }), /gatewayUrl 不合法/)
})

test("redirectToLogin / unauthorized：状态与响应头", () => {
    const client = createSsoClient({ gatewayUrl: GATEWAY_URL })
    const target = "/app?a=1&b=2"
    const redirect = client.redirectToLogin(target)
    assert.equal(redirect.status, 302)
    assert.equal(redirect.headers["location"], client.loginUrl(target))
    assert.equal(redirect.headers["cache-control"], "no-store")
    assert.equal(redirect.body, "")

    const unauthorized = client.unauthorized()
    assert.equal(unauthorized.status, 401)
    assert.equal(unauthorized.headers["content-type"], "application/json; charset=utf-8")
    assert.equal(unauthorized.headers["cache-control"], "no-store")
    assert.equal(unauthorized.body, '{"error":"unauthorized"}')
})

test("lookupSessionInSnapshot：命中、过期与 hash 不匹配", () => {
    const token = "tok"
    const hash = sha256Hex(token)
    assert.deepEqual(
        lookupSessionInSnapshot(snapshotOf([{ hash, expiresAt: 2_000 }]), token, 1_000),
        { state: "found", expiresAt: 2_000 },
    )
    assert.deepEqual(
        lookupSessionInSnapshot(snapshotOf([{ hash, expiresAt: 1_000 }]), token, 1_000),
        { state: "missing" },
    )
    assert.deepEqual(
        lookupSessionInSnapshot(snapshotOf([{ hash: sha256Hex("other"), expiresAt: 2_000 }]), token, 1_000),
        { state: "missing" },
    )
})

test("lookupSessionInSnapshot：malformed 与非法条目跳过", () => {
    const token = "tok"
    const hash = sha256Hex(token)
    assert.deepEqual(lookupSessionInSnapshot(null, token), { state: "malformed" })
    assert.deepEqual(lookupSessionInSnapshot("snapshot", token), { state: "malformed" })
    assert.deepEqual(lookupSessionInSnapshot([], token), { state: "malformed" })
    assert.deepEqual(lookupSessionInSnapshot({}, token), { state: "malformed" })
    assert.deepEqual(lookupSessionInSnapshot({ sessions: "x" }, token), { state: "malformed" })
    assert.deepEqual(lookupSessionInSnapshot({ sessions: [] }, token), { state: "missing" })

    const entries = [
        null,
        { hash: 1, expiresAt: 2_000 },
        { hash, expiresAt: "2000" },
        { hash, expiresAt: 2_000 },
    ]
    assert.deepEqual(lookupSessionInSnapshot(snapshotOf(entries), token, 1_000), {
        state: "found",
        expiresAt: 2_000,
    })
})

test("readSsoDiscovery：正常解析", async () => {
    const expected: SsoDiscovery = {
        version: 2,
        url: "http://127.0.0.1:8780",
        authEnabled: false,
        cookieName: "gw_session",
        loginPath: "/signin",
        logoutPath: "/signout",
        verifyPath: "/__gw/verify",
        sessionsFile: "gw-sessions.json",
        updatedAt: "2026-01-01T00:00:00.000Z",
    }
    const client = discoveryReader(() => ({ ...expected }))
    assert.deepEqual(await readSsoDiscovery(client), expected)

    const paths: string[] = []
    const withPaths = discoveryReader(() => ({ ...expected }), paths)
    await readSsoDiscovery(withPaths)
    assert.deepEqual(paths, [SSO_DISCOVERY_FILE])
    await readSsoDiscovery(withPaths, "custom-sso.json")
    assert.deepEqual(paths, [SSO_DISCOVERY_FILE, "custom-sso.json"])
})

test("readSsoDiscovery：可选字段默认值", async () => {
    const reader = discoveryReader(() => ({ url: "http://127.0.0.1:8780" }))
    const discovery = await readSsoDiscovery(reader)
    assert.deepEqual(discovery, {
        version: 1,
        url: "http://127.0.0.1:8780",
        authEnabled: true,
        cookieName: SSO_COOKIE_NAME,
        loginPath: SSO_LOGIN_PATH,
        logoutPath: SSO_LOGOUT_PATH,
        verifyPath: SSO_VERIFY_PATH,
        sessionsFile: SSO_SESSIONS_FILE,
    })
})

test("readSsoDiscovery：reader 缺失、异常、非对象与非法 url 返回 null", async () => {
    assert.equal(await readSsoDiscovery(null), null)
    assert.equal(await readSsoDiscovery(undefined), null)

    const throwing = discoveryReader(() => {
        throw new Error("sso.json 不可读")
    })
    assert.equal(await readSsoDiscovery(throwing), null)

    for (const value of [null, "text", 42, ["url"]]) {
        assert.equal(await readSsoDiscovery(discoveryReader(() => value)), null)
    }
    for (const value of [{}, { url: "" }, { url: 42 }, { url: null }]) {
        assert.equal(await readSsoDiscovery(discoveryReader(() => value)), null)
    }
})

test("本地模式 verify：快照未过期会话返回 admin", async () => {
    const client = localClient(async () =>
        snapshotOf([{ hash: sha256Hex("tok"), expiresAt: FUTURE }]),
    )
    assert.deepEqual(await client.verify(cookieHeaders("tok")), {
        ok: true,
        user: "admin",
        expiresAt: FUTURE,
    })
    assert.equal(client.sessionToken(cookieHeaders("tok")), "tok")
    assert.equal(client.cookieName, SSO_COOKIE_NAME)
})

test("本地模式 verify：过期或 hash 不匹配返回 invalid", async () => {
    const expired = localClient(async () =>
        snapshotOf([{ hash: sha256Hex("tok"), expiresAt: NOW - 1 }]),
    )
    assert.deepEqual(await expired.verify(cookieHeaders("tok")), {
        ok: false,
        reason: "invalid",
    })

    const mismatch = localClient(async () =>
        snapshotOf([{ hash: sha256Hex("other"), expiresAt: FUTURE }]),
    )
    assert.deepEqual(await mismatch.verify(cookieHeaders("tok")), {
        ok: false,
        reason: "invalid",
    })
})

test("本地模式 verify：provider 返回 null、抛错或快照损坏为 unreachable", async () => {
    const nullProvider = localClient(async () => null)
    const undefinedProvider = localClient(async () => undefined)
    const throwingProvider = localClient(async () => {
        throw new Error("快照不可读")
    })
    const malformedProvider = localClient(async () => ({ sessions: "not-an-array" }))
    for (const client of [nullProvider, undefinedProvider, throwingProvider, malformedProvider]) {
        assert.deepEqual(await client.verify(cookieHeaders("tok")), {
            ok: false,
            reason: "unreachable",
        })
    }
})

test("本地模式 verify：缺 cookie 返回 missing 且不读快照", async () => {
    let calls = 0
    const client = localClient(async () => {
        calls += 1
        return snapshotOf([])
    })
    assert.deepEqual(await client.verify({}), { ok: false, reason: "missing" })
    assert.equal(calls, 0)
})

test("本地模式 verify：cacheTtlMs 内复用快照结果", async () => {
    let calls = 0
    const client = localClient(
        async () => {
            calls += 1
            return snapshotOf([{ hash: sha256Hex("tok"), expiresAt: FUTURE }])
        },
        { cacheTtlMs: 60_000 },
    )
    await client.verify(cookieHeaders("tok"))
    await client.verify(cookieHeaders("tok"))
    assert.equal(calls, 1)
})

test("HTTP 模式 verify：200 合法结果与请求构造", async () => {
    const recorded = recordingFetch(() =>
        jsonResponse({ ok: true, user: "admin", expiresAt: FUTURE }),
    )
    const client = httpClient(recorded.fetch)
    assert.deepEqual(await client.verify(cookieHeaders("tok")), {
        ok: true,
        user: "admin",
        expiresAt: FUTURE,
    })

    assert.equal(recorded.calls.length, 1)
    const call = recorded.calls[0]
    assert.ok(call !== undefined)
    assert.ok(call.url.startsWith(GATEWAY_URL))
    assert.ok(call.url.endsWith(SSO_VERIFY_PATH))
    assert.equal(call.init?.method, "GET")
    assert.equal(call.init?.redirect, "manual")
    assert.ok(call.init?.signal instanceof AbortSignal)
    assert.equal(headerOf(call.init, "cookie"), `${SSO_COOKIE_NAME}=tok`)
    assert.equal(headerOf(call.init, "accept"), "application/json")
    assert.equal(headerOf(call.init, "cache-control"), "no-store")
})

test("HTTP 模式 verify：200 缺字段时 user 与 expiresAt 为 null", async () => {
    const client = httpClient(async () => jsonResponse({ ok: true }))
    assert.deepEqual(await client.verify(cookieHeaders("tok")), {
        ok: true,
        user: null,
        expiresAt: null,
    })
})

test("HTTP 模式 verify：401 与 403 返回 invalid", async () => {
    for (const status of [401, 403]) {
        const client = httpClient(async () => new Response("", { status }))
        assert.deepEqual(await client.verify(cookieHeaders("tok")), {
            ok: false,
            reason: "invalid",
        })
    }
})

test("HTTP 模式 verify：非法 JSON 与 ok 非 true 为 unreachable", async () => {
    const clients = [
        httpClient(async () => new Response("not json", { status: 200 })),
        httpClient(async () => jsonResponse({ ok: false })),
        httpClient(async () => jsonResponse([{ ok: true }])),
        httpClient(async () => jsonResponse(null)),
    ]
    for (const client of clients) {
        assert.deepEqual(await client.verify(cookieHeaders("tok")), {
            ok: false,
            reason: "unreachable",
        })
    }
})

test("HTTP 模式 verify：500、网络异常与超时为 unreachable", async () => {
    const serverError = httpClient(async () => new Response("", { status: 500 }))
    const networkError = httpClient(async () => {
        throw new Error("ECONNREFUSED")
    })
    const timeout = httpClient(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError")
    })
    for (const client of [serverError, networkError, timeout]) {
        assert.deepEqual(await client.verify(cookieHeaders("tok")), {
            ok: false,
            reason: "unreachable",
        })
    }
})

test("HTTP 模式 verify：缺 cookie 不发起请求", async () => {
    const recorded = recordingFetch(() => jsonResponse({ ok: true }))
    const client = httpClient(recorded.fetch)
    assert.deepEqual(await client.verify({}), { ok: false, reason: "missing" })
    assert.equal(recorded.calls.length, 0)
})

test("缓存：cacheTtlMs 内不重复请求，reset 后重新请求", async () => {
    const recorded = recordingFetch(() =>
        jsonResponse({ ok: true, user: "admin", expiresAt: FUTURE }),
    )
    const client = httpClient(recorded.fetch, { cacheTtlMs: 60_000 })
    await client.verify(cookieHeaders("tok"))
    await client.verify(cookieHeaders("tok"))
    assert.equal(recorded.calls.length, 1)

    client.reset()
    await client.verify(cookieHeaders("tok"))
    assert.equal(recorded.calls.length, 2)
})

test("缓存：cacheTtlMs 为 0 时每次请求", async () => {
    const recorded = recordingFetch(() =>
        jsonResponse({ ok: true, user: "admin", expiresAt: FUTURE }),
    )
    const client = httpClient(recorded.fetch)
    await client.verify(cookieHeaders("tok"))
    await client.verify(cookieHeaders("tok"))
    assert.equal(recorded.calls.length, 2)
})

test("缓存：会话已过期时不用缓存结果", async () => {
    let calls = 0
    const client = httpClient(
        async () => {
            calls += 1
            const expiresAt = calls === 1 ? NOW - 1 : FUTURE
            return jsonResponse({ ok: true, user: "admin", expiresAt })
        },
        { cacheTtlMs: 60_000 },
    )
    assert.deepEqual(await client.verify(cookieHeaders("tok")), {
        ok: true,
        user: "admin",
        expiresAt: NOW - 1,
    })
    assert.deepEqual(await client.verify(cookieHeaders("tok")), {
        ok: true,
        user: "admin",
        expiresAt: FUTURE,
    })
    assert.equal(calls, 2)
})
