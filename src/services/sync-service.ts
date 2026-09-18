/**
 * 本文件修改自 OpenSiFli/gitee2github-issue（Apache-2.0，commit 836b381）。
 * 改动：1) GitHub 新建 issue 同步到 Gitee（原实现显式跳过）；
 *      2) 两侧关闭/重开状态双向同步，写前比对目标端状态以抑制事件回环；
 *      3) 建 issue 前查映射防止重复创建；无映射的事件软跳过（2xx）而非报 400。
 * 详见本仓库根目录 MODIFICATIONS.md。
 */
import { Env, Result, GiteeWebhookEvent, RepositoryMapping, IssueMapping } from '../types';
import { GiteeService } from './gitee-service';
import { GitHubService } from './github-service';

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

      // 根据事件类型处理
      if (event.hook_name === 'issue_hooks' && event.action === 'open') {
        // 处理新建Issue事件
        return await this.handleGiteeNewIssue(event, eventId);
      } else if ((event.hook_name === 'issue_hooks' || event.hook_name === 'note_hooks') && event.action === 'comment') {
        // 处理Issue评论事件
        return await this.handleGiteeNewComment(event, eventId);
      } else if (event.hook_name === 'issue_hooks' && ['close', 'closed', 'reopen', 'reopened'].includes(event.action)) {
        // 处理Issue关闭/重开事件
        return await this.handleGiteeIssueStateChange(event, eventId);
      }

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

      const issueTitle = event.issue.title;
      const issueBody = event.issue.body;
      const issueUrl = event.issue.html_url;
      const authorName = event.issue.user.login;

      // 格式化Issue内容
      const formattedBody = this.giteeService.formatIssueBody(
        issueBody,
        issueUrl,
        authorName
      );

      // 在GitHub上创建对应的Issue
      const createResult = await this.githubService.createIssue(
        repoMapping.github_owner,
        repoMapping.github_repo,
        issueTitle,
        formattedBody
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

      return { success: true, data: `成功同步Issue到GitHub: ${createResult.data!.html_url}` };
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
      const issueMapping = await this.getIssueMappingByGithub(issueNumber, repoMapping.id);
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

      const state: 'open' | 'closed' = event.action.startsWith('reopen') ? 'open' : 'closed';

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

      const authorName = event.issue.user?.login || 'unknown';
      const formattedBody = this.githubService.formatIssueBody(
        event.issue.body || '',
        event.issue.html_url,
        authorName
      );

      const createResult = await this.giteeService.createIssue(
        repoMapping.gitee_owner,
        repoMapping.gitee_repo,
        event.issue.title,
        formattedBody
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

      await this.saveWebhookEvent(eventId, 'issue_create', 'github');
      return { success: true, data: `已在 Gitee 创建对应 Issue: ${giteeIssue.html_url}` };
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

      const issueMapping = await this.getIssueMappingByGithub(issueNumber, repoMapping.id);
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
   * 一次性回灌：把 GitHub 侧还没有映射记录的 issue 补建到 Gitee。
   * 同步是事件驱动的，功能上线前就已经存在的 GitHub issue 不会被追溯，用这个接口补齐。
   * 关键顺序：建完 issue 立刻写 issue_mappings —— Gitee 会马上回传 open 事件，
   * 靠这条映射把它挡掉，否则会给同一条内容再建一个 GitHub issue。
   * limit 控制单次请求处理的条数（Worker 有执行时长上限，建议一次 3-5 条，反复调用即可）。
   */
  async backfillGitHubIssuesToGitee(
    repositoryId?: number,
    dryRun = false,
    limit = 4
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
      const queue: Array<{ repoMapping: RepositoryMapping; issue: any }> = [];

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
          if (!existing) {
            queue.push({ repoMapping, issue });
          }
        }
      }

      const batch = queue.slice(0, Math.max(1, limit));
      let processed = 0;

      for (const { repoMapping, issue } of batch) {
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
          issue.body,
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