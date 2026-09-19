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

另外更正一条早前的错误结论：**通过 API 修改 Gitee issue 状态是会投递 webhook 的**——`PATCH … state=closed`（issue 原本是 open）后约 10 秒内就收到了 `issue_hooks` 事件，action 名为 `state_change`。当初判「API 改状态不触发」，是因为测的那个 issue **已处于目标状态**（状态没变化，Gitee 自然不发事件）。真正一律不投递的是**标签 / 标题 / 正文的改动**（见第 12 节）。

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
- **Gitee → GitHub 方向的标签**：Gitee **不为**标签变更投递 webhook（实测：网页改一次、API 改一次，`wrangler tail` 里都没有任何标签事件），只能靠「拉取式对齐」补——见第 12 节。

### 9. 标题 / 正文编辑同步（GitHub → Gitee，新增）

- **触发**：GitHub 的 `issues.edited` 事件，只处理 `changes` 里带 `title` 或 `body` 的编辑（改里程碑、置顶等同样会发 `issues.edited`，那些不含这两个字段，直接跳过）。
- **实现**：owner 级 `PATCH /repos/{owner}/issues/{number}`，表单字段 `repo` + 需要改的 `title`/`body`；改正文时会重新套用与创建时一致的来源标注（尾部 footer 不会被吃掉）。
- **为什么补**：这条路径原来完全没处理，而且很容易被误判成「回灌/创建流程有 bug」。实测案例：GitHub #19 创建时标题只有模板前缀 `[Bug]:`（issue 模板预填），作者 6 分钟后补全了标题；GitHub 侧显示正常，Gitee 侧永远停在 `[Bug]:`。看 GitHub 的 issue 时间线能直接定位：`renamed '[Bug]:' -> '[Bug]:数据采集…' @15:24:14`，而 Gitee 镜像创建于 `15:18:27`（open 事件后 6 秒）——**同步当时的标题就是 `[Bug]:`，创建流程没有错，缺的是编辑同步**。
- **回环风险**：无。Gitee 不为正文编辑投递事件，改完不会回流（见第 12 节）。
- **Gitee → GitHub 方向**：Gitee **不为**标题 / 正文的编辑投递 webhook（2026-09-19 实测），所以那个方向只能靠「拉取式对齐」——见第 12 节。

### 10. 回环重复建 issue 的根因与修法（重要）

**现象**：跑了一夜之后，同一内容在两个平台各多出一条：
`#20(人) → IKH0CE(镜像) → #21(机器人) → IKH0CF(镜像)`、`#22(人) → IKH0M5(镜像) → #23(机器人) → IKH0M7(镜像)`。

**根因（实测）**：**Gitee 会为本服务用 API 建的 issue 也投递 `issue_hooks/open`**（注意：Gitee 的**创建**与**状态变化**都会投递事件，见第 6 节的更正）。于是：
1. GitHub 新建 #22 → 本服务在 Gitee 建镜像 IKH0M5，并写映射；
2. Gitee 为 IKH0M5 投递 open 事件 → 映射表查询/写入之间是竞态窗口（事件 2~3 秒内到达）→ 查不到映射 → 认为这是「Gitee 上的新 issue」→ 在 GitHub 建出 #23；
3. 反向映射写入时该 Gitee issue 已有映射（写入冲突/静默失败）→ #23 的 opened 事件又查不到映射 → 再在 Gitee 建出 IKH0M7；
4. 到 IKH0M7 才停下（它是全新 issue，映射写入成功）。

**修法**：不再依赖「查映射」这一道非确定性判断，改用**正文来源标记**做确定性守卫——本服务建的镜像 issue 正文里必然带 `🤖 此Issue由机器人从X同步`，两条建 issue 路径都先检查这个标记，命中就跳过（评论路径本来就有这个守卫，issue 路径漏了）。另外补上按 Gitee issue 编号查映射作兜底，并把未处理的 Gitee 事件落库（`unhandled:<hook>:<action>`）方便观测真实载荷。

**验证**：GitHub #25 → Gitee 只有 IKH1WO 一条，无机器人建的 GitHub issue；Gitee IKH1YM → GitHub #26 一条，无多余镜像。

### 11. Gitee → GitHub 的标签（新增）

