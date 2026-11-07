import assert from "node:assert/strict"
import { test } from "node:test"

import type { RouteConfig } from "../src/config.ts"
import { parseRegistration, RouteTable } from "../src/routes.ts"

function route(prefix: string, target: string, extra: Partial<RouteConfig> = {}): RouteConfig {
    return { prefix, target, stripPrefix: true, public: false, timeoutMs: null, ...extra }
}

test("静态路由：最长前缀匹配与来源", () => {
    const table = new RouteTable([
        route("/", "http://127.0.0.1:9000"),
        route("/web", "http://127.0.0.1:8787"),
    ])
    assert.equal(table.match("/web/x")?.rest, "/x")
    assert.equal(table.match("/web/x")?.entry.source, "config")
    assert.equal(table.match("/other")?.entry.config.prefix, "/")
    assert.equal(table.match("/web2")?.entry.config.prefix, "/")
})

test("插件注册：新增、覆盖、前缀冲突", () => {
    const table = new RouteTable([route("/web", "http://127.0.0.1:8787")])
    const added = table.add({ name: "code", prefix: "/code", target: "http://127.0.0.1:8788" })
    assert.equal(added.ok, true)
    assert.ok(added.ok && added.entry.source === "plugin")
    assert.equal(table.match("/code/x")?.entry.name, "code")

    const replaced = table.add({ name: "code", prefix: "/code2", target: "http://127.0.0.1:8789" })
    assert.ok(replaced.ok && replaced.replaced)
    assert.equal(table.match("/code/x"), null)
    assert.equal(table.match("/code2/x")?.entry.config.target, "http://127.0.0.1:8789")

    const staticConflict = table.add({ name: "x", prefix: "/web", target: "http://127.0.0.1:1" })
    assert.equal(staticConflict.ok, false)
    assert.match(staticConflict.ok ? "" : staticConflict.error, /配置占用/)

    table.add({ name: "a", prefix: "/a", target: "http://127.0.0.1:1" })
    const dynamicConflict = table.add({ name: "b", prefix: "/a", target: "http://127.0.0.1:2" })
    assert.equal(dynamicConflict.ok, false)
    assert.match(dynamicConflict.ok ? "" : dynamicConflict.error, /插件占用/)
})

test("插件注销", () => {
    const table = new RouteTable([])
    table.add({ name: "code", prefix: "/code", target: "http://127.0.0.1:8788" })
    assert.equal(table.remove("code"), true)
    assert.equal(table.remove("code"), false)
    assert.equal(table.match("/code/x"), null)
})

test("注册参数校验", () => {
    assert.equal(typeof parseRegistration(null), "string")
    assert.equal(typeof parseRegistration({ name: "", prefix: "/a", target: "http://x" }), "string")
    assert.equal(typeof parseRegistration({ name: "a", prefix: "a", target: "http://x" }), "string")
    assert.equal(typeof parseRegistration({ name: "a", prefix: "/a", target: "ftp://x" }), "string")
    assert.equal(
        typeof parseRegistration({ name: "a", prefix: "/a", target: "http://x", timeoutMs: 0 }),
        "string",
    )
    assert.deepEqual(parseRegistration({ name: "a", prefix: "/a/", target: "http://x" }), {
        name: "a",
        prefix: "/a",
        target: "http://x",
    })
})

test("public 与 timeoutMs 原样带到匹配结果", () => {
    const table = new RouteTable([
        route("/api", "http://127.0.0.1:1", { public: true, timeoutMs: 5000 }),
    ])
    const matched = table.match("/api/x")
    assert.equal(matched?.entry.config.public, true)
    assert.equal(matched?.entry.config.timeoutMs, 5000)
})
