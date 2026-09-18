/**
 * 本文件修改自 OpenSiFli/gitee2github-issue（Apache-2.0，commit 836b381）。
 * 改动：1) verifyWebhookSignature 由直接 return true 改为真正的 HMAC-SHA256 校验；
 *      2) 安装令牌改为按目标仓库动态解析（GET /repos/{owner}/{repo}/installation），
 *         不再依赖固定的 GITHUB_INSTALLATION_ID。
 * 详见本仓库根目录 MODIFICATIONS.md。
 */
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { Env, Result } from '../types';

type CachedInstallationToken = { token: string; expiresAt: number };

// 模块级缓存：Worker isolate 在一段时间内会复用，缓存安装 ID 与令牌可以避免
// 每个 webhook 事件都重新签发 JWT / 安装令牌。
const installationIdCache = new Map<string, number>();
const installationTokenCache = new Map<string, CachedInstallationToken>();

export class GitHubService {
  private tokenOctokit: Octokit | null = null;
  private appAuth: ReturnType<typeof createAppAuth> | null = null;
  private baseUrl: string;
  private useAppAuth: boolean;

  constructor(private env: Env) {
    this.baseUrl = env.GITHUB_API_BASE_URL || 'https://api.github.com';
    this.useAppAuth = !!(env.GITHUB_APP_ID && env.GITHUB_PRIVATE_KEY);

    if (this.useAppAuth) {
      // 使用 GitHub App 认证：安装 ID 不再取固定环境变量，而是按目标仓库动态解析，
      // 这样 App 被重新安装 / 扩到更多仓库后无需改动配置。
      this.appAuth = createAppAuth({
        appId: parseInt(env.GITHUB_APP_ID || '', 10),
        privateKey: (env.GITHUB_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      });

      console.log('使用 GitHub App 认证模式（安装ID 按目标仓库动态解析）');
    } else if (env.GITHUB_TOKEN) {
      // 兼容模式：使用个人访问令牌认证
      this.tokenOctokit = new Octokit({
        auth: env.GITHUB_TOKEN,
        baseUrl: this.baseUrl,
      });

      console.log('使用个人访问令牌认证模式');
    } else {
      throw new Error('未提供 GitHub 认证信息，请配置 GITHUB_TOKEN 或 GitHub App 相关参数');
    }
  }

  /**
   * 解析某个仓库所属的 App 安装 ID：GET /repos/{owner}/{repo}/installation
   */
  private async resolveInstallationId(owner: string, repo: string): Promise<number> {
    const key = `${owner}/${repo}`.toLowerCase();
    const cached = installationIdCache.get(key);
    if (cached) {
      return cached;
    }

    const appJwt = (await this.appAuth!({ type: 'app' })).token;
    const response = await fetch(`${this.baseUrl}/repos/${owner}/${repo}/installation`, {
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'gitee2github-issue',
      },
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `解析 ${owner}/${repo} 的 App 安装失败: HTTP ${response.status} ${detail}`
      );
    }

    const data = (await response.json()) as { id: number };
    installationIdCache.set(key, data.id);
    console.log(`已解析 ${owner}/${repo} 的 App 安装 ID: ${data.id}`);
    return data.id;
  }

  /**
   * 为目标仓库获取一个安装令牌（命中缓存且未接近过期时直接复用）
   */
  private async getInstallationToken(owner: string, repo: string): Promise<string> {
    const key = `${owner}/${repo}`.toLowerCase();
    const cached = installationTokenCache.get(key);
    if (cached && cached.expiresAt - Date.now() > 60 * 1000) {
      return cached.token;
    }

    const installationId = await this.resolveInstallationId(owner, repo);
    const auth = await this.appAuth!({ type: 'installation', installationId });
    installationTokenCache.set(key, {
      token: auth.token,
      expiresAt: new Date(auth.expiresAt).getTime(),
    });
    return auth.token;
  }

  /**
   * 取一个针对具体目标仓库的 Octokit 实例。
   * App 模式下每个仓库用自己安装的令牌；PAT 模式下复用同一个实例。
   */
  private async octokitFor(owner: string, repo: string): Promise<Octokit> {
    if (!this.useAppAuth) {
      return this.tokenOctokit!;
    }
    const token = await this.getInstallationToken(owner, repo);
    return new Octokit({ auth: token, baseUrl: this.baseUrl });
  }

  /**
   * 验证GitHub Webhook签名
   * GitHub Apps使用相同的签名方式，所以不需要修改验证逻辑
   */
  async verifyWebhookSignature(request: Request): Promise<boolean> {
    const secret = this.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      console.error('未配置 GITHUB_WEBHOOK_SECRET，拒绝处理 GitHub Webhook');
      return false;
    }

