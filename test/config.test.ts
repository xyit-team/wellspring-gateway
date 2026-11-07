import assert from "node:assert/strict"
import { test } from "node:test"

import {
    DEFAULT_GATEWAY_CONFIG,
    matchRoute,
    parseGatewayConfig,
    parseTarget,
    upstreamPath,
    type RouteConfig,
} from "../src/config.ts"

function route(
    prefix: string,
    target: string,
    stripPrefix = true,
): RouteConfig {
    return { prefix, target, stripPrefix, public: false, timeoutMs: null }
}

test("默认配置", () => {
    const { config, warnings } = parseGatewayConfig({})
    assert.deepEqual(config, DEFAULT_GATEWAY_CONFIG)
    assert.deepEqual(warnings, [])
})

test("非法字段回落默认值并给出警告", () => {
    const { config, warnings } = parseGatewayConfig({
        host: "bad host",
        port: 70_000,
        accessLog: "yes",
        auth: { enabled: "no", sessionHours: 0 },
        tls: { certFile: "c.pem" },
    })
    assert.equal(config.host, DEFAULT_GATEWAY_CONFIG.host)
    assert.equal(config.port, DEFAULT_GATEWAY_CONFIG.port)
    assert.equal(config.accessLog, DEFAULT_GATEWAY_CONFIG.accessLog)
    assert.equal(config.auth.enabled, DEFAULT_GATEWAY_CONFIG.auth.enabled)
    assert.equal(config.auth.sessionHours, DEFAULT_GATEWAY_CONFIG.auth.sessionHours)
    assert.equal(config.tls, null)
    assert.ok(warnings.length >= 5, JSON.stringify(warnings))
})

test("路由解析：保留合法项，丢弃非法项", () => {
    const { config, warnings } = parseGatewayConfig({
        routes: [
            { prefix: "/web/", target: "http://127.0.0.1:8787" },
            { prefix: "code", target: "http://127.0.0.1:8788" },
            { prefix: "/bad", target: "ftp://127.0.0.1:1" },
            { prefix: "/raw", target: "http://127.0.0.1:8789", stripPrefix: false },
            "nope",
        ],
    })
    assert.deepEqual(config.routes, [
        { prefix: "/web", target: "http://127.0.0.1:8787", stripPrefix: true, public: false, timeoutMs: null },
        { prefix: "/raw", target: "http://127.0.0.1:8789", stripPrefix: false, public: false, timeoutMs: null },
    ])
    assert.equal(warnings.length, 3)
})

test("路由项支持 public 与 timeoutMs", () => {
    const { config, warnings } = parseGatewayConfig({
        routes: [
            { prefix: "/api", target: "http://127.0.0.1:1", public: true, timeoutMs: 5_000 },
            { prefix: "/bad", target: "http://127.0.0.1:2", timeoutMs: 0 },
            { prefix: "/bad2", target: "http://127.0.0.1:3", public: "yes" },
        ],
    })
    assert.deepEqual(config.routes, [
        { prefix: "/api", target: "http://127.0.0.1:1", stripPrefix: true, public: true, timeoutMs: 5_000 },
    ])
    assert.equal(warnings.length, 2)
})

test("parseTarget：只接受 http(s)", () => {
    assert.ok(parseTarget("http://127.0.0.1:8787"))
    assert.ok(parseTarget("https://example.com"))
    assert.equal(parseTarget("ftp://x"), null)
    assert.equal(parseTarget("not a url"), null)
})

test("matchRoute：最长前缀与段边界", () => {
    const routes: RouteConfig[] = [
        route("/", "http://127.0.0.1:1", false),
        route("/web", "http://127.0.0.1:2"),
        route("/web/api", "http://127.0.0.1:3"),
    ]
    assert.equal(matchRoute(routes, "/web/api/x")?.rest, "/x")
    assert.equal(matchRoute(routes, "/web/api/x")?.route.target, "http://127.0.0.1:3")
    assert.equal(matchRoute(routes, "/web/x")?.rest, "/x")
    assert.equal(matchRoute(routes, "/web")?.rest, "/")
    assert.equal(matchRoute(routes, "/web2")?.route.prefix, "/")
    assert.equal(matchRoute(routes, "/other")?.route.prefix, "/")
})

test("upstreamPath：stripPrefix 开关", () => {
    const strip: RouteConfig = route("/web", "http://x")
    const keep: RouteConfig = route("/web", "http://x", false)
    assert.equal(upstreamPath(strip, "/hello", "/web/hello"), "/hello")
    assert.equal(upstreamPath(strip, "/", "/web"), "/")
    assert.equal(upstreamPath(keep, "/hello", "/web/hello"), "/web/hello")
})
