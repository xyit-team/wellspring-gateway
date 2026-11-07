import type { PluginApi } from "wellspring/api/host/index.ts"

export function setup() {
    return {
        id: "wellspring-gateway",
        name: "Wellspring Gateway",
        description: "统一入口网关（占位版本）",
        version: "0.1.1",
        status: "ok" as const,
        init: (api: PluginApi) => {
            api.logger.info("wellspring-gateway 占位版本")
        },
    }
}