    const signature = request.headers.get('x-hub-signature-256');
    if (!signature) {
      console.error('GitHub webhook 缺少签名');
      return false;
    }

    try {
      // 使用 Web Crypto API 计算 HMAC-SHA256，与 GitHub 的 X-Hub-Signature-256 比对
      const body = await request.clone().text();
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
      const expected =
        'sha256=' +
        Array.from(new Uint8Array(mac))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');

      if (expected.length !== signature.length) {
        return false;
      }
      // 常量时间比较，避免时序侧信道
      let diff = 0;
      for (let i = 0; i < expected.length; i++) {
        diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
      }
      if (diff !== 0) {
        console.error('GitHub webhook 签名验证失败');
      }
      return diff === 0;
    } catch (error) {
      console.error('验证GitHub webhook签名时出错:', error);
      return false;
    }
  }

  /**
   * 创建Issue
   */
  async createIssue(
    owner: string,
    repo: string,
    title: string,
    body: string,
  ): Promise<Result<{ number: number; html_url: string }>> {
    try {
      const octokit = await this.octokitFor(owner, repo);
      const response = await octokit.issues.create({
        owner,
        repo,
        title,
        body,
      });

      return {
        success: true,
        data: {
          number: response.data.number,
          html_url: response.data.html_url,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `创建GitHub Issue失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * 读取 GitHub Issue 当前状态（用于判断是否需要写回，避免两侧来回写形成回环）
   */
  async getIssueState(
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<Result<'open' | 'closed'>> {
    try {
      const octokit = await this.octokitFor(owner, repo);
      const response = await octokit.issues.get({ owner, repo, issue_number: issueNumber });
      return { success: true, data: response.data.state as 'open' | 'closed' };
    } catch (error) {
      return {
        success: false,
        error: `读取GitHub Issue状态失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * 列出仓库的全部 issue（含已关闭，排除 Pull Request）—— 回灌用
   */
  async listIssues(owner: string, repo: string): Promise<Result<any[]>> {
    try {
      const octokit = await this.octokitFor(owner, repo);
      const raw: any[] = await octokit.paginate(octokit.issues.listForRepo, {
        owner,
        repo,
        state: 'all',
        per_page: 100,
      });

      const issues = raw
        .filter((item: any) => !item.pull_request)
        .map((item: any) => ({
          number: item.number as number,
          title: item.title as string,
          body: (item.body as string) || '',
          state: item.state as 'open' | 'closed',
          html_url: item.html_url as string,
          author: (item.user?.login as string) || 'unknown',
          labels: (item.labels || []).map((label: any) =>
            typeof label === 'string'
              ? { name: label as string }
              : { name: label.name as string, color: (label.color as string) || undefined }
          ),
        }));

      return { success: true, data: issues };
    } catch (error) {
      return {
        success: false,
        error: `列出GitHub Issue失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * 更新 GitHub Issue 状态（open / closed）
   */
  async updateIssueState(
    owner: string,
    repo: string,
    issueNumber: number,
    state: 'open' | 'closed',
  ): Promise<Result<{ number: number }>> {
    try {
      const octokit = await this.octokitFor(owner, repo);
      const response = await octokit.issues.update({
        owner,
        repo,
        issue_number: issueNumber,
        state,
      });

      return {
        success: true,
        data: {
          number: response.data.number,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `更新GitHub Issue状态失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * 创建评论
   */
  async createComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string,
  ): Promise<Result<{ id: number }>> {
    try {
      const octokit = await this.octokitFor(owner, repo);
      const response = await octokit.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body,
      });

      return {
        success: true,
        data: {
          id: response.data.id,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `创建GitHub评论失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * 处理GitHub评论，为同步到Gitee做准备
   */
  formatCommentBody(body: string, githubAuthor: string): string {
    return `${body || ''}\n\n---\n> 🤖 此评论由机器人从GitHub同步 | 原始作者: [${githubAuthor}](https://github.com/${githubAuthor})`;
  }

  /**
   * 处理GitHub Issue正文，为同步到Gitee做准备
   */
  formatIssueBody(body: string, githubIssueUrl: string, githubAuthor: string): string {
    return `${body || ''}\n\n---\n> 🤖 此Issue由机器人从GitHub同步 | 原始作者: [${githubAuthor}](https://github.com/${githubAuthor}) | 原始链接: ${githubIssueUrl}`;
  }
}
