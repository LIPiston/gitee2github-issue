/**
 * 本文件修改自 OpenSiFli/gitee2github-issue（Apache-2.0，commit 836b381）。
 * 改动：1) Gitee 密码校验加固（未配置 GITEE_WEBHOOK_SECRET 即拒绝，长度校验 + 常量时间比较）；
 *      2) 创建评论遇到 404 时返回「Gitee 端可能已删除该 issue」的诊断信息并记录日志。
 * 详见本仓库根目录 MODIFICATIONS.md。
 */
import { Env, Result, GiteeIssue, GiteeComment } from '../types';

export class GiteeService {
  private token: string;

  constructor(private env: Env) {
    this.token = env.GITEE_TOKEN;
  }

  /**
   * 验证Gitee Webhook签名
   */
  async verifyWebhookSignature(request: Request): Promise<boolean> {
    // Gitee使用简单的密码验证方式
    const secret = this.env.GITEE_WEBHOOK_SECRET;
    // 未配置密钥时必须拒绝：否则 data.password 与 undefined 比较会通过，端点等于全开
    if (!secret) {
      console.error('未配置 GITEE_WEBHOOK_SECRET，拒绝处理 Gitee Webhook');
      return false;
    }

    try {
      const data = await request.json() as any;
      const provided = data?.password;
      if (typeof provided !== 'string' || provided.length !== secret.length) {
        console.error('Gitee Webhook 密码校验失败');
        return false;
      }
      // 常量时间比较，避免时序侧信道
      let diff = 0;
      for (let i = 0; i < secret.length; i++) {
        diff |= provided.charCodeAt(i) ^ secret.charCodeAt(i);
      }
      if (diff !== 0) {
        console.error('Gitee Webhook 密码校验失败');
      }
      return diff === 0;
    } catch (error) {
      console.error('解析 Gitee Webhook 请求体失败:', error);
      return false;
    }
  }

  /**
   * 从Gitee获取Issue详情
   */
  async getIssue(owner: string, repo: string, issueNumber: string): Promise<Result<GiteeIssue>> {
    try {
      const response = await fetch(
        `https://gitee.com/api/v5/repos/${owner}/${repo}/issues/${issueNumber}`,
        {
          headers: {
            'Authorization': `token ${this.token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
        }
      );

      if (!response.ok) {
        const error = await response.text();
        return { success: false, error: `获取Gitee Issue失败: ${error}` };
      }

      const issue = await response.json();
      return { success: true, data: issue as GiteeIssue };
    } catch (error) {
      return { success: false, error: `获取Gitee Issue异常: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * 在 Gitee 创建 Issue（GitHub → Gitee 方向）
   * 需要令牌具备 issues 权限；权限不足时 Gitee 会返回 404（伪装）或 401
   */
  async createIssue(owner: string, repo: string, title: string, body: string): Promise<Result<GiteeIssue>> {
    try {
      const response = await fetch(
        `https://gitee.com/api/v5/repos/${owner}/${repo}/issues`,
        {
          method: 'POST',
          headers: {
            'Authorization': `token ${this.token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify({ title, body }),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        console.error(`在 Gitee 创建 Issue 失败: ${owner}/${repo} HTTP ${response.status} ${error}`);
        if (response.status === 404 || response.status === 401) {
          return {
            success: false,
            error:
              `创建Gitee Issue失败: HTTP ${response.status} ${error}` +
              `（通常是 Gitee 令牌缺少 issues 权限，或该仓库不允许写入）`,
          };
        }
        return { success: false, error: `创建Gitee Issue失败: ${error}` };
      }

      const issue = await response.json();
      return { success: true, data: issue as GiteeIssue };
    } catch (error) {
      return { success: false, error: `创建Gitee Issue异常: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * 读取 Gitee Issue 当前状态（用于判断是否需要写回，避免两侧来回写形成回环）
   */
  async getIssueState(owner: string, repo: string, issueNumber: string): Promise<Result<'open' | 'closed'>> {
    try {
      const response = await fetch(
        `https://gitee.com/api/v5/repos/${owner}/${repo}/issues/${issueNumber}`,
        {
          headers: {
            'Authorization': `token ${this.token}`,
            'Accept': 'application/json',
          },
        }
      );

      if (!response.ok) {
        return { success: false, error: `读取Gitee Issue状态失败: HTTP ${response.status}` };
      }

      const issue = (await response.json()) as { state?: string };
      const state: 'open' | 'closed' =
        issue.state === 'closed' || issue.state === 'rejected' ? 'closed' : 'open';
      return { success: true, data: state };
    } catch (error) {
      return { success: false, error: `读取Gitee Issue状态异常: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * 更新 Gitee Issue 状态（open / closed）
   * Gitee 的状态值还有 progressing / rejected，这里只用到 open 与 closed
   */
  async updateIssueState(
    owner: string,
    repo: string,
    issueNumber: string,
    state: 'open' | 'closed'
  ): Promise<Result<boolean>> {
    try {
      const response = await fetch(
        `https://gitee.com/api/v5/repos/${owner}/${repo}/issues/${issueNumber}`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `token ${this.token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify({ state }),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        console.error(
          `更新 Gitee Issue 状态失败: ${owner}/${repo} ${issueNumber} -> ${state} HTTP ${response.status} ${error}`
        );
        if (response.status === 404 || response.status === 401) {
          return {
            success: false,
            error:
              `更新Gitee Issue状态失败: HTTP ${response.status} ${error}` +
              `（通常是 Gitee 令牌缺少 issues 权限，或该 issue 已被删除）`,
          };
        }
        return { success: false, error: `更新Gitee Issue状态失败: ${error}` };
      }

      return { success: true, data: true };
    } catch (error) {
      return { success: false, error: `更新Gitee Issue状态异常: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * 创建评论
   */
  async createComment(owner: string, repo: string, issueNumber: string, body: string): Promise<Result<GiteeComment>> {
    try {
      const response = await fetch(
        `https://gitee.com/api/v5/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
        {
          method: 'POST',
          headers: {
            'Authorization': `token ${this.token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify({ body }),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        if (response.status === 404) {
          // 常见原因：Gitee 端的这个 issue 已经被删除，而 issue_mappings 里的映射还留着
          console.error(
            `Gitee 返回 404：${owner}/${repo} 的 issue ${issueNumber} 可能已在 Gitee 端被删除，` +
              `issue_mappings 中的对应映射已失效，建议清理后重新同步`
          );
          return {
            success: false,
            error:
              `创建Gitee评论失败: Gitee 返回 404 Not Found，可能是 Gitee 端已删除该 issue` +
              `（issue_mappings 中的映射已失效）: ${error}`,
          };
        }
        return { success: false, error: `创建Gitee评论失败: ${error}` };
      }

      const comment = await response.json();
      return { success: true, data: comment as GiteeComment };
    } catch (error) {
      return { success: false, error: `创建Gitee评论异常: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * 处理Gitee Issue正文，为同步到GitHub做准备
   */
  formatIssueBody(body: string, giteeIssueUrl: string, giteeAuthor: string): string {
    return `${body || ''}\n\n---\n> 🤖 此Issue由机器人从Gitee同步 | 原始作者: [${giteeAuthor}](https://gitee.com/${giteeAuthor}) | 原始链接: ${giteeIssueUrl}`;
  }

  /**
   * 处理Gitee评论，为同步到GitHub做准备
   */
  formatCommentBody(body: string, giteeAuthor: string): string {
    return `${body || ''}\n\n---\n> 🤖 此评论由机器人从Gitee同步 | 原始作者: [${giteeAuthor}](https://gitee.com/${giteeAuthor})`;
  }
}