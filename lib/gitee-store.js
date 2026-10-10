// GiteeStore：通过 Gitee API v5 读写 notes/ 下的 Markdown 文件
// 环境变量：GITEE_TOKEN / GITEE_REPO / GITEE_BRANCH / GITEE_ROOT

export class GiteeStore {
  constructor({ token, repo, branch, root }) {
    this.token = token;
    this.repo = String(repo).replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
    this.branch = branch || 'main';
    this.root = String(root || 'notes').replace(/^\/+|\/+$/g, '');
    this.api = 'https://gitee.com/api/v5';
    this.kind = 'gitee';
    this._tree = null;
    this._treeAt = 0;
    this._content = new Map(); // relPath -> { sha, content, at }
    this.TREE_TTL = 60_000;
    this.CONTENT_TTL = 5 * 60_000;
  }

  rel(p) {
    return this.root ? `${this.root}/${p}` : p;
  }

  async _req(method, apiPath, bodyObj) {
    const sep = apiPath.includes('?') ? '&' : '?';
    const url = `${this.api}${apiPath}${sep}access_token=${encodeURIComponent(this.token)}`;
    const headers = { 'User-Agent': 'like-mubu-pwa' };
    if (bodyObj !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: bodyObj !== undefined ? JSON.stringify(bodyObj) : undefined
      });
    } catch (e) {
      throw new Error(`无法连接 Gitee API：${e.message}`);
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error((data && data.message) || `Gitee API ${res.status}`);
      err.status = res.status;
      err.details = data;
      throw err;
    }
    return data;
  }

  /** 递归列出 root 下所有 .md 文件（带 60s 缓存） */
  async list() {
    if (this._tree && Date.now() - this._treeAt < this.TREE_TTL) return this._tree;
    const files = [];
    await this._walkDir(this.root, files);
    files.sort((a, b) => a.path.localeCompare(b.path, 'zh'));
    this._tree = files;
    this._treeAt = Date.now();
    return files;
  }

  async _walkDir(dirAbs, out) {
    const items = await this._req('GET', `/repos/${this.repo}/contents/${dirAbs}?ref=${encodeURIComponent(this.branch)}`);
    if (!Array.isArray(items)) return;
    const subdirs = [];
    for (const item of items) {
      if (item.type === 'dir') {
        subdirs.push(item.path);
      } else if (item.type === 'file' && item.name.endsWith('.md')) {
        const rel = item.path.slice(this.root.length + 1);
        out.push({ path: rel, sha: item.sha, size: item.size });
      }
    }
    if (subdirs.length) {
      await Promise.all(subdirs.map((d) => this._walkDir(d, out)));
    }
  }

  async read(relPath) {
    const tree = await this.list();
    const item = tree.find((t) => t.path === relPath);
    if (!item) return null;
    const cached = this._content.get(relPath);
    if (cached && cached.sha === item.sha && Date.now() - cached.at < this.CONTENT_TTL) {
      return cached.content;
    }
    const enc = encodeURIComponent(this.rel(relPath));
    const data = await this._req('GET', `/repos/${this.repo}/contents/${enc}?ref=${encodeURIComponent(this.branch)}`);
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    this._content.set(relPath, { sha: item.sha, content, at: Date.now() });
    return content;
  }

  async _getSha(relPath) {
    try {
      const enc = encodeURIComponent(this.rel(relPath));
      const data = await this._req('GET', `/repos/${this.repo}/contents/${enc}?ref=${encodeURIComponent(this.branch)}`);
      return data.sha;
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  async write(relPath, content, message) {
    const base64 = Buffer.from(content, 'utf8').toString('base64');
    const sha = await this._getSha(relPath);
    const enc = encodeURIComponent(this.rel(relPath));
    const body = {
      access_token: this.token,
      content: base64,
      commit_message: message || `update ${relPath}`,
      branch: this.branch
    };
    if (sha) body.sha = sha;
    const method = sha ? 'PUT' : 'POST';
    const data = await this._req(method, `/repos/${this.repo}/contents/${enc}`, body);
    this._content.delete(relPath);
    this._tree = null;
    return { path: relPath, sha: (data && data.content && data.content.sha) || sha };
  }

  async remove(relPath, message) {
    const sha = await this._getSha(relPath);
    if (!sha) return { path: relPath };
    const enc = encodeURIComponent(this.rel(relPath));
    await this._req('DELETE', `/repos/${this.repo}/contents/${enc}`, {
      access_token: this.token,
      sha,
      commit_message: message || `delete ${relPath}`,
      branch: this.branch
    });
    this._content.delete(relPath);
    this._tree = null;
    return { path: relPath };
  }

  rawUrl(relPath) {
    return `https://gitee.com/${this.repo}/raw/${this.branch}/${this.rel(relPath).split('/').map(encodeURIComponent).join('/')}`;
  }

  async uploadImage({ name, dataBase64 }, folder = 'assets') {
    const ext = (name && /\.[a-z0-9]+$/i.exec(name)) ? ext[0] : '.png';
    const fname = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`;
    const relPath = `${folder}/${fname}`;
    const buf = Buffer.from(dataBase64, 'base64');
    if (buf.length > 5 * 1024 * 1024) throw new Error('图片超过 5MB');
    await this.write(relPath, buf.toString('binary'), `upload image ${fname}`);
    return { path: relPath, url: this.rawUrl(relPath) };
  }
}

export function createStore() {
  return new GiteeStore({
    token: process.env.GITEE_TOKEN,
    repo: process.env.GITEE_REPO || 'liqy153/daily_life',
    branch: process.env.GITEE_BRANCH || 'main',
    root: process.env.GITEE_ROOT || 'notes'
  });
}