- **创建时带上**：Gitee 建 issue 时把 Gitee 侧标签一并带到 GitHub。GitHub 对「给 issue 带上仓库里不存在的标签」是**直接报 422**，所以要先按同名同色在 GitHub 仓库里把标签建出来（`ensureRepoLabels`），再带着名字创建 issue。实测 `feature`（原本只存在于 Gitee，颜色 B5CC18）被自动建到 GitHub 且颜色一致。
- **Gitee 的 labels 字段**：建 issue 接口接受 `labels`（表单字段，逗号分隔），但**响应体里的 `labels` 可能是空的**——别据此判断是否生效，以标签接口为准。
- **未实现**：Gitee 侧「后续改标签」的事件同步。Gitee 是否在标签变更时投递 webhook、action 叫什么，目前还没有观测到；未处理的事件会以 `unhandled:<hook>:<action>` 落库，等抓到真实事件再补（在 Gitee 网页上改一次标签即可观测）。

### 12. Gitee → GitHub 的标签 / 标题 / 正文：为什么只能「拉」，怎么拉（新增）

**实测事实（2026-09-19，`wrangler tail` 观测）**：Gitee 只为建 issue、状态变化、评论投递 webhook。**标签、标题、正文的后续改动一律不投递**——在网页上改一次、用 API 改一次，tail 里都只有别的事件，没有任何标签/编辑事件到达。

所以 Gitee → GitHub 方向的「标签变更 / 编辑同步」不可能事件驱动，只能**读回 Gitee 当前状态再对齐**。本副本因此加了三条互为补充的「拉取式对齐」（全是幂等的，两侧一致时一个字节都不写）：

- `reconcileGiteeIssueToGithub()`：读 Gitee 的标题 / 正文 / 标签与 GitHub 的同样三项，只把有差异的字段写回 GitHub。正文比较前先剥掉尾部的来源标注；写回时保留 GitHub 侧**最早**的那条标注，避免归属被反复改写。
- **顺带对齐**：每次收到 Gitee 的 issue 事件（建 issue / 评论 / 状态变化）处理完后，顺手对该 issue 跑一次上面的对齐。这样「改完标签再评论一句」就能把标签带过去。
- **定时兜底（每天 05:00 与 17:00 各一轮）**：`wrangler.jsonc` 的 `triggers.crons = ["0 9,21 * * *"]`（**cron 表达式用 UTC**，09:00/21:00 UTC = 17:00/05:00 本地）。每轮把**全部**成对 issue 扫一遍（26 条实测 35 秒、0 失败），所以某条改动最迟 12 小时对齐。轮转窗口仍保留（`CRON_PERIOD_MS` = 12 小时，必须与 cron 周期一致），只有在成对 issue 超过 perRun=40 条时才真的分班。
  - **怎么做到一次扫完**：没变动过的成对 issue 只花 **1 个子请求**——读完 Gitee 详情比一下 `updated_at` 就返回（`issue_mappings.gitee_updated_at`）。单次调用的子请求硬上限是免费版 50，原来每对要 2~3 个，所以 26 条必挂（见踩坑 18）。
  - **防「跳过」把漂移永久藏起来**：GitHub → Gitee 的事件同步偶发失败时，Gitee 侧一点变化都没有，光看 `updated_at` 会一直跳过 → 所以记 `issue_mappings.verified_at`，超过 7 天强制完整比对一次。
  - 新增列由 `migrations/2026-09-19-reconcile-stamps.sql` 提供：`npx wrangler d1 execute gitee2github_db --remote --file migrations/2026-09-19-reconcile-stamps.sql`。
  - 日志会打印「处理 N 条，剩余 M 条，本轮改动 X 处，失败 Y 条」，失败非 0 时还会把每条的原因打出来（撞子请求上限就是这种表现）。
- **手动修**：`POST /api/backfill` 新增 `{"mode":"reconcile","limit":5,"offset":0}`（Bearer `ADMIN_PASSWORD`），用于立刻对齐或修复历史漂移；成对 issue 用若干个窗口跑一遍即可全覆盖（25 条 = 5 个窗口）。

**镜像创建期的竞态（顺带修掉）**：用户「建完 issue 立刻点标签」时，GitHub 的 `labeled` 事件比镜像创建 + 写映射（约 2~3 秒）先到，事件因查不到映射被丢掉——而 GitHub→Gitee 方向没有拉取兜底，这个标签就永远同步不过去。现在 GitHub 侧的处理器（标签 / 编辑 / 状态 / 评论）查不到映射时**等 4 秒再查一次**。实测无映射的探针事件耗时 1.8s → 5.8s，返回仍是软跳过的 200。`opened` 那条（自己负责创建映射）不加这个重试。

**顺带修掉的三个坑**：

