/*
 * 网关自有页面：登录 / 设置密码 / 修改密码 / 账户页 / 错误页
 *
 * 页面自包含（内联样式），诊断脚本内联，CSP 用脚本哈希放行；响应头由 server.ts 统一下发
 */

import { createHash } from "node:crypto"

export function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;")
}

/* 浏览器 console 诊断日志；内容变化时 CSP 哈希自动跟着变 */
const DIAGNOSTIC_SCRIPT = `(function () {
    var prefix = "[wellspring] ";
    function log(name, data) {
        if (data === undefined) {
            console.log(prefix + name);
        } else {
            console.log(prefix + name, data);
        }
    }
    log("page", { url: location.href, title: document.title });
    var form = document.querySelector("form");
    if (form === null) {
        return;
    }
    log("form", { action: form.getAttribute("action"), method: form.getAttribute("method") });
    form.addEventListener("submit", function () {
        var fields = {};
        var elements = form.elements;
        for (var index = 0; index < elements.length; index += 1) {
            var element = elements[index];
            if (!element.name) {
                continue;
            }
            fields[element.name] = element.name.indexOf("password") >= 0 ? "***" : element.value;
        }
        log("submit", fields);
        log("submit-target", new URL(form.getAttribute("action") || location.href, location.href).href);
    });
    window.addEventListener("pageshow", function (event) {
        log("pageshow", { persisted: event.persisted });
    });
    window.addEventListener("error", function (event) {
        log("error", String(event.message));
    });
})();`

export const PAGE_SCRIPT_HASH = `sha256-${createHash("sha256").update(DIAGNOSTIC_SCRIPT, "utf8").digest("base64")}`

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
<script>${DIAGNOSTIC_SCRIPT}</script>
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
    /** 登录后回跳目标（redirect 参数） */
    readonly redirect?: string
    readonly next?: string
}

function hiddenTargetField(options: LoginPageOptions): string {
    if (options.redirect !== undefined) {
        return `<input type="hidden" name="redirect" value="${escapeHtml(options.redirect)}">`
    }
    if (options.next !== undefined) {
        return `<input type="hidden" name="next" value="${escapeHtml(options.next)}">`
    }
    return ""
}

export function loginPage(options: LoginPageOptions): string {
    const nextField = hiddenTargetField(options)
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

export function accountPage(): string {
    return layout(
        "Wellspring",
        `<h1>Wellspring</h1>
<p class="hint">已登录</p>
<ul class="routes">
<li><a href="/__gateway/password"><span>修改密码</span></a></li>
<li><a href="/__gateway/status"><span>运行状态</span></a></li>
<li><a href="/logout"><span>注销</span></a></li>
</ul>`,
    )
}
