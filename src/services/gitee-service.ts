/**
 * 本文件修改自 OpenSiFli/gitee2github-issue（Apache-2.0，commit 836b381）。
 * 改动：1) Gitee 密码校验加固（未配置 GITEE_WEBHOOK_SECRET 即拒绝，长度校验 + 常量时间比较）；
 *      2) 创建评论遇到 404 时返回「Gitee 端可能已删除该 issue」的诊断信息并记录日志；
 *      3) 创建/更新 issue 改用 owner 级路径 /repos/{owner}/issues[/{number}] + 表单编码
 *         （旧的 /repos/{owner}/{repo}/issues 写操作已失效，只返回 404 project or enterprise）；
 *      4) 新增标签相关方法（加/换/删 issue 标签、读仓库标签、按 GitHub 名字与颜色补建标签）；
 *      5) 新增 updateIssueContent（owner 级 PATCH 同步标题/正文的后续编辑）。
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
   * 注意路径是 /repos/{owner}/issues（仓库路径放在表单字段 repo 里），
   * 旧的 /repos/{owner}/{repo}/issues 现在只支持 GET，写操作会返回
   * 404 {"message":"project or enterprise"}（Gitee 2026 起改成 owner 级路径）
   * 需要令牌具备 issues 权限
   */
  async createIssue(owner: string, repo: string, title: string, body: string): Promise<Result<GiteeIssue>> {
    try {
      const response = await fetch(
        `https://gitee.com/api/v5/repos/${owner}/issues`,
        {
          method: 'POST',
          headers: {
            'Authorization': `token ${this.token}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
          },
          body: new URLSearchParams({ repo, title, body }).toString(),
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
              `（通常是 Gitee 令牌缺少 issues 权限，或仓库路径 repo 字段写错）`,
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
   * 路径同样是 owner 级：/repos/{owner}/issues/{number}，仓库路径放在表单字段 repo 里
   * Gitee 允许的 state：open / progressing / closed
   */
  async updateIssueState(
    owner: string,
    repo: string,
    issueNumber: string,
    state: 'open' | 'closed'
  ): Promise<Result<boolean>> {
    try {
      const response = await fetch(
        `https://gitee.com/api/v5/repos/${owner}/issues/${issueNumber}`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `token ${this.token}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
          },
          body: new URLSearchParams({ repo, state }).toString(),
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
   * 更新 Gitee Issue 的标题 / 正文（未传入的字段保持不动）
   * 和状态更新走同一个 owner 级接口：PATCH /repos/{owner}/issues/{number} + 表单编码
   * 注意：用 API 改 Gitee 不会触发它自己的 webhook，所以这里不存在回环风险
   */
  async updateIssueContent(
    owner: string,
    repo: string,
    issueNumber: string,
    patch: { title?: string; body?: string }
  ): Promise<Result<boolean>> {
    try {
      const form = new URLSearchParams({ repo });
      if (patch.title !== undefined) {
        form.set('title', patch.title);
      }
      if (patch.body !== undefined) {
        form.set('body', patch.body);
      }

      const response = await fetch(
        `https://gitee.com/api/v5/repos/${owner}/issues/${issueNumber}`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `token ${this.token}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
          },
          body: form.toString(),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        console.error(
          `更新 Gitee Issue 标题/正文失败: ${owner}/${repo} ${issueNumber} HTTP ${response.status} ${error}`
        );
        return { success: false, error: `更新Gitee Issue标题/正文失败: HTTP ${response.status} ${error}` };
      }

      return { success: true, data: true };
    } catch (error) {
      return { success: false, error: `更新Gitee Issue标题/正文异常: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * 读取某个 Issue 上的标签
   */
  async getIssueLabels(
    owner: string,
    repo: string,
    issueNumber: string
  ): Promise<Result<Array<{ name: string; color?: string }>>> {
    try {
      const response = await fetch(
        `https://gitee.com/api/v5/repos/${owner}/${repo}/issues/${issueNumber}/labels`,
        {
          headers: { 'Authorization': `token ${this.token}`, 'Accept': 'application/json' },
        }
      );
      if (!response.ok) {
        return { success: false, error: `读取Gitee Issue标签失败: HTTP ${response.status}` };
      }
      const labels = (await response.json()) as Array<{ name: string; color?: string }>;
      return { success: true, data: Array.isArray(labels) ? labels : [] };
    } catch (error) {
      return { success: false, error: `读取Gitee Issue标签异常: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * 给 Issue 加标签（Gitee 这个接口的 body 是裸数组 ["bug","feature"]，不是对象）
   */
  async addIssueLabels(
    owner: string,
    repo: string,
    issueNumber: string,
    names: string[]
  ): Promise<Result<boolean>> {
    if (names.length === 0) {
      return { success: true, data: true };
    }
    try {
      const response = await fetch(
        `https://gitee.com/api/v5/repos/${owner}/${repo}/issues/${issueNumber}/labels`,
        {
          method: 'POST',
          headers: {
            'Authorization': `token ${this.token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify(names),
        }
      );
      if (!response.ok) {
        const error = await response.text();
        console.error(`给 Gitee Issue 加标签失败: ${owner}/${repo} ${issueNumber} ${names.join(',')} HTTP ${response.status} ${error}`);
        return { success: false, error: `给Gitee Issue加标签失败: HTTP ${response.status} ${error}` };
      }
      return { success: true, data: true };
    } catch (error) {
      return { success: false, error: `给Gitee Issue加标签异常: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * 替换 Issue 的全部标签（同样是裸数组 body）
   */
  async setIssueLabels(
    owner: string,
    repo: string,
    issueNumber: string,
    names: string[]
  ): Promise<Result<boolean>> {
    try {
      const response = await fetch(
        `https://gitee.com/api/v5/repos/${owner}/${repo}/issues/${issueNumber}/labels`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `token ${this.token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify(names),
        }
      );
      if (!response.ok) {
        const error = await response.text();
        console.error(`替换 Gitee Issue 标签失败: ${owner}/${repo} ${issueNumber} HTTP ${response.status} ${error}`);
        return { success: false, error: `替换Gitee Issue标签失败: HTTP ${response.status} ${error}` };
      }
      return { success: true, data: true };
    } catch (error) {
      return { success: false, error: `替换Gitee Issue标签异常: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * 删除 Issue 上的标签（name 支持逗号分隔批量删除）
   */
  async removeIssueLabels(
    owner: string,
    repo: string,
    issueNumber: string,
    names: string[]
  ): Promise<Result<boolean>> {
    if (names.length === 0) {
      return { success: true, data: true };
    }
    try {
      const response = await fetch(
        `https://gitee.com/api/v5/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(names.join(','))}`,
        {
          method: 'DELETE',
          headers: { 'Authorization': `token ${this.token}`, 'Accept': 'application/json' },
        }
      );
      // 标签本来就不在 issue 上时 Gitee 会返回 404，这种情况按成功处理
      if (!response.ok && response.status !== 404) {
        const error = await response.text();
        console.error(`删除 Gitee Issue 标签失败: ${owner}/${repo} ${issueNumber} ${names.join(',')} HTTP ${response.status} ${error}`);
        return { success: false, error: `删除Gitee Issue标签失败: HTTP ${response.status} ${error}` };
      }
      return { success: true, data: true };
    } catch (error) {
      return { success: false, error: `删除Gitee Issue标签异常: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * 读取仓库的所有标签
   */
  async listRepoLabels(owner: string, repo: string): Promise<Result<Array<{ name: string; color?: string }>>> {
    try {
      const response = await fetch(
        `https://gitee.com/api/v5/repos/${owner}/${repo}/labels`,
        {
          headers: { 'Authorization': `token ${this.token}`, 'Accept': 'application/json' },
        }
      );
      if (!response.ok) {
        return { success: false, error: `读取Gitee仓库标签失败: HTTP ${response.status}` };
      }
      const labels = (await response.json()) as Array<{ name: string; color?: string }>;
      return { success: true, data: Array.isArray(labels) ? labels : [] };
    } catch (error) {
      return { success: false, error: `读取Gitee仓库标签异常: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * 创建仓库标签。注意这个接口要 **form 编码**（JSON 会被当成没传 name 而报错）。
   */
  async createRepoLabel(owner: string, repo: string, name: string, color?: string): Promise<Result<boolean>> {
    try {
      const response = await fetch(
        `https://gitee.com/api/v5/repos/${owner}/${repo}/labels`,
        {
          method: 'POST',
          headers: {
            'Authorization': `token ${this.token}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
          },
          body: new URLSearchParams({ name, color: (color || 'ededed').replace(/^#/, '') }).toString(),
        }
      );
      if (!response.ok) {
        const error = await response.text();
        console.error(`创建 Gitee 仓库标签失败: ${owner}/${repo} ${name} HTTP ${response.status} ${error}`);
        return { success: false, error: `创建Gitee仓库标签失败: HTTP ${response.status} ${error}` };
      }
      return { success: true, data: true };
    } catch (error) {
      return { success: false, error: `创建Gitee仓库标签异常: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * 确保标签在 Gitee 仓库里存在；不存在就按 GitHub 的名字和颜色建一个。
   * Gitee 对不存在的标签名是「静默丢弃」（加标签接口照样返回 201），所以必须先建。
   */
  async ensureRepoLabels(
    owner: string,
    repo: string,
    wanted: Array<{ name: string; color?: string }>
  ): Promise<Result<string[]>> {
    try {
      const existingResult = await this.listRepoLabels(owner, repo);
      if (!existingResult.success) {
        return { success: false, error: existingResult.error };
      }

      const existing = new Set(existingResult.data!.map((l) => l.name));
      const applied: string[] = [];

      for (const label of wanted) {
        if (existing.has(label.name)) {
          applied.push(label.name);
          continue;
        }
        const createResult = await this.createRepoLabel(owner, repo, label.name, label.color);
        if (createResult.success) {
          existing.add(label.name);
          applied.push(label.name);
        } else {
          // 名字不合法（Gitee 只允许 2-20 位特定字符）或权限不足：跳过这个标签，不影响其它同步
          console.warn(`跳过无法在 Gitee 创建的标签: ${label.name} —— ${createResult.error}`);
        }
      }

      return { success: true, data: applied };
    } catch (error) {
      return { success: false, error: `同步Gitee标签异常: ${error instanceof Error ? error.message : String(error)}` };
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