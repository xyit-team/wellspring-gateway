/*
 * 网关自有页面：登录 / 设置密码 / 修改密码 / 错误页
 *
 * 页面自包含（内联样式、无脚本），响应头由 server.ts 统一下发
 */

export function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;")
}

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #f4f4f5;
    color: #18181b;
    font-family: system-ui, -apple-system, "Segoe UI", "Noto Sans CJK SC", sans-serif;
}
main {
    width: min(360px, calc(100vw - 32px));
    padding: 28px;
    border-radius: 12px;
    background: #fff;
    border: 1px solid #e4e4e7;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.06);
}
h1 { margin: 0 0 4px; font-size: 20px; font-weight: 600; }
p.hint { margin: 0 0 20px; font-size: 13px; color: #71717a; }
label { display: block; font-size: 13px; color: #3f3f46; margin: 14px 0 6px; }
input {
    width: 100%;
    padding: 9px 10px;
    font-size: 14px;
    border: 1px solid #d4d4d8;
    border-radius: 8px;
    background: #fff;
    color: inherit;
}
input:focus { outline: 2px solid #a1a1aa; outline-offset: 1px; }
button {
    width: 100%;
    margin-top: 22px;
    padding: 10px;
    font-size: 14px;
    border: 0;
    border-radius: 8px;
    background: #18181b;
    color: #fafafa;
    cursor: pointer;
}
.error {
    margin: 0 0 14px;
    padding: 9px 11px;
    font-size: 13px;
    border-radius: 8px;
    background: #fef2f2;
    color: #b91c1c;
}
footer { margin-top: 18px; font-size: 12px; color: #a1a1aa; text-align: center; }
ul.routes { margin: 18px 0 0; padding: 0; list-style: none; }
ul.routes li + li { margin-top: 8px; }
ul.routes a {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    border: 1px solid #e4e4e7;
    border-radius: 8px;
    color: inherit;
    text-decoration: none;
    font-size: 14px;
}
ul.routes a:hover { border-color: #a1a1aa; }
ul.routes span.source { font-size: 12px; color: #a1a1aa; }
@media (prefers-color-scheme: dark) {
    ul.routes a { border-color: #27272a; }
    ul.routes a:hover { border-color: #52525b; }
}
@media (prefers-color-scheme: dark) {
    body { background: #09090b; color: #fafafa; }
    main { background: #18181b; border-color: #27272a; box-shadow: none; }
    p.hint, footer { color: #a1a1aa; }
    label { color: #d4d4d8; }
    input { background: #09090b; border-color: #3f3f46; }
    input:focus { outline-color: #52525b; }
    button { background: #fafafa; color: #18181b; }
    .error { background: #450a0a; color: #fecaca; }
}
`

function layout(title: string, body: string): string {
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
<footer>Wellspring Gateway</footer>
</main>
</body>
</html>
`
}

function errorBlock(error: string | undefined): string {
    return error === undefined ? "" : `<p class="error">${escapeHtml(error)}</p>`
}

export interface LoginPageOptions {
    readonly hasPassword: boolean
    readonly error?: string
    readonly next?: string
}

export function loginPage(options: LoginPageOptions): string {
    const nextField =
        options.next === undefined
            ? ""
            : `<input type="hidden" name="next" value="${escapeHtml(options.next)}">`
    if (!options.hasPassword) {
        return layout(
            "设置管理密码",
            `<h1>设置管理密码</h1>
<p class="hint">首次使用，设置网关管理密码</p>
${errorBlock(options.error)}
<form method="post" action="/login">
<label for="password">密码</label>
<input id="password" name="password" type="password" autocomplete="new-password" autofocus>
<label for="confirm">确认密码</label>
<input id="confirm" name="confirm" type="password" autocomplete="new-password">
${nextField}
<button type="submit">设置密码</button>
</form>`,
        )
    }
    return layout(
        "登录",
        `<h1>登录</h1>
<p class="hint">输入管理密码</p>
${errorBlock(options.error)}
<form method="post" action="/login">
<label for="password">密码</label>
<input id="password" name="password" type="password" autocomplete="current-password" autofocus>
${nextField}
<button type="submit">登录</button>
</form>`,
    )
}

export interface PasswordPageOptions {
    readonly error?: string
}

export function passwordPage(options: PasswordPageOptions): string {
    return layout(
        "修改密码",
        `<h1>修改密码</h1>
<p class="hint">修改后所有设备需要重新登录</p>
${errorBlock(options.error)}
<form method="post" action="/__gateway/password">
<label for="current">当前密码</label>
<input id="current" name="current" type="password" autocomplete="current-password" autofocus>
<label for="password">新密码</label>
<input id="password" name="password" type="password" autocomplete="new-password">
<label for="confirm">确认新密码</label>
<input id="confirm" name="confirm" type="password" autocomplete="new-password">
<button type="submit">保存</button>
</form>`,
    )
}

export interface MessagePageOptions {
    readonly title: string
    readonly message: string
}

export function messagePage(options: MessagePageOptions): string {
    return layout(
        options.title,
        `<h1>${escapeHtml(options.title)}</h1>
<p class="hint">${escapeHtml(options.message)}</p>`,
    )
}

export interface HomeRouteLink {
    readonly prefix: string
    readonly name: string | null
    readonly source: "config" | "plugin"
}

export interface HomePageOptions {
    readonly routes: readonly HomeRouteLink[]
}

export function homePage(options: HomePageOptions): string {
    const items =
        options.routes.length === 0
            ? `<p class="hint">暂无已注册服务</p>`
            : `<ul class="routes">${options.routes
                  .map((route) => {
                      const label = route.name ?? route.prefix
                      const source = route.source === "config" ? "配置" : "插件"
                      return `<li><a href="${escapeHtml(route.prefix === "/" ? "/" : route.prefix.replace(/\/+$/, "") + "/")}"><span>${escapeHtml(label)}</span><span class="source">${escapeHtml(route.prefix)} · ${source}</span></a></li>`
                  })
                  .join("")}</ul>`
    return layout(
        "Wellspring",
        `<h1>Wellspring</h1>
<p class="hint">选择一个服务</p>
${items}`,
    )
}
