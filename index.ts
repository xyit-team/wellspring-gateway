import type { PluginApi } from "wellspring/api/host/index.ts"
import { EventEntity, eventBus, onShutdown } from "wellspring/api/host/index.ts"

import { AuthStore } from "./src/auth.ts"
import { parseGatewayConfig } from "./src/config.ts"
import {
    GATEWAY_BUS_REGISTER,
    GATEWAY_BUS_UNREGISTER,
    GATEWAY_BUS_UPSTREAMS,
    type GatewayRegistration,
    type GatewayUnregister,
} from "./src/protocol.ts"
import { createGateway, type GatewayHandle } from "./src/server.ts"
import { GATEWAY_VERSION } from "./src/version.ts"

export function setup() {
    let gateway: GatewayHandle | null = null
    const subscriptions: Array<() => void> = []

    const publishUpstreams = (): void => {
        if (gateway === null) {
            return
        }
        eventBus.publish(
            GATEWAY_BUS_UPSTREAMS,
            EventEntity.create({ upstreams: gateway.listUpstreams() }),
        )
    }

    onShutdown(async () => {
        for (const unsubscribe of subscriptions.splice(0)) {
            unsubscribe()
        }
        await gateway?.close()
        gateway = null
    })

    return {
        id: "wellspring-gateway",
        name: "Wellspring Gateway",
        description: "统一入口网关：单端口、路由、TLS 与统一登录",
        version: GATEWAY_VERSION,
        status: "ok" as const,
        init: async (api: PluginApi) => {
            const { config, warnings } = parseGatewayConfig(api.pluginConfig)
            for (const warning of warnings) {
                api.logger.warn({ warning }, "网关配置项被忽略")
            }
            const auth = new AuthStore({
                storage: api.fs,
                sessionHours: config.auth.sessionHours,
                maxAttempts: config.auth.maxAttempts,
                windowMs: config.auth.windowMs,
            })
            const loaded = await auth.load()
            if (!loaded.ok) {
                api.logger.warn({ error: loaded.error }, "auth.json 不可用，按未设置密码处理")
            }
            const handle = createGateway({
                config,
                auth,
                logger: api.logger,
                readText: (path) => api.fs.readText(path),
            })
            await handle.start()
            gateway = handle
            if (!config.auth.enabled) {
                api.logger.warn({}, "网关鉴权已关闭")
            }
            subscriptions.push(
                eventBus.subscribe<GatewayRegistration>(GATEWAY_BUS_REGISTER, (event) => {
                    const result = handle.addUpstream(event.getData())
                    if (!result.ok) {
                        api.logger.warn(
                            { error: result.error, payload: event.getData() },
                            "上游注册失败",
                        )
                    }
                    publishUpstreams()
                }),
                eventBus.subscribe<GatewayUnregister>(GATEWAY_BUS_UNREGISTER, (event) => {
                    const data = event.getData() as unknown
                    const name =
                        typeof data === "object" && data !== null
                            ? (data as Record<string, unknown>)["name"]
                            : undefined
                    if (typeof name === "string") {
                        handle.removeUpstream(name)
                    }
                    publishUpstreams()
                }),
            )
            publishUpstreams()
            api.output.info(`网关监听 ${handle.url}`)
        },
    }
}