1. **状态事件的 action 叫 `state_change`**（不是 `close` / `reopen`）。原来的分支只认 close/reopen，所以**真实 Gitee 关闭/重开从来没有同步过**（早前「验证过」用的是自己回放的签名事件，回放时用的 action 恰好是 close）。现在 `state_change` 也走状态同步，且状态以「读回 Gitee 的当前状态」为准——这类事件只告诉你状态变了，不告诉你是变成 open 还是 closed。
2. **正文来源标注会叠起来**：早先的「去尾」只剥掉最后一个标注，而历史正文里已经叠了 3 个（每同步一次多一段）→ 两侧内容永远不相等 → 每次对齐都再写一次、永不收敛。现在「去尾」循环剥掉**所有**尾部标注，写回时保留最早那条（内容的真实来源）。被写花的 4 条 issue 就此稳住（再跑两遍全部 `in_sync`）。
3. **Webhook 密码校验只认 body 里的 `password`**：真实事件同时带 `X-Gitee-Token` 头，个别事件类型可能只带其中一种，只认 body 会把合法事件以 400 丢掉（而且日志里什么都不留）。现在两种凭据都接受，仍然做常量时间比较。

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
10. **Gitee 的事件投递规律（含一条更正）**：会投递的只有三类——建 issue（`issue_hooks/open`）、状态变化（`issue_hooks/state_change`，**API 触发的也算**）、评论（`note_hooks/comment`）；**标签 / 标题 / 正文的改动一律不投递**（网页改、API 改都不发）。所以 Gitee → GitHub 的标签与编辑只能靠「拉」（第 12 节），而状态同步是可以事件驱动的。另外「状态没变化」时 Gitee 不会发事件——重复关闭一个已关闭的 issue，等多久都不会有请求进来。
11. **「同步过去的内容不一致」先查 GitHub 的 issue 时间线，别先怀疑回灌**：Gitee 镜像标题只剩 `[Bug]:` 那次，`GET /repos/{owner}/{repo}/issues/{n}/timeline` 直接给出答案——`labeled @15:18:22`、`renamed '[Bug]:' -> '[Bug]:数据采集…' @15:24:14`，而镜像创建于 `15:18:27`。结论是「同步那一刻的标题就是这样，之后 6 分钟的编辑没人同步」。排查这类问题要先对齐两侧时间线，再判断是漏同步还是时序问题，否则会在回灌流程里白翻半天。
12. **Gitee 会为自己 API 创建的 issue 投递 open webhook（状态变化同样会投递）**：这是「白天正常、跑一夜冒出重复 issue」的真凶。两条建 issue 路径的守卫必须是**确定性**的（正文里的来源标注），不能只查映射表——映射写入与 webhook 到达之间的竞态窗口有 2~3 秒。
13. **标签在两边的接口脾气完全不同**：Gitee 加标签要**裸数组** `["bug"]`、建仓库标签要 **form 编码**、不存在的标签名会被**静默丢弃**；GitHub 则相反——给 issue 带不存在的标签**直接 422**，必须先建标签（`ensureRepoLabels`）。另外 Gitee 建 issue 的 `labels` 表单字段是生效的，但**响应体里的 `labels` 可能是空的**，别据此判断成败。
14. **想知道一条重复 issue 是谁建的、从哪来，看作者 + 正文尾部**：机器人建的 issue 作者是 bot、正文尾部带 `🤖 此Issue由机器人从X同步 | 原始链接: …`。这一眼就能区分「平台原生」和「本服务的产物」，也能顺着链接还原整条回环链路（`#22 → IKH0M5 → #23 → IKH0M7`）。

18. **单次调用的子请求数是硬上限（免费版 50），它是批量回灌/批量对齐的真实天花板**：每对 issue 的比对默认要 2~3 个子请求（Gitee issue、GitHub issue、外加可能的标签读写），所以「一次能扫多少条」= 50 ÷ 每对开销。实测：每对 2~3 个时 26 条一起跑，前 16 条正常、后面 10 条全部报 `Too many subrequests by single Worker invocation`（任务本身没错，只是预算用完了）——而且错误是**逐条返回**的，别看到 HTTP 200 就以为全绿。
   想一次扫完就得压每对开销，两条经验：① Gitee 的 issue 详情里**自带 `labels`**，别再单独调一次标签接口；② 把「上次看到的源端 `updated_at`」存进映射表，源端没变就只读一次详情直接返回（每对 1 个子请求，26 条 35 秒跑完）。只做 ① 只能撑到 20 条左右，做 ② 才能随便扩。
