/**
 * Service for interacting with GitHub API
 */

export interface GitHubFile {
  name: string;
  path: string;
  sha: string;
  size: number;
  url: string;
  html_url: string;
  git_url: string;
  download_url: string | null;
  type: "file" | "dir";
}

export class GitHubService {
  private accessToken: string | null;
  private owner: string;
  private repo: string;

  constructor(owner: string, repo: string, accessToken: string | null = null) {
    this.owner = owner;
    this.repo = repo;
    this.accessToken = accessToken;
  }

  private async fetch(url: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers);
    headers.set('Accept', 'application/vnd.github+json');
    headers.set('X-GitHub-Api-Version', '2022-11-28');

    if (this.accessToken) {
      headers.set('Authorization', `token ${this.accessToken}`);
    }

    console.log(`GitHub API Call: ${url} (Token: ${this.accessToken ? 'YES' : 'NO'})`);
    
    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || `GitHub API error: ${response.status} at ${url}`);
    }

    return response;
  }

  async listFiles(path: string = ''): Promise<GitHubFile[]> {
    const response = await this.fetch(`https://api.github.com/repos/${this.owner}/${this.repo}/contents/${path}`);
    const data = await response.json();
    
    if (Array.isArray(data)) {
      return data;
    }
    
    return [];
  }

  async getFileContent(path: string): Promise<string> {
    // For many files, the contents API response includes base64 content
    const response = await this.fetch(`https://api.github.com/repos/${this.owner}/${this.repo}/contents/${path}`);
    const data = await response.json();
    
    if (data.content && data.encoding === 'base64') {
      // Decode base64, handling UTF-8 characters
      return decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))));
    }
    
    if (data.download_url) {
      const downloadResponse = await fetch(data.download_url);
      return await downloadResponse.text();
    }
    
    throw new Error('Could not retrieve file content');
  }

  /**
   * List files recursively from a specific directory 'LG13_Terminal_Data' (matches Drive structure)
   */
  async getTerminalFiles(): Promise<GitHubFile[]> {
    try {
      // First try 'LG13_Terminal_Data' directory
      return await this.listFiles('LG13_Terminal_Data');
    } catch (e) {
      // Fallback to root or try to find where the files are
      console.warn('Directory LG13_Terminal_Data not found on GitHub, trying root');
      return await this.listFiles('');
    }
  }
}
