# 字见 / ZiXian

把文字、想法和创作要求生成成可分享的视觉作品。

## 当前原型

- 选择设计语言并引用为创作上下文
- 输入内容与补充要求
- 在隔离的 HTML `iframe` 中实时预览
- 邮箱验证码登录、会话恢复与 Turnstile 人机验证
- 保存安全 HTML、发布静态分享链接，以及 Browser Run 高清导出
- 预扣积分后调用模型；模型只生成受限文案 JSON，失败自动退款

当前版本已建立 Cloudflare Worker、D1/R2、Browser Run、认证和模型适配器；支付与真实扣费生成闭环将在后续任务接入。

## 本地预览

这是一个无构建步骤的 Web 原型。生产环境由同一个 Worker 同源提供 `index.html`、CSS、JS 与 `/api/*`，让安全 Cookie 可以正常工作。Worker 侧使用 `npm install` 后可执行 `npm test`；部署前需将 `wrangler.jsonc` 中的 D1 ID 替换为真实值。

## 环境变量

本地填写 `.dev.vars`；该文件已被 Git 忽略。部署到 Cloudflare 后，敏感值使用 `wrangler secret put <变量名>` 或 Worker Dashboard 的 Secrets 配置，非敏感值使用环境变量配置。

- Secrets：`AUTH_PEPPER`、`TURNSTILE_SECRET_KEY`、`RESEND_API_KEY`、各模型 API Key
- 非敏感配置：`RESEND_FROM`、`TURNSTILE_SITE_KEY`、`APP_ORIGIN`

`TURNSTILE_SITE_KEY` 会被 `/api/public-config` 返回给浏览器，这是 Turnstile 设计上可公开的站点键；其余认证和邮件密钥不会进入前端。Cloudflare 部署时，在 Worker 的 Variables 中填写该站点键，并将三个敏感认证值设为 Secrets。

## 测试充值

设置 `PAYMENTS_MODE=test` 后，积分卡片会显示一个“模拟 Stripe”流程：等待约 1.2 秒后将 100 积分写入正常的钱包与账本。它不会连接 Stripe、不会创建支付订单、也不会扣款。部署真实收费前，必须移除此变量和 `/api/test-payments` 路由，并改为经 Stripe webhook 验签入账。

## 代码边界

- `index.html`：创作工作台与无密码登录界面
- `styles.css`：视觉系统与响应式布局
- `app.js`：风格切换、文本安全转义、隔离预览、登录和真实保存/发布/导出请求

## 安全原则

用户文本会先转义再进入预览文档，原型不执行任何用户提供的 HTML 或脚本。后续生产版本将继续通过 HTML/CSS 白名单、内容审核与不可变分享快照保护公开作品。
