-- 「Gitee 侧是不是别人改的」判定依据：我们上次写进 Gitee 的标题/正文/标签快照
-- 用法：npx wrangler d1 execute gitee2github_db --remote --file migrations/2026-09-23-gitee-snapshot.sql
--
-- 背景：Gitee 不为标签/标题/正文的改动投递 webhook，所以只能靠「拉」对齐；但 Gitee 的 updated_at
-- 会被**我们自己的写入**顶新（发镜像评论、改状态、挂标签都会），于是「updated_at 变了」根本不能
-- 证明是别人改的。曾经因此两次误判：拿 Gitee 的旧内容覆盖 GitHub 上刚改的内容
-- （#29 的 bug 标签被抹掉、#36 的标题被改回原名）。
--
-- gitee_snapshot：JSON，形如 {"title":"…","bodyHash":"…","labels":["a","b"]}，
-- 记录我们最后一次写进这条 Gitee issue 的标题 / 正文（去标注后的哈希）/ 标签集合。
-- 对齐时拿 Gitee 的当前值和它比：
--   一样  → Gitee 没被人动过（差异只可能来自 GitHub 侧）→ 绝不能用 Gitee 覆盖 GitHub；
--   不一样 → Gitee 被人改了 → 才允许拉到 GitHub。
-- 老数据是 NULL（没有快照）→ 按老逻辑处理，等我们下次写入时补上。

ALTER TABLE issue_mappings ADD COLUMN gitee_snapshot TEXT;
