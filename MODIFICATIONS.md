# 本副本的改动与部署注意事项

## 来源声明

- 上游仓库：[OpenSiFli/gitee2github-issue](https://github.com/OpenSiFli/gitee2github-issue)（本副本基于其 `836b381`）
- 本副本：[LIPiston/gitee2github-issue](https://github.com/LIPiston/gitee2github-issue)
- **许可证**：上游以 **Apache-2.0 License** 授权（其 README「📄 许可证」段落声明，但仓库内未附 LICENSE 文件）。本副本沿用 Apache-2.0，并按该许可证第 4(b) 条在此声明：`src/index.ts`、`src/services/github-service.ts`、`src/services/gitee-service.ts`、`src/services/sync-service.ts`、`wrangler.jsonc` 五个文件已被修改，修改内容见下节。许可证正文见 [LICENSE](./LICENSE)。上游没有 NOTICE 文件，本副本也未新增。
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

### 4. src/services/sync-service.ts —— issue 创建与关闭/重开双向同步（新增能力）

上游只有「Gitee 建 issue → GitHub 建 issue」单向，且 GitHub 侧的 `issues.opened` 被显式跳过，关闭/重开完全没处理。本副本补上：

- **GitHub 建 issue → Gitee 建 issue**：`handleGitHubNewIssue`。正文附带来源标注（`formatIssueBody`，含原作者与原始链接），创建成功后写入 `issue_mappings` 建立双向映射。
- **关闭 / 重开双向同步**：Gitee 侧 `close` / `reopen` → `handleGiteeIssueStateChange`（调 GitHub `issues.update`）；GitHub 侧 `closed` / `reopened` → `handleGitHubIssueStateChange`（调 Gitee `PATCH /issues/{number}`）。
- **回环抑制**：写状态前先读目标端当前状态（`getIssueState`），已经是目标状态就直接跳过。否则「Gitee 关 → GitHub 关 → GitHub 发事件 → 又去关 Gitee」会来回写。
- **重复创建防护**：两边建 issue 前都先查 `issue_mappings`，已有映射的事件直接跳过（否则 Gitee→GitHub 建完之后，Gitee 那边回传的 `issue_hooks open` 会再建一个 GitHub issue，形成死循环）。
- **软跳过**：事件里的 issue 没有映射（不是同步创建的）时，返回 2xx + 说明文字并 `console.warn`，而不是 400——这类事件是正常情况，报 4xx 会让 Gitee / GitHub 的投递记录堆满失败。

### 5. scripts/encode-github-app-key.mjs（新增）

把 GitHub App 的 **PKCS#8** 私钥转成“单行 + 字面 `\n`”的字符串，供 `wrangler secret put` 使用，并在写入前用 `crypto.createPrivateKey` 自校验。

```bash
node scripts/encode-github-app-key.mjs /path/to/pkcs8-private-key.pem | npx wrangler secret put GITHUB_PRIVATE_KEY
```

### 6. Gitee 写 issue 的接口路径已变更（上游与各种教程都过时了）

Gitee 把「创建 / 更新 issue」的接口从 `/repos/{owner}/{repo}/issues[/{number}]` 挪到了 **owner 级**：

- 创建：`POST https://gitee.com/api/v5/repos/{owner}/issues`，表单字段带 `repo=<仓库路径>`、`title`、`body`
- 更新：`PATCH https://gitee.com/api/v5/repos/{owner}/issues/{number}`，表单字段带 `repo`、`state`（枚举只有 `open` / `progressing` / `closed`）
- 两者都是 `application/x-www-form-urlencoded`，不是 JSON

旧路径现在**只保留 GET**（issue 列表与详情照常用），任何写操作都会返回
`404 {"message":"project or enterprise"}`。这句话极具误导性——看起来像“仓库不存在”或“权限不足”，实际是路由已经不存在了；对照实验可以证明：拿一个不存在的仓库发同样的 POST，返回的是完全相同的这句话。

排查这类问题的正解：`GET https://gitee.com/api/v5/swagger_doc` 就是 Gitee 官方的 Swagger JSON（约 336 KB，直接可读），查 `paths` 即可确认当前真实路径与参数，不要去猜。

另外实测：**通过 API 修改 Gitee issue 状态不会触发 Gitee 的 webhook**（改了状态后 30 秒内没有任何投递）。所以 Gitee → GitHub 方向只对网页 / 人工操作生效，用 API 改 Gitee 状态不会回流到 GitHub。

### 7. POST /api/backfill —— 历史 issue 回灌（新增）

同步是事件驱动的，功能上线之前就存在于 GitHub 的 issue 不会被追溯。补了一个管理员接口：

```bash
curl -X POST https://<域>/api/backfill \
  -H "Authorization: Bearer <ADMIN_PASSWORD>" \
  -H 'Content-Type: application/json' \
  -d '{"dry_run": true, "limit": 50}'
```

- `dry_run: true` 只列出待灌清单，不写任何东西；`limit` 控制单次处理的条数。
- 每条的处理顺序：建 Gitee issue（正文带来源标注）→ **立刻**写 `issue_mappings` → 若 GitHub 侧是 closed 则跟着关闭。
- 顺序是关键：Gitee 建完 issue 会马上回传 `issue_hooks/open`，只有映射已经落库才能把它挡掉，否则会给同一条内容再建一个 GitHub issue。所以回灌必须在这个（同一个 Worker）请求里做，不能拿外部脚本“建一条、再慢慢写库”。
- Worker 有执行时长限制，`limit` 建议 3-5，反复调用直到 `remaining` 为 0（接口会把剩余条数返回）。
- 实测：12 条历史 issue（#2-#10、#12、#13、#15）一次灌完，Gitee 侧 15 条与 GitHub 侧一一对应，GitHub 侧没有多出任何一条（防重复逻辑在真实事件下生效 12 次）。

### 8. 标签同步（GitHub → Gitee，新增）

- **范围**：GitHub 建 issue 时复制标签、`labeled` / `unlabeled` 事件同步、`POST /api/backfill` 的 `{"mode":"labels"}` 用来补齐历史成对 issue 的标签（幂等，反复调用直到 `remaining` 为 0）。
- Gitee 的标签接口很挑，三个坑：
  1. 给 issue 加／替换标签的 body 是**裸数组** `["bug","feature"]`；写成 `{"labels":[...]}` 会 `Problems parsing JSON`。
  2. 创建**仓库标签**却要 **form 编码**（`name=...&color=...`）；发 JSON 会报“名字不合法”，其实是因为 JSON 没被解析、name 为空。
  3. **仓库里不存在的标签名会被静默丢弃**：加标签接口照样返回 201，但标签根本没加上（实测 `good first issue` 就是被吃掉的）。所以同步前必须先确保标签存在——本副本的 `ensureRepoLabels` 会按 GitHub 的名字与颜色自动建。
- 标签名限制：2-20 个字符，只允许汉字/字母/数字/`.`/`_`/`-`/`/`/`\` 与全角符号。名字不合法的（例如 GitHub 上常见的 `type: bug`）会被跳过并写日志，不影响同一事件里的其它同步。
- 两边标签集原本不同：GitHub 多出 accessibility / documentation / good first issue / help wanted，Gitee 多出 feature。当前策略是“缺失就按 GitHub 的名字与颜色在 Gitee 建一个”，因此补齐后 Gitee 侧标签集会向 GitHub 靠拢（实测已自动建出 accessibility、documentation）。
- **Gitee → GitHub 方向的标签同步未实现**：Gitee 是否在标签变化时投递 webhook 尚未验证；而且它的 API 改动一律不触发 webhook（见第 6 节）。

### 9. 标题 / 正文编辑同步（GitHub → Gitee，新增）

- **触发**：GitHub 的 `issues.edited` 事件，只处理 `changes` 里带 `title` 或 `body` 的编辑（改里程碑、置顶等同样会发 `issues.edited`，那些不含这两个字段，直接跳过）。
- **实现**：owner 级 `PATCH /repos/{owner}/issues/{number}`，表单字段 `repo` + 需要改的 `title`/`body`；改正文时会重新套用与创建时一致的来源标注（尾部 footer 不会被吃掉）。
- **为什么补**：这条路径原来完全没处理，而且很容易被误判成「回灌/创建流程有 bug」。实测案例：GitHub #19 创建时标题只有模板前缀 `[Bug]:`（issue 模板预填），作者 6 分钟后补全了标题；GitHub 侧显示正常，Gitee 侧永远停在 `[Bug]:`。看 GitHub 的 issue 时间线能直接定位：`renamed '[Bug]:' -> '[Bug]:数据采集…' @15:24:14`，而 Gitee 镜像创建于 `15:18:27`（open 事件后 6 秒）——**同步当时的标题就是 `[Bug]:`，创建流程没有错，缺的是编辑同步**。
- **回环风险**：无。用 API 改 Gitee 不触发它自己的 webhook（见第 6 节）。
- **未实现**：Gitee → GitHub 方向的编辑同步。Gitee 是否在编辑时投递 webhook、action 与载荷结构都还没观测到，等抓到真实事件再补。

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
7. **事件范围**（本副本已扩展）：issue 创建双向、评论双向、关闭/重开双向；标题与正文的后续编辑不同步；删除不同步（Gitee 端删除会留下映射，见第 3 节 404 诊断）。
8. **Gitee 的权限不足同样伪装成 404**：令牌缺 `issues` 权限时，写 issue 返回的还是 404（配合第 6 节的路径问题，会让人误判两次）。快速自检：`GET /api/v5/user/repos` —— 没 `projects` 权限时它会直接说 `401 Unauthorized: no 'projects' scope`；`/user`（user_info）与评论接口（notes）不受影响，所以会出现“能发评论但不能建 issue”这种诡异组合。
9. **写 Gitee 的接口用表单而不是 JSON**：把 JSON 发给 owner 级接口不会报参数错误，只会失败在别的地方（本次踩坑：路径错的时候 JSON/表单都是一样的 404，路径对了之后必须换成 `x-www-form-urlencoded`）。
10. **API 改动不触发 Gitee webhook**：用 API 关掉 Gitee issue，GitHub 侧不会跟着变（实测 30 秒无投递）。验收 Gitee → GitHub 方向必须在**网页**上操作，或者回放 webhook。
11. **「同步过去的内容不一致」先查 GitHub 的 issue 时间线，别先怀疑回灌**：Gitee 镜像标题只剩 `[Bug]:` 那次，`GET /repos/{owner}/{repo}/issues/{n}/timeline` 直接给出答案——`labeled @15:18:22`、`renamed '[Bug]:' -> '[Bug]:数据采集…' @15:24:14`，而镜像创建于 `15:18:27`。结论是「同步那一刻的标题就是这样，之后 6 分钟的编辑没人同步」。排查这类问题要先对齐两侧时间线，再判断是漏同步还是时序问题，否则会在回灌流程里白翻半天。

## 需要配置的 secrets

| 名称 | 说明 |
| --- | --- |
| `GITHUB_APP_ID` | GitHub App 的 App ID |
| `GITHUB_PRIVATE_KEY` | PKCS#8 私钥，单行 + 字面 `\n`（见第 4 节脚本） |
| `GITEE_WEBHOOK_SECRET` | 与 Gitee 仓库 Webhook 里填的“密码”一致 |
| `GITHUB_WEBHOOK_SECRET` | 与 GitHub App 的 Webhook secret 一致 |
| `ADMIN_PASSWORD` | Web 管理界面登录密码 |
| `GITEE_TOKEN` | GitHub → Gitee 方向的评论回写、建 issue、改状态都需要，**必须勾选 `issues` 与 `notes` 权限**；权限不足时 Gitee 会返回 404 `project or enterprise`（伪装成找不到仓库）或 401 `no 'projects' scope` |
| `GITHUB_TOKEN` | 可选的 PAT 兼容模式，与 GitHub App 二选一（App 优先） |

## 已知待改进

- Gitee → GitHub 方向的标题/正文编辑不同步（GitHub → Gitee 已实现，见第 9 节；反向需要先抓到 Gitee 的编辑事件）。
- Gitee 端删除 issue 或修改标题后的映射状态不主动校验（映射表只在创建时写入）。
- 同步是事件驱动的，只对「Webhook 事件发生之后」的改动生效；上线前已在 GitHub 侧建好的 issue 用 `POST /api/backfill`（见第 7 节）补，并且接口本身也没有节流重试。
- Gitee 端删除 issue 后映射会残留，目前是手动清理 + 日志提示；也可以做成检测到 404 自动清理映射，但 Gitee 偶发 404 会误删，需要权衡。
- 批量回灌没有写入节流：GitHub 对“内容创建”有二级限速（约 80 次/分钟、500 次/小时），而上游实现没有重试与退避，撞上限速会静默丢失。

## 线上验证记录（2026-09-18，Cloudflare Worker 实测）

| 方向 | 操作 | 判据 |
| --- | --- | --- |
| Gitee → GitHub | 网页/回放 `issue_hooks open` | 真实 Gitee webhook（hook_id 2127745）建出 GitHub issue 并落库映射 |
| Gitee → GitHub | 关闭 / 重开 | GitHub issue 状态与 `state_reason` 真的改变 |
| GitHub → Gitee | 新建 issue | Gitee 出现同名 issue（IKGYNG ↔ #16），正文带来源标注，映射 id=4 |
| GitHub → Gitee | 关闭 / 重开 | Gitee issue 状态跟着变（closed / open） |
| GitHub → Gitee | 评论回写 | Gitee 评论 51264768 ↔ GitHub 评论 5730066539 |
| 回环抑制 | 重复事件 | 返回「已经是 xxx 状态，跳过」，不再产生写回 |
| 软跳过 | 未映射 issue 的事件 | HTTP 200 + 说明文字（此前是 400） |
| 回灌 | `POST /api/backfill` | 12 条历史 issue 补建到 Gitee（#10/#4 连关闭状态一起镜像），映射总数 15，GitHub 侧未多出一条 |
| 标签 | GitHub → Gitee | 创建时复制、`labeled`/`unlabeled` 同步、缺失标签自动在 Gitee 建同名同色（accessibility、documentation 实测建出）；历史成对 issue 的标签用 `mode:"labels"` 补齐 8 条 |
| 编辑 | GitHub → Gitee | `issues.edited` 同步标题与正文：真实事件改 #17 正文后 Gitee IKGYR7 正文跟随（尾部来源标注保留）；#19 的标题用签名事件补齐，Gitee IKGYZA 由 `[Bug]:` 变为完整标题 |

补充：Gitee 令牌必须同时具备 `projects`（列仓库）、`issues`（建/改 issue）、`notes`（评论）三个权限；只给 `notes` 时会表现为“评论能同步、建 issue 报 404”。
