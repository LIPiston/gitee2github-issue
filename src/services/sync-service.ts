/**
 * 本文件修改自 OpenSiFli/gitee2github-issue（Apache-2.0，commit 836b381）。
 * 改动：1) GitHub 新建 issue 同步到 Gitee（原实现显式跳过）；
 *      2) 两侧关闭/重开状态双向同步，写前比对目标端状态以抑制事件回环；
 *      3) 建 issue 前查映射防止重复创建；无映射的事件软跳过（2xx）而非报 400；
 *      4) 标签同步（GitHub → Gitee）：创建时复制、labeled/unlabeled 事件、回灌补齐；
 *      5) 新增回灌方法（把 GitHub 侧历史 issue 补建到 Gitee，或只补齐标签）；
 *      6) 处理 issues.edited：把标题/正文的后续编辑同步到 Gitee（只认 changes 里带 title/body 的编辑）；
 *      7) 两个方向的建 issue 都加「正文来源标记 + 映射（id / 编号）」双重挡回环：Gitee 会为
 *         本服务用 API 建的 issue 投递 open webhook，只查映射表存在竞态，会造成来回重复建 issue；
 *      8) Gitee → GitHub 建 issue 时把 Gitee 侧标签一并带过去（缺失标签按同名同色在 GitHub 建出）；
 *      9) 未处理的 Gitee 事件也落库（event_type 记成 unhandled:<hook>:<action>），便于观测真实载荷。
 * 详见本仓库根目录 MODIFICATIONS.md。
 */
import { Env, Result, GiteeWebhookEvent, RepositoryMapping, IssueMapping } from '../types';
import { GiteeService } from './gitee-service';
import { GitHubService } from './github-service';

/**
 * 定时对齐的周期，必须与 wrangler.jsonc 里 triggers.crons 的周期保持一致
 * （当前：每天 05:00 与 17:00 各一次 = 12 小时）。轮转窗口按这个值推进，改成别的周期时要一起改。
 */
const CRON_PERIOD_MS = 12 * 60 * 60 * 1000;

/**
 * 一条成对 issue 距上次「完整比对」超过这个时间，就必须再完整比一次
 * （哪怕 Gitee 的 updated_at 没变）。这是给「GitHub → Gitee 的事件同步偶发失败」兜底：
 * 那种情况 Gitee 侧没有任何变化，光看 updated_at 会一直跳过，漂移就永远修不回来。
 */
