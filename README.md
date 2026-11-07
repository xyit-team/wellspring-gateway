# @xyit-team/wellspring-gateway

Wellspring 网关插件：统一入口（单端口 / 路由 / TLS / 统一登录）。

当前是占位版本：网关实现待重写。仓库此前是 `wellspring-http`（插件 HTTP 服务托管层，
已停止维护；旧包 `@xyit-team/wellspring-http` 用 `npm deprecate` 标记）。

## 安装

```bash
wellspring plugin install npm:@xyit-team/wellspring-gateway
# 或
wellspring plugin install github:xyit-team/wellspring-gateway
```

## 开发

目录只保留包身份与发布流程所需文件：`package.json`、插件入口 `index.ts`、README、LICENSE、
`publish-npm.yml`。CI、构建脚本与消费者 SDK 在网关实现落地后补回。

## 发布

首次发布手动执行（包在 npm 上存在后才能配 Trusted Publishing）：

```bash
npm login
npm publish --access public
```

配置 Trusted Publishing（需要 2FA）：

```bash
npm trust github @xyit-team/wellspring-gateway \
  --repo xyit-team/wellspring-gateway \
  --file publish-npm.yml \
  --allow-publish
```

之后的版本：改 `package.json` 的 version → 提交 → 推同名 `v*` 标签，`publish-npm.yml` 自动发布。