19. **「跳过未变动」必须有强制复检兜底**：靠 `updated_at` 跳过的前提是「源端没变 = 两边一致」，但事件同步偶发失败时源端确实没变、目标端却已经漂了——光跳过就永远修不回来。存一个「上次完整比对时间」，超过 7 天强制完整比对一次。

15. **「API 改动不触发 webhook」这个结论是错的**：Gitee 用 API 改状态**会**投递（`state_change`，实测约 10 秒内到）。当初判「不触发」是因为测的 issue 已经处于目标状态——**状态没变，Gitee 就不发事件**。要分辨「没投递」和「投递了我没处理」，先确认操作真的改变了状态，再开 `wrangler tail` 看请求到没到（注意 tail 的日志条目**只带请求头、不带 body**，别指望从那里面读 action；未处理的 Gitee 事件会以 `unhandled:<hook>:<action>` 落库，这才是查 action 名的地方）。
16. **`wrangler tail --format json` 的输出是美化过的、跨多行的**：按 `\n{` 切块会漏解析，改用 `json.JSONDecoder().raw_decode()` 逐个取对象。
17. **改代码时别在正则里写 `\r`**：补丁工具会把 `\r?\n` 解析成真实回车，把正则拆成多行、直接编译不过（本次踩到，最后改成按行扫描的函数）。这类替换用脚本 + `newline=''` 读写更稳。

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
- Gitee → GitHub 方向的「后续标签变更」不同步（创建时已带上，见第 11 节；变更事件同样要先观测 Gitee 的载荷）。
- Gitee 端删除 issue 或修改标题后的映射状态不主动校验（映射表只在创建时写入）。
- 同步是事件驱动的，只对「Webhook 事件发生之后」的改动生效；上线前已在 GitHub 侧建好的 issue 用 `POST /api/backfill`（见第 7 节）补，并且接口本身也没有节流重试。
- Gitee 端删除 issue 后映射会残留，目前是手动清理 + 日志提示；也可以做成检测到 404 自动清理映射，但 Gitee 偶发 404 会误删，需要权衡。
- 批量回灌没有写入节流：GitHub 对“内容创建”有二级限速（约 80 次/分钟、500 次/小时），而上游实现没有重试与退避，撞上限速会静默丢失。

## 线上验证记录（2026-09-18 ~ 09-19，Cloudflare Worker 实测）

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
| 回环（重复建 issue） | 两个方向的真实事件 | GitHub #25（带 bug）→ Gitee 只出现一条镜像 IKH1WO，未再生成机器人建的 GitHub issue；Gitee 新建 IKH1YM（带 feature）→ GitHub 只有 #26 一条 |
| 标签 | Gitee → GitHub | 建 issue 时把 Gitee 标签一起带上：`feature`（原本只在 Gitee）被自动建到 GitHub #26，颜色 B5CC18 与 Gitee 一致 |
| 状态 | Gitee → GitHub（API 触发） | `PATCH … state=closed/open` 后约 10 秒收到 `issue_hooks/action=state_change`，GitHub #26 开关状态两次都跟随（修复前这条路径完全没被处理） |
| 标签 | Gitee → GitHub（后续变更） | IKH0MO 在网页加上 `bug` 后，GitHub #24 由 `[enhancement]` 变为 `[bug, enhancement]`；Gitee 全程未投递标签事件，靠 `mode:"reconcile"` 拉取完成 |
| 顺带对齐 | 一次真实的重开事件 | 同一次 `state_change` 事件里，Gitee 侧新增的 `documentation` 标签（从未投递过事件）被一并拉到 GitHub #26 |
| 幂等性 | `/api/backfill mode=reconcile` 跑两遍（25 条 × 5 窗口） | 第二遍全部 `in_sync`，包括此前反复被写的 4 条（正文标注堆叠问题已修） |
| 定时兜底 | `triggers.crons = 0 9,21 * * *` | 部署输出 `schedule: 0 9,21 * * *` 已注册（= 本地 17:00 / 05:00）；25 条时代实测 26 条一次跑完 **35.7 秒、0 失败**（改前 26 条从第 17 条起全报 Too many subrequests，证明「跳过未变动」确实把每对降到 1 个子请求）；连跑两轮均 0 改动；再真改一条 Gitee 标签 → 仍被扫出并同步（跳过逻辑没掩盖真实改动） |

补充：Gitee 令牌必须同时具备 `projects`（列仓库）、`issues`（建/改 issue）、`notes`（评论）三个权限；只给 `notes` 时会表现为“评论能同步、建 issue 报 404”。
