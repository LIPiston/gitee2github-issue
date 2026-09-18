# 本副本的改动与部署注意事项

## 来源声明

- 上游仓库：[OpenSiFli/gitee2github-issue](https://github.com/OpenSiFli/gitee2github-issue)（本副本基于其 `836b381`）
- 本副本：[LIPiston/gitee2github-issue](https://github.com/LIPiston/gitee2github-issue)
- **许可证**：上游以 **Apache-2.0 License** 授权（其 README「📄 许可证」段落声明，但仓库内未附 LICENSE 文件）。本副本沿用 Apache-2.0，并按该许可证第 4(b) 条在此声明：`src/services/github-service.ts`、`src/services/gitee-service.ts`、`wrangler.jsonc` 三个文件已被修改，修改内容见下节。许可证正文见 [LICENSE](./LICENSE)。上游没有 NOTICE 文件，本副本也未新增。
- 克隆本副本：`git clone https://github.com/LIPiston/gitee2github-issue.git`

## 改动清单（相对上游 836b381）

### 1. wrangler.jsonc —— 绑定自定义域名

新增 `routes`，用 `custom_domain: true` 把自己的域绑到 Worker。

原因：`*.workers.dev` 在中国大陆被 DNS 污染/不可达。Gitee 的 Webhook 服务器在国内，请求 Worker 的 workers.dev 域名会直接超时（实测：从香港节点访问 200/0.2s，从国内 Gitee 投递超时）。绑定自建域名（zone 与 Worker 同账号）后，`wrangler deploy` 会自动创建 DNS 记录与证书。

同时注意：Gitee Webhook 的地址必须带 `/webhook/gitee` 路径，填根路径不会工作。

### 2. src/services/github-service.ts

- **签名校验从 TODO 变成真实现**：上游的 `verifyWebhookSignature` 直接 `return true`，等于任何人都能伪造 GitHub 事件、借你配置的令牌往 Gitee 写评论。改为用 Web Crypto 计算 HMAC-SHA256 与 `X-Hub-Signature-256` 比对，常量时间比较；未配置 `GITHUB_WEBHOOK_SECRET` 时直接拒绝。
- **安装令牌按目标仓库动态解析**：不再依赖固定的 `GITHUB_INSTALLATION_ID`，改为
  `App JWT` → `GET /repos/{owner}/{repo}/installation` → 签发该安装的访问令牌。
  安装 ID 与令牌都做了模块级缓存（令牌保留 60 秒过期余量）。好处：App 重新安装、或把 App 扩展到更多仓库之后，都不需要改任何配置；同一个 Worker 也能同时服务多个安装。

### 3. src/services/gitee-service.ts

- **Gitee 密码校验加固**：上游实现是 `data.password === this.env.GITEE_WEBHOOK_SECRET`，一旦没有配置该 secret，`undefined === undefined` 会成立，端点等于对所有人开放。改为未配置密钥即拒绝、类型/长度校验 + 常量时间比较。
- **404 诊断提示**：创建 Gitee 评论遇到 404 时，返回“可能是 Gitee 端已删除该 issue（issue_mappings 中的映射已失效）”，并写 `console.error`。触发场景：Gitee 端的 issue 被删除，但 `issue_mappings` 里的映射还留着。

### 4. scripts/encode-github-app-key.mjs（新增）

把 GitHub App 的 **PKCS#8** 私钥转成“单行 + 字面 `\n`”的字符串，供 `wrangler secret put` 使用，并在写入前用 `crypto.createPrivateKey` 自校验。

```bash
node scripts/encode-github-app-key.mjs /path/to/pkcs8-private-key.pem | npx wrangler secret put GITHUB_PRIVATE_KEY
```

## 部署踩坑记录

1. **workers.dev 在国内不可用** —— 必须绑定自定义域名，否则 Gitee 的 Webhook 一定超时（症状：Gitee 后台显示请求超时/失败）。
2. **GitHub App 私钥必须是 PKCS#8**：GitHub 下载到的是 PKCS#1，需要先转换，否则运行时报 `Private Key is in PKCS#1 format, but only PKCS#8 is supported`。
   ```bash
   openssl pkcs8 -topk8 -inform PEM -outform PEM -in 原始.pem -out 转换后.pem -nocrypt
   ```
3. **不要用上游 README 里那条编码命令**：`tr '\n' 'Z' | sed 's/Z/\\n/g'` 会把 base64 正文里本来就存在的字母 `Z` 也替换成换行，把私钥打坏，运行时表现为 `atob() called with invalid base64-encoded data`。用第 4 节的脚本。
4. **`wrangler d1 create` 报 Authentication error（code 10000）** 时，可以在 Cloudflare 控制台手动建库，再把 `database_id` 填进 `wrangler.jsonc`。
5. **D1 外键约束**：`issue_mappings` 被 `comment_mappings.issue_id` 引用，删除映射前必须先删依赖的 `comment_mappings` 行，否则报 `SQLITE_CONSTRAINT_FOREIGNKEY`。
6. **GitHub App 的投递明细看不到响应体**：`GET /app/hook/deliveries/{id}` 只返回响应头，Worker 返回的具体错误信息只能从自己的日志里看。
7. **事件范围**：新建 issue 只做 Gitee → GitHub（GitHub 侧新建 issue 被显式跳过，避免回环）；评论双向；关闭 / 重开 / 标题正文编辑都不同步。

## 需要配置的 secrets

| 名称 | 说明 |
| --- | --- |
| `GITHUB_APP_ID` | GitHub App 的 App ID |
| `GITHUB_PRIVATE_KEY` | PKCS#8 私钥，单行 + 字面 `\n`（见第 4 节脚本） |
| `GITEE_WEBHOOK_SECRET` | 与 Gitee 仓库 Webhook 里填的“密码”一致 |
| `GITHUB_WEBHOOK_SECRET` | 与 GitHub App 的 Webhook secret 一致 |
| `ADMIN_PASSWORD` | Web 管理界面登录密码 |
| `GITEE_TOKEN` | 仅 GitHub → Gitee 评论回写需要，需 issues + notes 权限 |
| `GITHUB_TOKEN` | 可选的 PAT 兼容模式，与 GitHub App 二选一（App 优先） |

## 已知待改进

- 关闭 / 重开状态不同步（两个方向都不支持）。
- Gitee 端删除 issue 后映射会残留，目前是手动清理 + 日志提示；也可以做成检测到 404 自动清理映射，但 Gitee 偶发 404 会误删，需要权衡。
- 批量回灌没有写入节流：GitHub 对“内容创建”有二级限速（约 80 次/分钟、500 次/小时），而上游实现没有重试与退避，撞上限速会静默丢失。
