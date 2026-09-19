-- 定时对齐的「跳过未变动」优化所需的两列
-- 用法：npx wrangler d1 execute gitee2github_db --remote --file migrations/2026-09-19-reconcile-stamps.sql
-- （本地开发库同理，把 --remote 换成 --local）
--
-- gitee_updated_at：上次对齐时 Gitee issue 的 updated_at。Gitee 不为标签/标题/正文改动投递 webhook，
--   所以「这个值没变」就等于这条大概率没什么要对的 → 下一轮读一次 Gitee 详情就能直接返回，
--   每个成对 issue 只花 1 个子请求（单次调用的子请求硬上限是免费版 50）。
-- verified_at：上次完整比对的时间。事件同步偶发失败时 Gitee 侧也可能没变化，
--   只用 updated_at 会一直跳过 → 超过 7 天强制完整比对一次。

ALTER TABLE issue_mappings ADD COLUMN gitee_updated_at TEXT;
ALTER TABLE issue_mappings ADD COLUMN verified_at TEXT;
