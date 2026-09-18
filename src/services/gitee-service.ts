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