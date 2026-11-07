/*
 * 插件与网关的上游注册协议
 *
 * 消费者插件 init 时发布 register，onShutdown 时发布 unregister；
 * 网关合并静态配置与运行时注册，每次变化广播 upstreams 列表
 */

/** 消费者 → 网关：注册 / 注销 */
export const GATEWAY_BUS_REGISTER = "wellspring-gateway:upstream:register"
export const GATEWAY_BUS_UNREGISTER = "wellspring-gateway:upstream:unregister"
/** 网关 → 所有插件：当前上游列表 */
export const GATEWAY_BUS_UPSTREAMS = "wellspring-gateway:upstreams"

export interface GatewayRegistration {
    /** 注册方标识，注销与诊断用 */
    readonly name: string
    /** 外部路径前缀 */
    readonly prefix: string
    /** 上游地址：http://127.0.0.1:8787 */
    readonly target: string
    readonly stripPrefix?: boolean
    readonly public?: boolean
    readonly timeoutMs?: number
}

export interface GatewayUnregister {
    readonly name: string
}

export interface GatewayUpstreamInfo {
    readonly name: string | null
    readonly prefix: string
    readonly target: string
    readonly stripPrefix: boolean
    readonly public: boolean
    readonly timeoutMs: number | null
    readonly source: "config" | "plugin"
}

export interface GatewayUpstreamsEvent {
    readonly upstreams: readonly GatewayUpstreamInfo[]
}
