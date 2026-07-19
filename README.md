# 字见 / ZiXian

把文字、想法和创作要求生成成可分享的视觉作品。

## 当前原型

- 选择设计语言并引用为创作上下文
- 输入内容与补充要求
- 在隔离的 HTML `iframe` 中实时预览
- 邮箱验证码登录、会话恢复与 IP/邮箱频率限制
- 保存安全 HTML、发布静态分享链接，以及 Browser Run 高清导出
- 预扣积分后调用模型；模型生成受限 HTML 片段，Worker 以标签与 Tailwind 工具类白名单净化后保存，失败自动退款
- 同一用户仅允许一个生成任务运行，且每分钟最多发起四次生成

当前版本已建立 Cloudflare Worker、D1/R2、Browser Run、认证和模型适配器；支付与真实扣费生成闭环将在后续任务接入。

## 本地预览

这是一个无构建步骤的 Web 原型。生产环境由同一个 Worker 同源提供 `index.html`、CSS、JS 与 `/api/*`，让安全 Cookie 可以正常工作。Worker 侧使用 `npm install` 后可执行 `npm test`；部署前需将 `wrangler.jsonc` 中的 D1 ID 替换为真实值。

使用 `npm run dev` 时会先自动应用本地 D1 中尚未执行的迁移；使用 `npm run deploy` 时会先自动应用远程 D1 迁移，再部署 Worker。请不要直接运行 `wrangler dev` 或 `wrangler deploy`，以免绕过这项检查。Worker 运行时若检测到缺表/缺列，会以可重试的 `database_not_ready` 响应提示服务正在更新，而不会暴露底层数据库错误。

## 环境变量

本地填写 `.dev.vars`；该文件已被 Git 忽略。部署到 Cloudflare 后，敏感值使用 `wrangler secret put <变量名>` 或 Worker Dashboard 的 Secrets 配置，非敏感值使用环境变量配置。

- Secrets：`AUTH_PEPPER`、`RESEND_API_KEY`、各模型 API Key
- 非敏感配置：`RESEND_FROM`、`APP_ORIGIN`、`ADMIN_EMAILS`

`ADMIN_EMAILS` 以英文逗号分隔允许访问 `/admin.html` 的登录邮箱。管理员名单只在 Worker 服务端校验，不能由前端设置。

后台保存 AI 渠道 Key 前，还必须设置 Secret `ADMIN_CONFIG_KEY`（建议用至少 32 个随机字符）。该值用于 AES-GCM 加密 D1 中的 Key；Key 不会回传到管理页面。后台的每条模型渠道均由管理员填写平台、调用协议（OpenAI 兼容或 Anthropic）、接口地址、模型名称、Key 和所属等级；同一等级最多可有 36 条渠道，生成按任务 ID 均衡分配，遇到 401/403、429、超时或 5xx 上游错误时自动串行切换下一个账号。未设置后台渠道配置时，生成会继续使用现有的模型环境变量。

当前登录发送由 Worker 的 IP/邮箱频率限制和同邮箱 60 秒冷却保护。面向中国大陆的独立人机验证服务会在后续接入。

## 测试充值

设置 `PAYMENTS_MODE=test` 后，积分卡片会显示一个“模拟 Stripe”流程：等待约 1.2 秒后将 100 积分写入正常的钱包与账本。它不会连接 Stripe、不会扣款；会留下金额为 ¥0 的测试订单，供后台统计测试流程，且永不计入实际收入。部署真实收费前，必须移除此变量和 `/api/test-payments` 路由，并改为经 Stripe webhook 验签入账。

## 代码边界

- `index.html`：创作工作台与无密码登录界面
- `styles.css`：视觉系统与响应式布局
- `app.js`：风格切换、文本安全转义、隔离预览、登录和真实保存/发布/导出请求

## 安全原则

用户文本会先转义再进入预览文档，原型不执行任何用户提供的 HTML 或脚本。后续生产版本将继续通过 HTML/CSS 白名单、内容审核与不可变分享快照保护公开作品。