const FULL_VERIFY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export class SyncService {
  private giteeService: GiteeService;
  private githubService: GitHubService;

  constructor(private env: Env) {
    this.giteeService = new GiteeService(env);
    this.githubService = new GitHubService(env);
  }

  /**
   * 处理Gitee的Webhook事件
   */
  async handleGiteeWebhook(request: Request): Promise<Result<string>> {
    try {
      // 验证Webhook签名
      const isValid = await this.giteeService.verifyWebhookSignature(request.clone());
      if (!isValid) {
        return { success: false, error: 'Gitee Webhook签名验证失败' };
      }

      const event = await request.json() as GiteeWebhookEvent;
      const eventId = `gitee-${event.hook_id}-${Date.now()}`;

      // 检查是否已处理过此事件
      const eventExists = await this.checkWebhookEventExists(eventId, 'gitee');
      if (eventExists) {
        return { success: true, data: '事件已处理过，跳过' };
      }

      // 根据事件类型处理。issue 类事件处理完后再补一次「拉取式对齐」：
      // Gitee 不为标签 / 标题 / 正文的后续编辑投递任何 webhook（实测网页改、API 改都不发），
      // 只能借每次事件的顺风车把两侧内容对齐（幂等，没差异时不写）。
      let result: Result<string> | null = null;
      if (event.hook_name === 'issue_hooks' && event.action === 'open') {
        // 处理新建Issue事件
        result = await this.handleGiteeNewIssue(event, eventId);
      } else if ((event.hook_name === 'issue_hooks' || event.hook_name === 'note_hooks') && event.action === 'comment') {
        // 处理Issue评论事件
        result = await this.handleGiteeNewComment(event, eventId);
      } else if (
        event.hook_name === 'issue_hooks' &&
        ['close', 'closed', 'reopen', 'reopened', 'state_change'].includes(event.action)
      ) {
        // 处理Issue关闭/重开事件（Gitee 真实事件里的 action 叫 state_change）
        result = await this.handleGiteeIssueStateChange(event, eventId);
      } else if (event.hook_name === 'issue_hooks' && event.issue) {
        // 其它 issue 事件（标签变更、标题/正文编辑、分配等）：Gitee 的 action 名不一定叫 label / edit，
        // 所以不猜——读回 Gitee 侧当前内容，对齐到 GitHub，只写真正有差异的字段（幂等）。
        return await this.handleGiteeIssueGeneric(event, eventId);
      }

      if (result && result.success && event.issue && event.repository?.full_name && event.action !== 'open') {
        const pulled = await this.pullAlignGiteeIssue(event.repository.full_name, event.issue);
        if (pulled) {
          result = { success: true, data: `${result.data}；顺带对齐：${pulled}` };
        }
      }
      if (result) {
        return result;
      }

      // 未处理的事件也落一条记录，方便观测 Gitee 到底会为哪些动作投递事件
      // （例如「标签变更」：在网页上试一次，再查 webhook_events 表就知道 action 叫什么）
      await this.saveWebhookEvent(
        eventId,
        `unhandled:${event.hook_name || '?'}:${event.action || '?'}`,
        'gitee'
      );
      console.warn(`未处理的 Gitee 事件: hook_name=${event.hook_name} action=${event.action}`);
      return { success: true, data: `不支持的事件类型: ${event.hook_name} ${event.action}` };
    } catch (error) {
      return { success: false, error: `处理Gitee Webhook异常: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * 处理GitHub的Webhook事件
   */
  async handleGitHubWebhook(request: Request): Promise<Result<string>> {
    try {
      // 验证Webhook签名
      const isValid = await this.githubService.verifyWebhookSignature(request.clone());
      if (!isValid) {
        return { success: false, error: 'GitHub Webhook签名验证失败' };
      }

      const event = await request.json() as any; // 使用octokit类型处理
      const eventType = request.headers.get('x-github-event') || 'unknown';
      const eventId = request.headers.get('x-github-delivery') || `github-${Date.now()}`;

      // 检查是否已处理过此事件
      const eventExists = await this.checkWebhookEventExists(eventId, 'github');
      if (eventExists) {
        return { success: true, data: '事件已处理过，跳过' };
      }

      // 根据事件类型处理
      if (eventType === 'issues' && event.action === 'opened') {
        // GitHub 新建 Issue -> 在 Gitee 上创建对应 Issue
        return await this.handleGitHubNewIssue(event, eventId);
      } else if (eventType === 'issues' && ['closed', 'reopened'].includes(event.action)) {
        // GitHub 关闭/重开 Issue -> 同步 Gitee 的状态
        return await this.handleGitHubIssueStateChange(event, eventId);
      } else if (eventType === 'issues' && ['labeled', 'unlabeled'].includes(event.action)) {
        // GitHub 增删标签 -> 同步到 Gitee
        return await this.handleGitHubLabelChange(event, eventId);
      } else if (eventType === 'issues' && event.action === 'edited') {
        // 标题 / 正文的后续编辑（例如先建 issue 再补全标题、改错字）
        return await this.handleGitHubIssueEdit(event, eventId);
      } else if (eventType === 'issue_comment' && event.action === 'created') {
        // 处理Issue评论事件
        return await this.handleGitHubNewComment(event, eventId);
      }

      return { success: true, data: `不支持的事件类型: ${eventType} ${event.action}` };
    } catch (error) {
      return { success: false, error: `处理GitHub Webhook异常: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * 读取 Gitee issue 的标签，并确保它们在 GitHub 仓库里存在（缺失的按同名同色新建）。
   * 返回可以安全写入 GitHub issue 的标签名数组。
   */
  private async resolveGithubLabelsForGiteeIssue(
    repoMapping: RepositoryMapping,
    giteeIssueNumber: string
  ): Promise<string[]> {
    try {
      const labelsResult = await this.giteeService.getIssueLabels(
        repoMapping.gitee_owner,
        repoMapping.gitee_repo,
        giteeIssueNumber
      );
      if (!labelsResult.success) {
        console.warn(`读取 Gitee ${giteeIssueNumber} 标签失败（不影响 issue 创建）: ${labelsResult.error}`);
        return [];
      }
      if (!labelsResult.data || labelsResult.data.length === 0) {
        return [];
      }

      const ensureResult = await this.githubService.ensureRepoLabels(
        repoMapping.github_owner,
        repoMapping.github_repo,
        labelsResult.data.map((label) => ({ name: label.name, color: label.color }))
      );
      if (!ensureResult.success) {
        console.warn(`准备 GitHub 标签失败（不影响 issue 创建）: ${ensureResult.error}`);
        return [];
      }
      return ensureResult.data!;
    } catch (error) {
      console.warn(`准备 GitHub 标签异常: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /**
   * 处理Gitee新建Issue事件
   */
  private async handleGiteeNewIssue(event: GiteeWebhookEvent, eventId: string): Promise<Result<string>> {
    try {
      if (!event.issue) {
        return { success: false, error: 'Issue信息不存在' };
      }

      // 从仓库路径解析owner和repo
      const [giteeOwner, giteeRepo] = event.repository.full_name.split('/');
      if (!giteeOwner || !giteeRepo) {
        return { success: false, error: `无效的仓库路径: ${event.repository.full_name}` };
      }

      // 查找仓库映射关系
      const repoMapping = await this.getRepositoryMapping(giteeOwner, giteeRepo);
      if (!repoMapping) {
        return { success: false, error: `找不到仓库映射关系: ${giteeOwner}/${giteeRepo}` };
      }

      const issueId = event.issue.id;
      const issueNumber = event.issue.number; // 这是Gitee的issue编号，如I123AB
      // 已有映射说明这条 issue 之前同步过（例如刚从 GitHub 方向创建过来的），跳过以免重复创建
      const existingMapping = await this.getIssueMapping(issueId, repoMapping.id);
      if (existingMapping) {
        return {
          success: true,
          data: `该 Issue 已同步过（GitHub #${existingMapping.github_issue_number}），跳过`,
        };
      }

      // 关键：Gitee 对我们用 API 建的 issue 也会投递 open webhook（实测会），
      // 那类镜像 issue 的正文带「从GitHub同步」标记。只靠映射表会有竞态（映射刚写入、webhook 已到达），
      // 所以用正文标记做确定性判断，直接跳过，否则两个平台会来回建 issue。
      if ((event.issue.body || '').includes('🤖 此Issue由机器人从GitHub同步')) {
        console.warn(`Gitee ${issueNumber} 正文带 GitHub 同步标记，是本服务建的镜像 issue，跳过`);
        return {
          success: true,
          data: `Gitee ${issueNumber} 是机器人从 GitHub 同步过来的镜像，跳过`,
        };
      }

      // 再兜一层：按 issue 编号查映射（万一 id 字段与映射表里存的不一致也能挡住）
      const existingByNumber = await this.getIssueMappingByGiteeNumber(issueNumber, repoMapping.id);
      if (existingByNumber) {
        return {
          success: true,
          data: `该 Issue 已有映射（GitHub #${existingByNumber.github_issue_number}），跳过`,
        };
      }

      const issueTitle = event.issue.title;
      const issueBody = event.issue.body;
      const issueUrl = event.issue.html_url;
      const authorName = event.issue.user.login;

      // 格式化Issue内容
      const formattedBody = this.giteeService.formatIssueBody(
        this.stripSyncFooter(issueBody),
        issueUrl,
        authorName
      );

      // 把 Gitee 侧的标签一起带过去：GitHub 对「给 issue 带上不存在的标签」是直接报 422，
      // 所以先按同名同色把缺失的标签在 GitHub 仓库里建出来，再带着名字创建 issue。
      const labelNames = await this.resolveGithubLabelsForGiteeIssue(repoMapping, issueNumber);

      // 在GitHub上创建对应的Issue
      const createResult = await this.githubService.createIssue(
        repoMapping.github_owner,
        repoMapping.github_repo,
        issueTitle,
        formattedBody,
        labelNames
      );

      if (!createResult.success) {
        return { success: false, error: createResult.error };
      }

      // 保存Issue映射关系，添加gitee_issue_number字段
      await this.saveIssueMapping({
        gitee_issue_id: issueId,
        gitee_issue_number: issueNumber, // 保存实际的issue编号
        github_issue_number: createResult.data!.number,
        repository_id: repoMapping.id,
        gitee_url: issueUrl,
        github_url: createResult.data!.html_url
      });

      // 记录已处理的事件
      await this.saveWebhookEvent(eventId, 'issue_open', 'gitee');

      return {
        success: true,
        data:
          `成功同步Issue到GitHub: ${createResult.data!.html_url}` +
          (labelNames.length > 0 ? `（标签: ${labelNames.join(', ')}）` : ''),
      };
    } catch (error) {
      return { success: false, error: `处理Gitee新建Issue异常: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * 处理Gitee新评论事件
   */
  private async handleGiteeNewComment(event: GiteeWebhookEvent, eventId: string): Promise<Result<string>> {
    try {
      if (!event.issue || !event.comment) {
        return { success: false, error: 'Issue或评论信息不存在' };
      }

      // 从仓库路径解析owner和repo
      const [giteeOwner, giteeRepo] = event.repository.full_name.split('/');
      if (!giteeOwner || !giteeRepo) {
        return { success: false, error: `无效的仓库路径: ${event.repository.full_name}` };
      }

      // 查找仓库映射关系
      const repoMapping = await this.getRepositoryMapping(giteeOwner, giteeRepo);
      if (!repoMapping) {
        return { success: false, error: `找不到仓库映射关系: ${giteeOwner}/${giteeRepo}` };
      }

      // 查找Issue映射关系
      const issueMapping = await this.getIssueMapping(event.issue.id, repoMapping.id);
      if (!issueMapping) {
        return { success: false, error: `找不到Issue映射关系: ${event.issue.id}` };
      }

      const commentId = event.comment.id;
      const commentBody = event.comment.body;
      const authorName = event.comment.user.login;

      // 检查评论内容是否已经包含 "由机器人从GitHub同步" 的标记，如果包含则不再同步
      if (commentBody.includes('🤖 此评论由机器人从GitHub同步')) {
        return { success: true, data: '跳过机器人同步的评论，避免循环同步' };
      }

      // 格式化评论内容
      const formattedBody = this.giteeService.formatCommentBody(commentBody, authorName);

      // 在GitHub上创建对应的评论
      const createResult = await this.githubService.createComment(
        repoMapping.github_owner,
        repoMapping.github_repo,
        issueMapping.github_issue_number,
        formattedBody
      );

      if (!createResult.success) {
        return { success: false, error: createResult.error };
      }

      // 保存评论映射关系
      await this.saveCommentMapping({
        gitee_comment_id: commentId,
        github_comment_id: createResult.data!.id,
        issue_id: issueMapping.id,
      });

      // 记录已处理的事件
      await this.saveWebhookEvent(eventId, 'comment_create', 'gitee');

      return { success: true, data: `成功同步Gitee评论到GitHub` };
    } catch (error) {
      return { success: false, error: `处理Gitee新评论异常: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * 处理GitHub新评论事件
   */
  private async handleGitHubNewComment(event: any, eventId: string): Promise<Result<string>> {
    try {
      const issueNumber = event.issue.number;
      const commentId = event.comment.id;
      const commentBody = event.comment.body;
      const authorName = event.comment.user.login;
      const [githubOwner, githubRepo] = event.repository.full_name.split('/');

      // 查找仓库映射关系
      const repoMapping = await this.getRepositoryMappingByGithub(githubOwner, githubRepo);
      if (!repoMapping) {
        return { success: false, error: `找不到仓库映射关系: ${githubOwner}/${githubRepo}` };
      }

      // 查找Issue映射关系
      const issueMapping = await this.getIssueMappingByGithubWithRetry(issueNumber, repoMapping.id);
      if (!issueMapping) {
        return { success: false, error: `找不到Issue映射关系: ${issueNumber}` };
      }

      // 检查评论内容是否已经包含 "由机器人从Gitee同步" 的标记，如果包含则不再同步
      if (commentBody.includes('🤖 此评论由机器人从Gitee同步')) {
        return { success: true, data: '跳过机器人同步的评论，避免循环同步' };
      }

      // 格式化评论内容
      const formattedBody = this.githubService.formatCommentBody(commentBody, authorName);

      // 在Gitee上创建对应的评论
      // 修改：使用gitee_issue_number而不是gitee_issue_id
      if (!issueMapping.gitee_issue_number) {
        return { success: false, error: `找不到对应的Gitee Issue编号` };
      }

      const giteeIssueNumber = issueMapping.gitee_issue_number; // 使用正确的issue编号
      const createResult = await this.giteeService.createComment(
        repoMapping.gitee_owner,
        repoMapping.gitee_repo,
        giteeIssueNumber,
        formattedBody
      );

      if (!createResult.success) {
        return { success: false, error: createResult.error };
      }

      // 保存评论映射关系
      await this.saveCommentMapping({
        gitee_comment_id: createResult.data!.id,
        github_comment_id: commentId,
        issue_id: issueMapping.id,
      });

      // 记录已处理的事件
      await this.saveWebhookEvent(eventId, 'comment_create', 'github');

      return { success: true, data: `成功同步GitHub评论到Gitee` };
    } catch (error) {
      return { success: false, error: `处理GitHub新评论异常: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * 处理Gitee Issue 关闭/重开事件（同步到 GitHub）
   */
  private async handleGiteeIssueStateChange(event: GiteeWebhookEvent, eventId: string): Promise<Result<string>> {
    try {
      if (!event.issue) {
        return { success: false, error: 'Issue信息不存在' };
      }

      const [giteeOwner, giteeRepo] = event.repository.full_name.split('/');
      const repoMapping = await this.getRepositoryMapping(giteeOwner, giteeRepo);
      if (!repoMapping) {
        return { success: false, error: `找不到仓库映射关系: ${giteeOwner}/${giteeRepo}` };
      }

      const issueMapping = await this.getIssueMapping(event.issue.id, repoMapping.id);
      if (!issueMapping) {
        // 不是同步创建的 issue（例如直接在 Gitee 侧新建后未建立映射）：软跳过，返回 2xx 避免 Gitee 记为投递失败
        console.warn(`Gitee issue ${event.issue.id} 没有映射记录，跳过状态同步`);
        return { success: true, data: `Gitee issue ${event.issue.id} 没有同步记录（非同步创建的 issue），跳过` };
      }

      // 状态以「从 Gitee 读回的当前状态」为准：state_change 这类 action 并不说明变成了什么状态
      let state: 'open' | 'closed' = event.action.startsWith('reopen') ? 'open' : 'closed';
      const liveState = await this.giteeService.getIssueState(
        repoMapping.gitee_owner,
        repoMapping.gitee_repo,
        issueMapping.gitee_issue_number
      );
      if (liveState.success && liveState.data) {
        state = liveState.data;
      }

      // 目标端已经是该状态时直接跳过（这种情况通常就是上一步写回造成的事件回环）
      const currentState = await this.githubService.getIssueState(
        repoMapping.github_owner,
        repoMapping.github_repo,
        issueMapping.github_issue_number
      );
      if (currentState.success && currentState.data === state) {
        return {
          success: true,
          data: `GitHub Issue #${issueMapping.github_issue_number} 已经是 ${state} 状态，跳过`,
        };
      }

      const updateResult = await this.githubService.updateIssueState(
        repoMapping.github_owner,
        repoMapping.github_repo,
        issueMapping.github_issue_number,
        state
      );
      if (!updateResult.success) {
        return { success: false, error: updateResult.error };
      }

      await this.saveWebhookEvent(eventId, `issue_${state}`, 'gitee');
      return {
        success: true,
        data: `已同步 Gitee ${state === 'closed' ? '关闭' : '重开'} 到 GitHub Issue #${issueMapping.github_issue_number}`,
      };
    } catch (error) {
      return { success: false, error: `处理Gitee Issue状态变更异常: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * Gitee 的标签名规则（2~20 个字符、不能带冒号）。
   * 用来判断「GitHub 上的某个标签在 Gitee 那边根本建不出来」，这类标签在对齐时不能删。
   */
  private isGiteeLabelNameValid(name: string): boolean {
    return GiteeService.isLabelNameValid(name);
  }

  /** 解析 Gitee 快照（JSON：{title, bodyHash, labels}） */
  private parseGiteeSnapshot(raw?: string | null): { title?: string; bodyHash?: string; labels?: string[] } | null {
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** 稳定的字符串哈希（只用于比对，不需要抗碰撞强度） */
  private hashText(text: string): string {
    let h = 5381;
    for (let i = 0; i < text.length; i += 1) {
      h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(16);
  }

  /**
   * 记下「我们刚写进 Gitee 的标题 / 正文 / 标签」。
   *
   * 为什么需要它：Gitee 不为标签/标题/正文的改动投递事件，只能靠「拉」对齐；而 Gitee 的
   * updated_at 会被**我们自己的写入**顶新（发镜像评论、改状态、挂标签都算），所以「updated_at
   * 变了」证明不了是别人改的。拿 Gitee 的当前值和我们写进去的快照比就分得清：
   *   一样   → Gitee 没被人动过，差异只可能来自 GitHub 侧 → 绝不能用 Gitee 覆盖 GitHub；
   *   不一样 → Gitee 被人改了 → 才允许拉到 GitHub。
   * 这两次误判（#29 的标签被抹、#36 的标题被改回原名）都是因为当时只会「Gitee 优先」。
   */
  private async saveGiteeSnapshot(
    repoMapping: RepositoryMapping,
    giteeIssueNumber: string,
    patch: { title?: string; content?: string; labels?: string[] }
  ): Promise<void> {
    try {
      const row = await this.env.DB.prepare(
        `SELECT gitee_snapshot FROM issue_mappings WHERE repository_id = ? AND gitee_issue_number = ?`
      )
        .bind(repoMapping.id, giteeIssueNumber)
        .first<{ gitee_snapshot?: string | null }>();
      const snapshot = this.parseGiteeSnapshot(row?.gitee_snapshot) || {};
      if (patch.title !== undefined) {
        snapshot.title = patch.title;
      }
      if (patch.content !== undefined) {
        snapshot.bodyHash = this.hashText(patch.content);
      }
      if (patch.labels !== undefined) {
        snapshot.labels = [...patch.labels].sort();
      }
      await this.env.DB.prepare(
        `UPDATE issue_mappings SET gitee_snapshot = ? WHERE repository_id = ? AND gitee_issue_number = ?`
      )
        .bind(JSON.stringify(snapshot), repoMapping.id, giteeIssueNumber)
        .run();
    } catch (error) {
      console.warn(`记录 Gitee 快照失败（不影响同步）: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 记录「这条成对 issue 刚做过一次完整比对」：Gitee 的 updated_at + 比对时间。
   * 下一轮对齐时若 Gitee 侧 updated_at 没变、且上次比对还比较新，就直接跳过
   * （未改动的成对 issue 只花 1 个子请求，这是能把全部 issue 放进一次调用的关键）。
   */
  private async saveIssueReconcileStamp(mappingId: number, giteeUpdatedAt: string): Promise<void> {
    if (!giteeUpdatedAt) {
      return;
    }
    try {
      await this.env.DB.prepare(
        `UPDATE issue_mappings SET gitee_updated_at = ?, verified_at = ? WHERE id = ?`
      )
        .bind(giteeUpdatedAt, new Date().toISOString(), mappingId)
        .run();
    } catch (error) {
      // 只是优化用的时间戳，写失败不影响同步本身
      console.warn(`记录对齐时间戳失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 判断某一行是不是同步来源标注
   */
  private isSyncFooterLine(line: string): boolean {
    const text = (line || '').trim();
    return text.startsWith('> 🤖 此') && text.includes('由机器人从');
  }

  /**
   * 取出正文里「最早」的一条来源标注：堆叠多份时它才是内容的真实来源，写回时保留它。
   */
  private extractSyncFooter(body: string): string | null {
    for (const line of (body || '').split('\n')) {
      if (this.isSyncFooterLine(line)) {
        return line.trim();
      }
    }
    return null;
  }

  /**
   * 去掉正文尾部「所有」同步来源标注（历史正文里可能堆叠了多份），只留真实内容。
   */
  private stripSyncFooter(body: string): string {
    const lines = (body || '').split('\n');
    let end = lines.length;
    while (end > 0) {
      let i = end - 1;
      while (i >= 0 && lines[i].trim() === '') {
        i -= 1;
      }
      if (i < 0 || !this.isSyncFooterLine(lines[i])) {
        break;
      }
      i -= 1; // 标注行本身
      while (i >= 0 && (lines[i].trim() === '---' || lines[i].trim() === '')) {
        i -= 1; // 标注行上面的分隔线与空行
      }
      end = i + 1;
    }
    return lines.slice(0, end).join('\n').trimEnd();
  }

  /**
   * 把 Gitee 侧的 issue 内容对齐到 GitHub（标题 / 正文 / 标签）。
   * 用于「Gitee 改了东西、但我们没收到（或不认识）对应事件」的场景：只写真正有差异的字段，重复调用幂等。
   */
  private async reconcileGiteeIssueToGithub(
    repoMapping: RepositoryMapping,
    issueMapping: IssueMapping
  ): Promise<Result<{ changed: string[]; held: string[] }>> {
    try {
      const giteeNumber = issueMapping.gitee_issue_number;
      if (!giteeNumber) {
        return { success: false, error: '找不到对应的Gitee Issue编号' };
      }

      const giteeResult = await this.giteeService.getIssue(
        repoMapping.gitee_owner,
        repoMapping.gitee_repo,
        giteeNumber
      );
      if (!giteeResult.success) {
        return { success: false, error: giteeResult.error };
      }
      const giteeIssue = giteeResult.data!;

      // 省子请求的关键一跳：Gitee 不投递标签/编辑事件，所以「Gitee 侧 updated_at 没变」
      // 基本就等于「这条没什么要对的」（GitHub → Gitee 方向是事件驱动的，不靠这里兜底）。
      // 但事件同步偶发失败时 Gitee 也可能没变化，所以每隔 FULL_VERIFY_INTERVAL_MS
      // 强制完整比对一次，避免漂移被永久跳过。
      const giteeUpdatedAt = giteeIssue.updated_at || '';
      const verifiedAt = issueMapping.verified_at ? Date.parse(issueMapping.verified_at) : NaN;
      const verifiedRecently =
        Number.isFinite(verifiedAt) && Date.now() - verifiedAt < FULL_VERIFY_INTERVAL_MS;
      if (giteeUpdatedAt && issueMapping.gitee_updated_at === giteeUpdatedAt && verifiedRecently) {
        return { success: true, data: { changed: [], held: [] } };
      }

      const githubResult = await this.githubService.getIssue(
        repoMapping.github_owner,
        repoMapping.github_repo,
        issueMapping.github_issue_number
      );
      if (!githubResult.success) {
        return { success: false, error: githubResult.error };
      }
      const githubIssue = githubResult.data!;

      // Gitee 侧到底有没有被人改过？拿 Gitee 的当前值和我们上次写进去的快照比。
      // Gitee 不为标签/标题/正文投递事件，而它的 updated_at 会被**我们自己的写入**顶新
      // （发镜像评论、改状态、挂标签都算），所以时间戳证明不了什么。只有「Gitee 的值和我们
      // 写进去的不一样」才说明是人改的；一样就说明差异只可能来自 GitHub 侧，绝不能覆盖 GitHub
      // （#29 的标签、#36 的标题都是被「Gitee 优先」这条老逻辑抹掉的）。
      // 没有快照（老数据 / Gitee 原生镜像）时按老逻辑处理，行为不变。
      const snapshot = this.parseGiteeSnapshot(issueMapping.gitee_snapshot);
      const giteeTitleByOthers =
        snapshot?.title === undefined ? true : (giteeIssue.title || '') !== snapshot.title;

      const changed: string[] = [];
      /** 两侧不一致、但判定为「GitHub 侧的新改动」因而没覆盖的字段（只记日志的话没人看得见） */
      const held: string[] = [];
      const patch: { title?: string; body?: string } = {};

      if ((giteeIssue.title || '') !== (githubIssue.title || '')) {
        if (giteeTitleByOthers) {
          patch.title = giteeIssue.title;
          changed.push('标题');
        } else {
          held.push('标题');
          console.log(
            `Gitee ${giteeNumber} 的标题与 GitHub #${issueMapping.github_issue_number} 不一致，` +
              `但与我们上次写进 Gitee 的标题相同 → 判定为 GitHub 侧的新改动，不覆盖（等 GitHub→Gitee 的事件同步）`
          );
        }
      }

      const giteeContent = this.stripSyncFooter(giteeIssue.body || '');
      const githubContent = this.stripSyncFooter(githubIssue.body || '');
      const giteeBodyByOthers =
        snapshot?.bodyHash === undefined ? true : this.hashText(giteeContent) !== snapshot.bodyHash;
      if (giteeContent !== githubContent) {
        if (giteeBodyByOthers) {
          // 保留 GitHub 侧已有的来源标注（堆叠多份时取最早那条 = 真实来源），没有才按 Gitee 来源补一个
          const existingFooter = this.extractSyncFooter(githubIssue.body || '');
          patch.body = existingFooter
            ? `${giteeContent}\n\n---\n${existingFooter}`
            : this.githubService.formatIssueBody(
                giteeContent,
                giteeIssue.html_url,
                giteeIssue.user?.login || 'unknown'
              );
          changed.push('正文');
        } else {
          held.push('正文');
          console.log(
            `Gitee ${giteeNumber} 的正文与 GitHub #${issueMapping.github_issue_number} 不一致，` +
              `但与我们上次写进 Gitee 的正文相同 → 判定为 GitHub 侧的新改动，不覆盖`
          );
        }
      }

      if (Object.keys(patch).length > 0) {
        const updateResult = await this.githubService.updateIssue(
          repoMapping.github_owner,
          repoMapping.github_repo,
          issueMapping.github_issue_number,
          patch
        );
        if (!updateResult.success) {
          return { success: false, error: updateResult.error };
        }
      }

      // 标签：Gitee → GitHub（反方向由 labeled / unlabeled 事件驱动）
      // 优先用 issue 详情里自带的 labels：单次调用的子请求数有硬上限（免费版 50），
      // 每省一次读取就能多扫几条 issue。只有详情没带这个字段时才单独去读。
      let giteeLabels: Array<{ name: string; color?: string }> | null = null;
      if (Array.isArray(giteeIssue.labels)) {
        giteeLabels = giteeIssue.labels;
      } else {
        const labelsResult = await this.giteeService.getIssueLabels(
          repoMapping.gitee_owner,
          repoMapping.gitee_repo,
          giteeNumber
        );
        if (labelsResult.success) {
          giteeLabels = labelsResult.data || [];
        }
      }
      if (giteeLabels) {
        const wanted = giteeLabels.map((label) => label.name).sort();
        const current = (githubIssue.labels || []).map((label) => label.name).sort();
        // Gitee 的标签名有硬性规则（2~20 位、不能带冒号），GitHub 上合法但 Gitee 建不出来的名字
        // （例如 `type: bug`）永远不可能出现在 Gitee 的集合里。这类标签在对齐时不能删，
        // 否则每轮「Gitee → GitHub」对齐都会把 GitHub 独有的它们抹一遍。
        const unrepresentable = current.filter((name) => !this.isGiteeLabelNameValid(name));
        const desired = Array.from(new Set([...wanted, ...unrepresentable])).sort();
        const giteeLabelsByOthers =
          snapshot?.labels === undefined
            ? true
            : wanted.join('|') !== [...snapshot.labels].sort().join('|');
        if (desired.join('|') !== current.join('|') && !giteeLabelsByOthers) {
          held.push(`标签(${current.join('、')})`);
          console.log(
            `Gitee ${giteeNumber} 的标签与 GitHub #${issueMapping.github_issue_number} 不一致，` +
              `但与我们上次写进 Gitee 的标签相同 → 判定为 GitHub 侧的新改动，不覆盖`
          );
        }
        if (desired.join('|') !== current.join('|') && giteeLabelsByOthers) {
          const ensureResult = await this.githubService.ensureRepoLabels(
            repoMapping.github_owner,
            repoMapping.github_repo,
            giteeLabels.map((label) => ({ name: label.name, color: label.color }))
          );
          if (!ensureResult.success) {
            return { success: false, error: ensureResult.error };
          }
          const finalLabels = Array.from(new Set([...(ensureResult.data || []), ...unrepresentable]));
          const labelResult = await this.githubService.setIssueLabels(
            repoMapping.github_owner,
            repoMapping.github_repo,
            issueMapping.github_issue_number,
            finalLabels
          );
          if (!labelResult.success) {
            return { success: false, error: labelResult.error };
          }
          changed.push(`标签(${finalLabels.join('、') || '清空'})`);
        }
      }

      // 这次比对之后，Gitee 的当前值就是「双方认可的基准」：记进快照。
      // 不记的话，快照会一直停留在更早的那次写入上，于是下一次 GitHub 侧的改动又会被
      // 判成「Gitee 改的」而覆盖回去（同一类 bug 的第三次复发）。
      await this.saveGiteeSnapshot(repoMapping, giteeNumber, {
        title: giteeIssue.title || '',
        content: giteeContent,
        labels: giteeLabels ? giteeLabels.map((label) => label.name).sort() : undefined,
      });

      // 记下这次完整比对的结果与时间：Gitee 侧没再更新的话，下一轮直接跳过（省子请求）
      await this.saveIssueReconcileStamp(issueMapping.id, giteeUpdatedAt);

      return { success: true, data: { changed, held } };
    } catch (error) {
      return {
        success: false,
        error: `对齐 Gitee → GitHub 异常: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * 处理 Gitee 侧「其它」issue 事件（action 名不认识的那些）：
   * 不猜 action 的语义，直接用「读回 Gitee 当前内容 → 对齐到 GitHub」兜底。
   */
  private async handleGiteeIssueGeneric(event: GiteeWebhookEvent, eventId: string): Promise<Result<string>> {
    try {
      if (!event.issue) {
        return { success: false, error: 'Issue信息不存在' };
      }

      const [giteeOwner, giteeRepo] = event.repository.full_name.split('/');
      const repoMapping = await this.getRepositoryMapping(giteeOwner, giteeRepo);
      if (!repoMapping) {
        return { success: false, error: `找不到仓库映射关系: ${giteeOwner}/${giteeRepo}` };
      }

      const issueMapping =
        (await this.getIssueMapping(event.issue.id, repoMapping.id)) ||
        (await this.getIssueMappingByGiteeNumber(String(event.issue.number), repoMapping.id));
      if (!issueMapping || !issueMapping.gitee_issue_number) {
        console.warn(`Gitee ${event.issue.number} 没有映射记录（action=${event.action}），跳过`);
        return { success: true, data: `Gitee ${event.issue.number} 没有同步记录（非同步创建的 issue），跳过` };
      }

      const reconcileResult = await this.reconcileGiteeIssueToGithub(repoMapping, issueMapping);
      if (!reconcileResult.success) {
        return { success: false, error: reconcileResult.error };
      }

      await this.saveWebhookEvent(eventId, `issue_${event.action || 'update'}`, 'gitee');
      const { changed = [], held = [] } = reconcileResult.data || {};
      const heldNote =
        held.length > 0
          ? `；${held.join('、')}与 GitHub 不一致，但判定为 GitHub 侧的新改动，未覆盖`
          : '';
      return {
        success: true,
        data:
          changed.length > 0
            ? `已把 Gitee ${event.issue.number} 的改动对齐到 GitHub #${issueMapping.github_issue_number}（${changed.join('、')}）${heldNote}`
            : `Gitee ${event.issue.number} 与 GitHub #${issueMapping.github_issue_number} 已一致，无需改动${heldNote}`,
      };
    } catch (error) {
      return {
        success: false,
        error: `处理Gitee其它Issue事件异常: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * 「拉取式」对齐：把 Gitee 侧当前的内容对齐到 GitHub。
   * Gitee 不会为标签/标题/正文的后续编辑投递 webhook，所以借每次 Gitee 事件的机会补一次。
   * 返回人类可读的说明；没有可做的事时返回 null。
   */
  private async pullAlignGiteeIssue(
    repositoryFullName: string,
    issue: { id: number; number: string }
  ): Promise<string | null> {
    try {
      const [giteeOwner, giteeRepo] = repositoryFullName.split('/');
      const repoMapping = await this.getRepositoryMapping(giteeOwner, giteeRepo);
      if (!repoMapping) {
        return null;
      }

      const issueMapping =
        (await this.getIssueMapping(issue.id, repoMapping.id)) ||
        (await this.getIssueMappingByGiteeNumber(issue.number, repoMapping.id));
      if (!issueMapping || !issueMapping.gitee_issue_number) {
        return null;
      }

      const reconcileResult = await this.reconcileGiteeIssueToGithub(repoMapping, issueMapping);
      if (!reconcileResult.success) {
        console.warn(`顺带对齐 Gitee ${issue.number} 失败: ${reconcileResult.error}`);
        return null;
      }

      const { changed = [], held = [] } = reconcileResult.data || {};
      const parts: string[] = [];
      if (changed.length > 0) {
        parts.push(`Gitee ${issue.number} 的${changed.join('、')}已对齐到 GitHub #${issueMapping.github_issue_number}`);
      }
      if (held.length > 0) {
        parts.push(
          `Gitee ${issue.number} 的${held.join('、')}与 GitHub 不一致，但判定为 GitHub 侧的新改动，未覆盖`
        );
      }
      return parts.length > 0 ? parts.join('；') : null;
    } catch (error) {
      console.warn(`顺带对齐异常: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * 定时兜底对齐（Cloudflare Cron 触发）：Gitee 侧的标签/标题/正文改动没有 webhook 通知，只能定期拉一遍。
   * 分班处理：单次调用的子请求数有硬上限（免费版 50）。没改动过的成对 issue 只用 1 个子请求
   * （读 Gitee 详情 + 比对 updated_at 就返回），所以一次能扫几十条；真变多了会自动按时间轮转分班。
   */
  async cronReconcile(
    perRun = 40
  ): Promise<Result<{ processed: number; remaining: number; changed: string[]; failed: number }>> {
    try {
      const allMappings = await this.getAllRepositoryMappings();
      if (allMappings.length === 0) {
        return { success: false, error: '没有可用的仓库映射' };
      }

      let total = 0;
      for (const repoMapping of allMappings) {
        const mappings = await this.getAllIssueMappings(repoMapping.id);
        total += mappings.filter((mapping) => mapping.gitee_issue_number).length;
      }
      if (total === 0) {
        return { success: true, data: { processed: 0, remaining: 0, changed: [], failed: 0 } };
      }

      // 按时间轮转窗口（周期与 cron 一致），不需要额外存状态
      const slots = Math.max(Math.ceil(total / perRun), 1);
      const slot = Math.floor(Date.now() / CRON_PERIOD_MS) % slots;

      const result = await this.backfillReconcileGiteeToGithub(undefined, false, perRun, slot * perRun);
      if (!result.success) {
        return { success: false, error: result.error };
      }

      const data = result.data!;
      const results = data.results || [];
      const changed = results
        .filter((item) => item.action === 'reconciled')
        .map(
          (item) =>
            `Gitee ${item.gitee_issue} → GitHub ${item.github_issue}（${(item.changed || []).join('、')}）`
        );

      // 失败要显式报出来：最常见的是撞上单次调用的子请求上限（Too many subrequests），
      // 那种情况下这一班的后半段等于白跑，得靠日志发现（否则只会看到“处理 N 条”）。
      const failed = results.filter((item) => item.action === 'error');
      if (failed.length > 0) {
        console.error(
          `定时对齐有 ${failed.length} 条失败：` +
            failed.map((item) => `${item.gitee_issue}:${item.detail || '未知错误'}`).join('；')
        );
      }

      return {
        success: true,
        data: { processed: data.processed, remaining: data.remaining, changed, failed: failed.length },
      };
    } catch (error) {
      return { success: false, error: `定时对齐异常: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * 处理GitHub新建Issue事件（在 Gitee 创建对应 Issue，并建立映射，避免回环）
   */
  private async handleGitHubNewIssue(event: any, eventId: string): Promise<Result<string>> {
    try {
      if (!event.issue) {
        return { success: false, error: 'Issue信息不存在' };
      }

      const [githubOwner, githubRepo] = event.repository.full_name.split('/');
      const repoMapping = await this.getRepositoryMappingByGithub(githubOwner, githubRepo);
      if (!repoMapping) {
        return { success: false, error: `找不到仓库映射关系: ${githubOwner}/${githubRepo}` };
      }

      // 已经由 Gitee 同步过来的 issue 会带映射，跳过以免重复创建
      const existingMapping = await this.getIssueMappingByGithub(event.issue.number, repoMapping.id);
      if (existingMapping) {
        return {
          success: true,
          data: `该 Issue 已由 Gitee 同步而来（Gitee ${existingMapping.gitee_issue_number}），跳过`,
        };
      }

      // 反向同理：本服务建到 GitHub 的镜像 issue（正文带「从Gitee同步」标记）也会触发 opened 事件，
      // App 建的 issue 再走一遍就会在 Gitee 多建一条，用正文标记确定性挡住。
      if ((event.issue.body || '').includes('🤖 此Issue由机器人从Gitee同步')) {
        console.warn(`GitHub #${event.issue.number} 正文带 Gitee 同步标记，是本服务建的镜像 issue，跳过`);
        return {
          success: true,
          data: `GitHub #${event.issue.number} 是机器人从 Gitee 同步过来的镜像，跳过`,
        };
      }

      const authorName = event.issue.user?.login || 'unknown';
      const formattedBody = this.githubService.formatIssueBody(
        this.stripSyncFooter(event.issue.body || ''),
        event.issue.html_url,
        authorName
      );

      // 先把标签在 Gitee 仓库里准备好（缺的按同名同色新建），创建时一并带上。
      // 不能「先建 issue、再挂标签」：那段空窗期里 Gitee 会为我们的创建投递 open 事件，
      // 顺风车对齐会把「暂时没标签」的镜像当权威源，反过来把 GitHub 的标签抹掉。
      const wantedLabels = (event.issue.labels || [])
        .map((label: any) => ({ name: String(label?.name || ''), color: label?.color }))
        .filter((label: any) => label.name.length > 0);
      let createLabels: string[] = [];
      if (wantedLabels.length > 0) {
        const ensureResult = await this.giteeService.ensureRepoLabels(
          repoMapping.gitee_owner,
          repoMapping.gitee_repo,
          wantedLabels
        );
        if (ensureResult.success) {
          createLabels = ensureResult.data!;
        } else {
          console.warn(`准备 Gitee 标签失败（不影响创建 issue）: ${ensureResult.error}`);
        }
      }

      const createResult = await this.giteeService.createIssue(
        repoMapping.gitee_owner,
        repoMapping.gitee_repo,
        event.issue.title,
        formattedBody,
        createLabels
      );
      if (!createResult.success) {
        return { success: false, error: createResult.error };
      }

      const giteeIssue = createResult.data!;
      await this.saveIssueMapping({
        gitee_issue_id: giteeIssue.id,
        gitee_issue_number: String(giteeIssue.number),
        github_issue_number: event.issue.number,
        repository_id: repoMapping.id,
        gitee_url: giteeIssue.html_url,
        github_url: event.issue.html_url,
      });

      // 顺带把标签复制过去（Gitee 里没有的标签会先建同名同色）
      const labelResult = await this.syncLabelsToGitee(
        repoMapping,
        String(giteeIssue.number),
        event.issue.labels || [],
        'set'
      );

      // 记下我们刚写进 Gitee 的标题/正文。用**创建响应里返回的值**（Gitee 的真实存储值），
      // 不是我们请求的值：Gitee 可能对标题/正文做截断或规整，快照一旦记成「我们以为的」，
      // 之后对齐就会把 Gitee 的真实状态判成「被人改过」，反过来覆盖 GitHub。
      await this.saveGiteeSnapshot(repoMapping, String(giteeIssue.number), {
        title: giteeIssue.title ?? event.issue.title,
        content: this.stripSyncFooter(giteeIssue.body ?? formattedBody),
      });

      await this.saveWebhookEvent(eventId, 'issue_create', 'github');
      return {
        success: true,
        data:
          `已在 Gitee 创建对应 Issue: ${giteeIssue.html_url}` +
          (labelResult.success && labelResult.data!.length > 0
            ? `（标签: ${labelResult.data!.join(', ')}）`
            : ''),
      };
    } catch (error) {
      return { success: false, error: `处理GitHub新建Issue异常: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * 处理GitHub Issue 关闭/重开事件（同步到 Gitee）
   */
  private async handleGitHubIssueStateChange(event: any, eventId: string): Promise<Result<string>> {
    try {
      const issueNumber = event.issue.number;
      const [githubOwner, githubRepo] = event.repository.full_name.split('/');

      const repoMapping = await this.getRepositoryMappingByGithub(githubOwner, githubRepo);
      if (!repoMapping) {
        return { success: false, error: `找不到仓库映射关系: ${githubOwner}/${githubRepo}` };
      }

      const issueMapping = await this.getIssueMappingByGithubWithRetry(issueNumber, repoMapping.id);
      if (!issueMapping) {
        // 该 GitHub issue 不是从 Gitee 同步来的：软跳过（返回 2xx），避免 GitHub 记为投递失败
        console.warn(`GitHub #${issueNumber} 没有映射记录，跳过状态同步`);
        return { success: true, data: `GitHub #${issueNumber} 没有同步记录（非同步创建的 issue），跳过` };
      }
      if (!issueMapping.gitee_issue_number) {
        return { success: false, error: '找不到对应的Gitee Issue编号' };
      }

      const state: 'open' | 'closed' = event.action === 'reopened' ? 'open' : 'closed';

      // 目标端已经是该状态时直接跳过（这种情况通常就是上一步写回造成的事件回环）
      const currentState = await this.giteeService.getIssueState(
        repoMapping.gitee_owner,
        repoMapping.gitee_repo,
        issueMapping.gitee_issue_number
      );
      if (currentState.success && currentState.data === state) {
        return {
          success: true,
          data: `Gitee ${issueMapping.gitee_issue_number} 已经是 ${state} 状态，跳过`,
        };
      }

      const updateResult = await this.giteeService.updateIssueState(
        repoMapping.gitee_owner,
        repoMapping.gitee_repo,
        issueMapping.gitee_issue_number,
        state
      );
      if (!updateResult.success) {
        return { success: false, error: updateResult.error };
      }

      await this.saveWebhookEvent(eventId, `issue_${state}`, 'github');
      return {
        success: true,
        data: `已同步 GitHub ${state === 'closed' ? '关闭' : '重开'} 到 Gitee ${issueMapping.gitee_issue_number}`,
      };
    } catch (error) {
      return { success: false, error: `处理GitHub Issue状态变更异常: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * 处理GitHub Issue 标题/正文编辑事件（同步到 Gitee）
   * issues.edited 也会因改里程碑、置顶等触发，那些情况不含 changes.title/body，直接跳过
   */
  private async handleGitHubIssueEdit(event: any, eventId: string): Promise<Result<string>> {
    try {
      const changes = event.changes || {};
      const titleChanged = Boolean(changes.title);
      const bodyChanged = Boolean(changes.body);
      if (!titleChanged && !bodyChanged) {
        return { success: true, data: '编辑事件不涉及标题或正文，跳过' };
      }

      const issueNumber = event.issue.number;
      const [githubOwner, githubRepo] = event.repository.full_name.split('/');
      const repoMapping = await this.getRepositoryMappingByGithub(githubOwner, githubRepo);
      if (!repoMapping) {
        return { success: false, error: `找不到仓库映射关系: ${githubOwner}/${githubRepo}` };
      }

      const issueMapping = await this.getIssueMappingByGithubWithRetry(issueNumber, repoMapping.id);
      if (!issueMapping || !issueMapping.gitee_issue_number) {
        // 非同步创建的 issue：软跳过（返回 2xx），避免 GitHub 记为投递失败
        console.warn(`GitHub #${issueNumber} 没有映射记录，跳过标题/正文同步`);
        return { success: true, data: `GitHub #${issueNumber} 没有同步记录（非同步创建的 issue），跳过` };
      }

      const patch: { title?: string; body?: string } = {};
      if (titleChanged) {
        patch.title = event.issue.title;
      }
      if (bodyChanged) {
        // Gitee 侧的正文保持与创建时相同的格式（尾部带来源标注）：
        // 先把正文里历史遗留的标注剥掉再拼，否则会越叠越多（每同步一次多一段）
        patch.body = this.githubService.formatIssueBody(
          this.stripSyncFooter(event.issue.body || ''),
          event.issue.html_url,
          event.issue.user?.login || 'unknown'
        );
      }

      const updateResult = await this.giteeService.updateIssueContent(
        repoMapping.gitee_owner,
        repoMapping.gitee_repo,
        issueMapping.gitee_issue_number,
        patch
      );
      if (!updateResult.success) {
        return { success: false, error: updateResult.error };
      }
      // 标题/正文写进了 Gitee：记下我们写进去的值（对齐时用来判断 Gitee 有没有被人改过，
      // 否则这之后任何一次对齐都可能把这次写入当成「Gitee 改的」，反过来覆盖 GitHub 上的新标题）
      // 记「我们写进去的值」= 写入请求成功那一刻的值。**不要**改成写后读回：
      // 读回要多一次 API 往返（约 1 秒），这段时间里快照会比 Gitee 的实际值新，
      // 一旦有并发推送（用户连着改两下就会），对齐就会把 Gitee 的旧值误判成「人改的」并拉回 GitHub。
      await this.saveGiteeSnapshot(repoMapping, issueMapping.gitee_issue_number, {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.body !== undefined ? { content: this.stripSyncFooter(patch.body) } : {}),
      });

      await this.saveWebhookEvent(eventId, 'issue_edited', 'github');
      const what = [titleChanged ? '标题' : null, bodyChanged ? '正文' : null]
        .filter(Boolean)
        .join('与');
      return {
        success: true,
        data: `已同步 GitHub #${issueNumber} 的${what}修改到 Gitee ${issueMapping.gitee_issue_number}`,
      };
    } catch (error) {
      return { success: false, error: `处理GitHub Issue编辑异常: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * 把 GitHub 的标签同步到 Gitee 的某个 issue 上。
   * mode='set' 用给定标签整体替换（创建 / 回灌 / 补齐时用）；mode='add' 只追加（labeled 事件用）。
   * Gitee 对「仓库里不存在的标签名」是静默丢弃（加标签接口照样返回 201），所以必须先确保标签存在。
   */
  private async syncLabelsToGitee(
    repoMapping: RepositoryMapping,
    giteeIssueNumber: string,
    labels: Array<{ name: string; color?: string }>,
    mode: 'set' | 'add'
  ): Promise<Result<string[]>> {
    try {
      const wanted = (labels || []).filter(
        (label) => label && typeof label.name === 'string' && label.name.length > 0
      );
      if (wanted.length === 0) {
        return { success: true, data: [] };
      }

      const ensureResult = await this.giteeService.ensureRepoLabels(
        repoMapping.gitee_owner,
        repoMapping.gitee_repo,
        wanted.map((label) => ({ name: label.name, color: label.color }))
      );
      if (!ensureResult.success) {
        return { success: false, error: ensureResult.error };
      }

      const names = ensureResult.data!;
      if (names.length === 0) {
        // 没有要挂的标签：Gitee 侧就是空的，快照也记成空的（否则对齐会把「Gitee 没有」误判成人改的）
        await this.saveGiteeSnapshot(repoMapping, giteeIssueNumber, { labels: [] });
        return { success: true, data: [] };
      }

      const writeResult =
        mode === 'set'
          ? await this.giteeService.setIssueLabels(
              repoMapping.gitee_owner,
              repoMapping.gitee_repo,
              giteeIssueNumber,
              names
            )
          : await this.giteeService.addIssueLabels(
              repoMapping.gitee_owner,
              repoMapping.gitee_repo,
              giteeIssueNumber,
              names
            );
      if (!writeResult.success) {
        return { success: false, error: writeResult.error };
      }

      // 快照记「Gitee 实际挂上的标签」（读回），不是我们请求的名字：
      // Gitee 对不合规的名字会静默丢弃，快照一旦记成「我们以为的」，对齐就会把
      // Gitee 的真实状态当成「被人改过」，反过来抹掉 GitHub 上的标签。
      let applied = names;
      const readBack = await this.giteeService.getIssueLabels(
        repoMapping.gitee_owner,
        repoMapping.gitee_repo,
        giteeIssueNumber
      );
      if (readBack.success && readBack.data) {
        applied = readBack.data.map((label) => label.name);
      }
      await this.saveGiteeSnapshot(repoMapping, giteeIssueNumber, { labels: applied });

      return { success: true, data: names };
    } catch (error) {
      return { success: false, error: `同步标签异常: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * 处理 GitHub 的 labeled / unlabeled 事件（同步到 Gitee）
   */
  private async handleGitHubLabelChange(event: any, eventId: string): Promise<Result<string>> {
    try {
      const issueNumber = event.issue?.number;
      const labelName = event.label?.name;
      if (!issueNumber || !labelName) {
        return { success: false, error: '事件缺少 issue 或 label 信息' };
      }

      const [githubOwner, githubRepo] = event.repository.full_name.split('/');
      const repoMapping = await this.getRepositoryMappingByGithub(githubOwner, githubRepo);
      if (!repoMapping) {
        return { success: false, error: `找不到仓库映射关系: ${githubOwner}/${githubRepo}` };
      }

      const issueMapping = await this.getIssueMappingByGithubWithRetry(issueNumber, repoMapping.id);
      if (!issueMapping) {
        console.warn(`GitHub #${issueNumber} 没有映射记录，跳过标签同步`);
        return { success: true, data: `GitHub #${issueNumber} 没有同步记录，跳过标签同步` };
      }
      if (!issueMapping.gitee_issue_number) {
        return { success: false, error: '找不到对应的Gitee Issue编号' };
      }

      const giteeNumber = issueMapping.gitee_issue_number;

      if (event.action === 'unlabeled') {
        const removeResult = await this.giteeService.removeIssueLabels(
          repoMapping.gitee_owner,
          repoMapping.gitee_repo,
          giteeNumber,
          [labelName]
        );
        if (!removeResult.success) {
          return { success: false, error: removeResult.error };
        }
        await this.saveWebhookEvent(eventId, 'label_remove', 'github');
        return { success: true, data: `已从 Gitee ${giteeNumber} 移除标签 ${labelName}` };
      }

      const addResult = await this.syncLabelsToGitee(
        repoMapping,
        giteeNumber,
        [{ name: labelName, color: event.label?.color }],
        'add'
      );
      if (!addResult.success) {
        return { success: false, error: addResult.error };
      }
      if (addResult.data!.length === 0) {
        return {
          success: true,
          data: `标签 ${labelName} 无法在 Gitee 创建（名字不符合 Gitee 规则），跳过`,
        };
      }

      await this.saveWebhookEvent(eventId, 'label_add', 'github');
      return { success: true, data: `已给 Gitee ${giteeNumber} 加标签 ${labelName}` };
    } catch (error) {
      return { success: false, error: `处理GitHub标签变更异常: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * 反向对齐：按映射逐条把 Gitee 侧的内容（标题 / 正文 / 标签）对齐到 GitHub。
   * 用于修复历史漂移，或 Gitee 那边改了东西、我们没收到（或不认识）事件的情况。幂等：内容一致时不写。
   */
  async backfillReconcileGiteeToGithub(
    repositoryId?: number,
    dryRun = false,
    limit = 5,
    offset = 0
  ): Promise<Result<{ processed: number; remaining: number; results: any[] }>> {
    try {
      const allMappings = await this.getAllRepositoryMappings();
      const repoMappings = repositoryId
        ? allMappings.filter((m) => m.id === repositoryId)
        : allMappings;

      if (repoMappings.length === 0) {
        return { success: false, error: '没有可用的仓库映射' };
      }

      const pairs: Array<{ repoMapping: RepositoryMapping; mapping: IssueMapping }> = [];
      for (const repoMapping of repoMappings) {
        const mappings = await this.getAllIssueMappings(repoMapping.id);
        for (const mapping of mappings) {
          if (mapping.gitee_issue_number) {
            pairs.push({ repoMapping, mapping });
          }
        }
      }

      // 已对齐的成对 issue 不会因为「跑过一次」而从队列里消失（每次调用都要重新读回两侧内容才能判断），
      // 所以用 offset 分段推进：offset 到哪就从哪继续，配合 limit 一次处理一小段。
      const batch = pairs.slice(offset, offset + limit);
      const results: any[] = [];

      if (dryRun) {
        for (const { mapping } of batch) {
          results.push({
            github_issue: `#${mapping.github_issue_number}`,
            gitee_issue: mapping.gitee_issue_number,
            action: 'would_reconcile',
          });
        }
        return {
          success: true,
          data: { processed: 0, remaining: Math.max(pairs.length - offset, 0), results },
        };
      }

      let processed = 0;
      for (const { repoMapping, mapping } of batch) {
        const reconcileResult = await this.reconcileGiteeIssueToGithub(repoMapping, mapping);
        processed += 1;
        const outcome = reconcileResult.data || { changed: [], held: [] };
        results.push({
          github_issue: `#${mapping.github_issue_number}`,
          gitee_issue: mapping.gitee_issue_number,
          action: reconcileResult.success
            ? outcome.changed.length > 0
              ? 'reconciled'
              : outcome.held.length > 0
                ? 'held'
                : 'in_sync'
            : 'error',
          changed: outcome.changed,
          held: outcome.held,
          detail: reconcileResult.success ? undefined : reconcileResult.error,
        });
        // 轻微节流，避免触发 GitHub 的二级限速
        await new Promise((resolve) => setTimeout(resolve, 700));
      }

      return {
        success: true,
        data: {
          processed,
          remaining: Math.max(pairs.length - offset - processed, 0),
          results,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `反向对齐异常: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * 一次性回灌：把 GitHub 侧还没有映射记录的 issue 补建到 Gitee。
   * 同步是事件驱动的，功能上线前就已经存在的 GitHub issue 不会被追溯，用这个接口补齐。
   * 关键顺序：建完 issue 立刻写 issue_mappings —— Gitee 会马上回传 open 事件，
   * 靠这条映射把它挡掉，否则会给同一条内容再建一个 GitHub issue。
   * limit 控制单次请求处理的条数（Worker 有执行时长上限，建议一次 3-5 条，反复调用即可）。
   */
  async backfillGitHubIssuesToGitee(
    repositoryId?: number,
    dryRun = false,
    limit = 4,
    mode: 'issues' | 'labels' = 'issues'
  ): Promise<Result<{ processed: number; remaining: number; results: any[] }>> {
    try {
      const allMappings = await this.getAllRepositoryMappings();
      const repoMappings = repositoryId
        ? allMappings.filter((m) => m.id === repositoryId)
        : allMappings;

      if (repoMappings.length === 0) {
        return { success: false, error: '没有可用的仓库映射' };
      }

      const results: any[] = [];
      const queue: Array<{ repoMapping: RepositoryMapping; issue: any; existing?: IssueMapping }> = [];

      for (const repoMapping of repoMappings) {
        const listResult = await this.githubService.listIssues(
          repoMapping.github_owner,
          repoMapping.github_repo
        );
        if (!listResult.success) {
          results.push({
            repository: `${repoMapping.github_owner}/${repoMapping.github_repo}`,
            action: 'error',
            detail: listResult.error,
          });
          continue;
        }

        for (const issue of listResult.data!) {
          const existing = await this.getIssueMappingByGithub(issue.number, repoMapping.id);
          if (mode === 'labels') {
            // labels 模式只处理已经成对的 issue：把 GitHub 的标签补齐到 Gitee
            // 已经一致的直接不入队，这样反复调用才会向前推进（否则永远卡在队首几条）
            if (existing) {
              const currentLabels = await this.giteeService.getIssueLabels(
                repoMapping.gitee_owner,
                repoMapping.gitee_repo,
                existing.gitee_issue_number
              );
              const wantedNames = (issue.labels || []).map((label: any) => label.name).sort();
              const currentNames = (currentLabels.data || []).map((label) => label.name).sort();
              const sameLabels =
                currentLabels.success &&
                wantedNames.length === currentNames.length &&
                wantedNames.every((name: string, index: number) => name === currentNames[index]);
              if (!sameLabels) {
                queue.push({ repoMapping, issue, existing });
              }
            }
          } else if (!existing) {
            queue.push({ repoMapping, issue });
          }
        }
      }

      const batch = queue.slice(0, Math.max(1, limit));
      let processed = 0;

      for (const { repoMapping, issue, existing } of batch) {
        if (mode === 'labels') {
          if (!existing?.gitee_issue_number) {
            results.push({
              github_issue: `#${issue.number}`,
              title: issue.title,
              action: 'skipped',
              detail: '缺少 Gitee 编号',
            });
            continue;
          }
          if (dryRun) {
            results.push({
              github_issue: `#${issue.number}`,
              gitee_issue: existing.gitee_issue_number,
              labels: (issue.labels || []).map((l: any) => l.name),
              action: 'would_apply_labels',
            });
            continue;
          }
          const labelResult = await this.syncLabelsToGitee(
            repoMapping,
            existing.gitee_issue_number,
            issue.labels || [],
            'set'
          );
          processed += 1;
          results.push({
            github_issue: `#${issue.number}`,
            gitee_issue: existing.gitee_issue_number,
            action: labelResult.success ? 'labels_synced' : 'error',
            labels: labelResult.data || [],
            detail: labelResult.success ? undefined : labelResult.error,
          });
          await new Promise((resolve) => setTimeout(resolve, 800));
          continue;
        }

        if (dryRun) {
          results.push({
            github_issue: `#${issue.number}`,
            gitee_repo: `${repoMapping.gitee_owner}/${repoMapping.gitee_repo}`,
            title: issue.title,
            state: issue.state,
            action: 'would_create',
          });
          continue;
        }

        const formattedBody = this.githubService.formatIssueBody(
          this.stripSyncFooter(issue.body || ''),
          issue.html_url,
          issue.author
        );
        const createResult = await this.giteeService.createIssue(
          repoMapping.gitee_owner,
          repoMapping.gitee_repo,
          issue.title,
          formattedBody
        );
        if (!createResult.success) {
          results.push({
            github_issue: `#${issue.number}`,
            title: issue.title,
            action: 'error',
            detail: createResult.error,
          });
          continue;
        }

        const giteeIssue = createResult.data!;
        await this.saveIssueMapping({
          gitee_issue_id: giteeIssue.id,
          gitee_issue_number: String(giteeIssue.number),
          github_issue_number: issue.number,
          repository_id: repoMapping.id,
          gitee_url: giteeIssue.html_url,
          github_url: issue.html_url,
        });

        // 顺带把标签复制过去（Gitee 里没有的会先建同名同色）
        const labelResult = await this.syncLabelsToGitee(
          repoMapping,
          String(giteeIssue.number),
          issue.labels || [],
          'set'
        );

        let stateSynced: boolean | null = null;
        if (issue.state === 'closed') {
          const stateResult = await this.giteeService.updateIssueState(
            repoMapping.gitee_owner,
            repoMapping.gitee_repo,
            String(giteeIssue.number),
            'closed'
          );
          stateSynced = stateResult.success;
          if (!stateResult.success) {
            console.warn(`回灌后同步关闭状态失败: Gitee ${giteeIssue.number} ${stateResult.error}`);
          }
        }

        processed += 1;
        results.push({
          github_issue: `#${issue.number}`,
          gitee_issue: giteeIssue.number,
          title: issue.title,
          state: issue.state,
          state_synced: stateSynced,
          labels: labelResult.success ? labelResult.data : [],
          labels_error: labelResult.success ? undefined : labelResult.error,
          action: 'created',
        });

        // 轻微节流，避免触发 Gitee 写接口的频率限制
        await new Promise((resolve) => setTimeout(resolve, 1100));
      }

      return {
        success: true,
        data: {
          processed,
          remaining: Math.max(0, queue.length - batch.length),
          results,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `回灌异常: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  //==========================
  // 数据库操作方法
  //==========================

  /**
   * 检查Webhook事件是否已处理
   */
  private async checkWebhookEventExists(eventId: string, source: 'gitee' | 'github'): Promise<boolean> {
    try {
      const result = await this.env.DB.prepare(
        `SELECT id FROM webhook_events WHERE event_id = ? AND source = ?`
      )
        .bind(eventId, source)
        .first<{ id: number }>();
      return !!result;
    } catch {
      return false;
    }
  }

  /**
   * 保存Webhook事件处理记录
   */
  private async saveWebhookEvent(eventId: string, eventType: string, source: 'gitee' | 'github'): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO webhook_events (event_id, event_type, source) VALUES (?, ?, ?)`
    )
      .bind(eventId, eventType, source)
      .run();
  }

  /**
   * 获取仓库映射
   */
  private async getRepositoryMapping(giteeOwner: string, giteeRepo: string): Promise<RepositoryMapping | null> {
    try {
      const result = await this.env.DB.prepare(
        `SELECT * FROM repository_mappings WHERE gitee_owner = ? AND gitee_repo = ?`
      )
        .bind(giteeOwner, giteeRepo)
        .first<RepositoryMapping>();
      return result || null;
    } catch {
      return null;
    }
  }

  /**
   * 根据GitHub仓库信息获取仓库映射
   */
  private async getRepositoryMappingByGithub(githubOwner: string, githubRepo: string): Promise<RepositoryMapping | null> {
    try {
      const result = await this.env.DB.prepare(
        `SELECT * FROM repository_mappings WHERE github_owner = ? AND github_repo = ?`
      )
        .bind(githubOwner, githubRepo)
        .first<RepositoryMapping>();
      return result || null;
    } catch {
      return null;
    }
  }

  /**
   * 保存仓库映射
   */
  async saveRepositoryMapping(mapping: Omit<RepositoryMapping, 'id' | 'created_at'>): Promise<number> {
    const result = await this.env.DB.prepare(
      `INSERT INTO repository_mappings (gitee_owner, gitee_repo, github_owner, github_repo)
       VALUES (?, ?, ?, ?)
       RETURNING id`
    )
      .bind(mapping.gitee_owner, mapping.gitee_repo, mapping.github_owner, mapping.github_repo)
      .first<{ id: number }>();
    
    return result?.id || 0;
  }

  /**
   * 获取Issue映射
   */
  private async getIssueMapping(giteeIssueId: number, repositoryId: number): Promise<IssueMapping | null> {
    try {
      const result = await this.env.DB.prepare(
        `SELECT * FROM issue_mappings WHERE gitee_issue_id = ? AND repository_id = ?`
      )
        .bind(giteeIssueId, repositoryId)
        .first<IssueMapping>();
      return result || null;
    } catch {
      return null;
    }
  }

  /**
   * 根据Gitee Issue编号获取Issue映射（编号形如 IKH0M5；与 gitee_issue_id 互为兜底）
   */
  private async getIssueMappingByGiteeNumber(giteeIssueNumber: string, repositoryId: number): Promise<IssueMapping | null> {
    try {
      const result = await this.env.DB.prepare(
        `SELECT * FROM issue_mappings WHERE gitee_issue_number = ? AND repository_id = ?`
      )
        .bind(giteeIssueNumber, repositoryId)
        .first<IssueMapping>();
      return result || null;
    } catch {
      return null;
    }
  }

  /**
   * 读取某个仓库下的全部 issue 映射
   */
  private async getAllIssueMappings(repositoryId: number): Promise<IssueMapping[]> {
    try {
      const result = await this.env.DB.prepare(
        `SELECT * FROM issue_mappings WHERE repository_id = ?`
      )
        .bind(repositoryId)
        .all<IssueMapping>();
      return result.results || [];
    } catch {
      return [];
    }
  }

  /**
   * 按 GitHub issue 编号查映射；查不到时等几秒再查一次。
   * 原因：GitHub 的 labeled / edited / closed / 评论 事件可能比镜像创建（约 2~3 秒）先到——
   * 事件本身没问题，只是映射还没写进库，重试一次就能接上；不重试的话这次改动会永久丢掉
   * （实测：建完 issue 立刻点标签，就会撞上这个窗口）。
   */
  private async getIssueMappingByGithubWithRetry(
    githubIssueNumber: number,
    repositoryId: number,
    attempts = 5,
    intervalMs = 2500
  ): Promise<IssueMapping | null> {
    // 镜像创建是「建 issue → 挂标签 → 写映射」的多步流程（实测 6~7 秒），
    // 用户在创建后立刻点标签/改标题时，事件会比映射先到。只等一次（4000ms）不够，
    // 改成轮询：查到就走，最多等 attempts × intervalMs（默认 10 秒）。
    for (let i = 0; i < attempts; i += 1) {
      const found = await this.getIssueMappingByGithub(githubIssueNumber, repositoryId);
      if (found) {
        return found;
      }
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
    return null;
  }

  /**
   * 根据GitHub Issue获取Issue映射
   */
  private async getIssueMappingByGithub(githubIssueNumber: number, repositoryId: number): Promise<IssueMapping | null> {
    try {
      const result = await this.env.DB.prepare(
        `SELECT * FROM issue_mappings WHERE github_issue_number = ? AND repository_id = ?`
      )
        .bind(githubIssueNumber, repositoryId)
        .first<IssueMapping>();
      return result || null;
    } catch {
      return null;
    }
  }

  /**
   * 保存Issue映射
   */
  private async saveIssueMapping(mapping: Omit<IssueMapping, 'id' | 'created_at'>): Promise<number> {
    const result = await this.env.DB.prepare(
      `INSERT INTO issue_mappings (gitee_issue_id, gitee_issue_number, github_issue_number, repository_id, gitee_url, github_url)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING id`
    )
      .bind(
        mapping.gitee_issue_id,
        mapping.gitee_issue_number,
        mapping.github_issue_number,
        mapping.repository_id,
        mapping.gitee_url,
        mapping.github_url
      )
      .first<{ id: number }>();
    
    return result?.id || 0;
  }

  /**
   * 保存评论映射
   */
  private async saveCommentMapping(mapping: {
    gitee_comment_id: number | null;
    github_comment_id: number | null;
    issue_id: number;
  }): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO comment_mappings (gitee_comment_id, github_comment_id, issue_id)
       VALUES (?, ?, ?)`
    )
      .bind(mapping.gitee_comment_id, mapping.github_comment_id, mapping.issue_id)
      .run();
  }

  /**
   * 获取所有仓库映射
   */
  async getAllRepositoryMappings(): Promise<RepositoryMapping[]> {
    try {
      const result = await this.env.DB.prepare(
        `SELECT * FROM repository_mappings ORDER BY id DESC`
      ).all<RepositoryMapping>();
      
      return result.results || [];
    } catch (error) {
      console.error('获取仓库映射失败:', error);
      return [];
    }
  }

  /**
   * 删除仓库映射
   */
  async deleteRepositoryMapping(id: number): Promise<Result<boolean>> {
    try {
      // 查找是否有关联的issue映射
      const issueMapping = await this.env.DB.prepare(
        `SELECT id FROM issue_mappings WHERE repository_id = ? LIMIT 1`
      )
        .bind(id)
        .first<{ id: number }>();

      if (issueMapping) {
        return { 
          success: false, 
          error: '无法删除：此仓库映射已关联issue，删除可能会破坏同步功能' 
        };
      }

      // 如果没有关联issue，可以安全删除
      await this.env.DB.prepare(
        `DELETE FROM repository_mappings WHERE id = ?`
      ).bind(id).run();

      return { success: true, data: true };
    } catch (error) {
      return { 
        success: false, 
        error: `删除仓库映射失败: ${error instanceof Error ? error.message : String(error)}` 
      };
    }
  }
}