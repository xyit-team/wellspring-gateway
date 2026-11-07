import type { PluginApi } from "wellspring/api/host/index.ts"
import { onShutdown } from "wellspring/api/host/index.ts"

import { AuthStore } from "./src/auth.ts"
import { parseGatewayConfig } from "./src/config.ts"
import { createGateway, type GatewayHandle } from "./src/server.ts"

export function setup() {
    let gateway: GatewayHandle | null = null

    onShutdown(async () => {
        await gateway?.close()
        gateway = null
    })

    return {
        id: "wellspring-gateway",
        name: "Wellspring Gateway",
        description: "统一入口网关：单端口、路由、TLS 与统一登录",
        version: "0.2.0",
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
            gateway = createGateway({
                config,
                auth,
                logger: api.logger,
                readText: (path) => api.fs.readText(path),
            })
            await gateway.start()
            if (!config.auth.enabled) {
                api.logger.warn({}, "网关鉴权已关闭")
            }
            api.output.info(`网关监听 ${gateway.url}`)
        },
    }
}
