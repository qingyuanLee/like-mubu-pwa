/* gitee-client.js — 浏览器端直连 Gitee API，替代后端
   在 app.js 之后加载，覆盖 window.api */

const GITEE_CFG = {
  owner: 'liqy153',
  repo: 'daily_life',
  branch: 'main',
  root: 'notes'
};

// ---- token 管理 ----
function getToken() {
  let t = localStorage.getItem('gitee_token');
  if (!t) {
    t = prompt('请输入 Gitee 私人令牌（PAT）：\n（Gitee → 设置 → 私人令牌 → 生成新令牌）');
    if (t) localStorage.setItem('gitee_token', t.trim());
  }
  return t;
}

// ---- Gitee API 基础封装 ----
async function gitee(path, options = {}) {
  const token = getToken();
  if (!token) throw new Error('未配置 Gitee token');
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://gitee.com/api/v5/repos/${GITEE_CFG.owner}/${GITEE_CFG.repo}/contents/${path}${sep}access_token=${token}&ref=${GITEE_CFG.branch}`;
  const opt = { method: options.method || 'GET', headers: {} };
  if (options.body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(options.body);
  }
  const res = await fetch(url, opt);
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error((data && data.message) || `Gitee API ${res.status}`);
  return data;
}

// ---- 工具函数 ----
const enc = (s) => encodeURIComponent(s);

function b64encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function b64decode(b64) {
  return decodeURIComponent(escape(atob(b64)));
}

// 递归列目录
async function listDir(relPath) {
  const items = await gitee(relPath);
  const result = [];
  for (const it of items) {
    if (it.type === 'file' && it.name.endsWith('.md')) {
      result.push(it.path.replace(GITEE_CFG.root + '/', ''));
    } else if (it.type === 'dir') {
      result.push(...await listDir(it.path));
    }
  }
  return result;
}

// 构建目录树
function buildTree(paths) {
  const root = { name: '', type: 'folder', path: '', children: [] };
  for (const p of paths) {
    const parts = p.split('/');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let f = cur.children.find((c) => c.type === 'folder' && c.name === parts[i]);
      if (!f) {
        f = { name: parts[i], type: 'folder', path: '', children: [] };
        cur.children.push(f);
      }
      cur = f;
    }
    cur.children.push({
      name: parts[parts.length - 1],
      type: 'doc',
      path: p,
      title: parts[parts.length - 1].replace(/\.md$/, '')
    });
  }
  const buildPath = (items, prefix) => {
    for (const it of items) {
      if (it.type === 'folder') {
        it.path = prefix ? `${prefix}/${it.name}` : it.name;
        buildPath(it.children, it.path);
      }
    }
  };
  buildPath(root.children, '');
  const sortTree = (n) => {
    n.children?.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name, 'zh') : a.type === 'folder' ? -1 : 1
    );
    n.children?.forEach(sortTree);
  };
  sortTree(root);
  return root.children;
}

// 解析 markdown 为大纲（简化版）
function parseMd(content) {
  const lines = content.split('\n');
  let title = '';
  let titleSkipped = false;  // 第一个 # 只作为文档标题，不入大纲树
  const nodes = [];
  const stack = [{ level: 0, children: nodes }];
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)/);
    if (m) {
      if (!title) title = m[2];
      // 第一个标题只作为文档名，不作为大纲节点
      if (!titleSkipped) { titleSkipped = true; continue; }
      const level = m[1].length;
      while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
      const node = { text: m[2], children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push({ level, children: node.children });
    } else if (line.trim() && !line.startsWith('---')) {
      stack[stack.length - 1].children.push({ text: line.trim(), children: [] });
    }
  }
  return { title: title || '未命名', nodes };
}

// 图片加载：把 Gitee raw URL 转成 API v5 raw endpoint（直接返回图片二进制，浏览器自动加载）
// 原 URL: https://gitee.com/{owner}/{repo}/raw/{branch}/{path} （私有仓 403）
// 新 URL: https://gitee.com/api/v5/repos/{owner}/{repo}/raw/{path}?access_token=xxx&ref=branch （200, image/jpeg）
window.fixGiteeImg = function(url) {
  if (!url) return url;
  url = url.trim();
  const m = url.match(/gitee\.com\/([^/]+)\/([^/]+)\/raw\/([^/]+)\/(.+)/);
  if (m) {
    const [, owner, repo, branch, path] = m;
    const cleanPath = path.trim();
    const token = localStorage.getItem('gitee_token');
    if (token) {
      return `https://gitee.com/api/v5/repos/${owner}/${repo}/raw/${cleanPath}?access_token=${token}&ref=${branch}`;
    }
  }
  return url;
};

// 兼容保留（不再需要，renderDoc 里的调用无害）
window.loadGiteeImages = function() {};

// ---- 覆盖 window.api ----
window.api = async function(method, url, body) {
  // 健康检查
  if (url === '/api/health') {
    return { ok: true, mode: 'gitee', repo: GITEE_CFG.owner + '/' + GITEE_CFG.repo, branch: GITEE_CFG.branch, root: GITEE_CFG.root, time: new Date().toISOString() };
  }

  // 目录树
  if (url === '/api/tree') {
    const paths = await listDir(GITEE_CFG.root);
    return buildTree(paths);
  }

  // 标签
  if (url === '/api/tags') {
    return [];
  }

  // 搜索：先匹配标题/路径（即时），避免逐个读文件触发 API 限速
  if (url.startsWith('/api/search?q=')) {
    const q = decodeURIComponent(url.split('q=')[1]).toLowerCase();
    const paths = await listDir(GITEE_CFG.root);
    const results = [];
    for (const p of paths) {
      const title = p.replace(/\.md$/, '').split('/').pop();
      if (title.toLowerCase().includes(q) || p.toLowerCase().includes(q)) {
        results.push({ path: p, title, snippets: [p] });
      }
    }
    return results;
  }

  // 今日日志
  if (url === '/api/daily') {
    const today = new Date().toISOString().slice(0, 10);
    const relPath = `journal/${today.slice(0, 4)}/${today}.md`;
    try {
      const file = await gitee(`${GITEE_CFG.root}/${enc(relPath)}`);
      const content = b64decode(file.content);
      const { title, nodes } = parseMd(content);
      return { path: relPath, title, nodes, raw: content, created: false };
    } catch {
      const content = `# ${today} 日志\n\n- 工作日志\n- 生活记录\n- 想法与备忘\n`;
      await gitee(`${GITEE_CFG.root}/${enc(relPath)}`, { method: 'POST', body: { content: b64encode(content), message: `create ${relPath}` } });
      const { title, nodes } = parseMd(content);
      return { path: relPath, title, nodes, raw: content, created: true };
    }
  }

  // 新建文档
  if (url === '/api/docs' && method === 'POST') {
    const title = body?.title || '未命名';
    const folder = body?.folder || '';
    const name = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 50) || '未命名';
    const relPath = `${folder ? folder + '/' : ''}${name}.md`;
    const content = `# ${title}\n\n`;
    await gitee(`${GITEE_CFG.root}/${enc(relPath)}`, { method: 'POST', body: { content: b64encode(content), message: `create ${relPath}` } });
    return { path: relPath };
  }

  // 移动文档
  if (url === '/api/move' && method === 'POST') {
    const { from, to } = body;
    const file = await gitee(`${GITEE_CFG.root}/${enc(from)}`);
    await gitee(`${GITEE_CFG.root}/${enc(to)}`, { method: 'POST', body: { content: file.content, message: `move ${from} -> ${to}` } });
    await gitee(`${GITEE_CFG.root}/${enc(from)}`, { method: 'DELETE', body: { sha: file.sha, message: `delete ${from}` } });
    return { from, to };
  }

  // 重命名文件夹
  if (url === '/api/folder/rename' && method === 'POST') {
    const { from, to } = body;
    const paths = await listDir(GITEE_CFG.root);
    const moved = [];
    for (const p of paths) {
      if (p.startsWith(from + '/')) {
        const newPath = to + p.slice(from.length);
        const file = await gitee(`${GITEE_CFG.root}/${enc(p)}`);
        await gitee(`${GITEE_CFG.root}/${enc(newPath)}`, { method: 'POST', body: { content: file.content, message: `move ${p} -> ${newPath}` } });
        await gitee(`${GITEE_CFG.root}/${enc(p)}`, { method: 'DELETE', body: { sha: file.sha, message: `delete ${p}` } });
        moved.push({ from: p, to: newPath });
      }
    }
    return { from, to, moved: moved.length, movedPaths: moved };
  }

  // 删除文件夹
  if (url.startsWith('/api/folder?path=') && method === 'DELETE') {
    const path = decodeURIComponent(url.split('path=')[1]);
    const paths = await listDir(GITEE_CFG.root);
    const removed = [];
    for (const p of paths) {
      if (p.startsWith(path + '/')) {
        const file = await gitee(`${GITEE_CFG.root}/${enc(p)}`);
        await gitee(`${GITEE_CFG.root}/${enc(p)}`, { method: 'DELETE', body: { sha: file.sha, message: `delete ${p}` } });
        removed.push(p);
      }
    }
    return { folder: path, removed: removed.length, paths: removed };
  }

  // 上传图片
  if (url === '/api/upload-image' && method === 'POST') {
    const name = body?.name || 'image.png';
    const ts = Date.now();
    const relPath = `images/${ts}_${name}`;
    await gitee(`${GITEE_CFG.root}/${enc(relPath)}`, { method: 'POST', body: { content: body.dataBase64, message: `upload ${name}` } });
    const token = getToken();
    return { url: `https://gitee.com/${GITEE_CFG.owner}/${GITEE_CFG.repo}/raw/${GITEE_CFG.branch}/${GITEE_CFG.root}/${relPath}?access_token=${token}` };
  }

  // 文档 CRUD: /api/docs/xxx
  if (url.startsWith('/api/docs/')) {
    const docPath = decodeURIComponent(url.replace('/api/docs/', ''));
    if (method === 'GET') {
      const file = await gitee(`${GITEE_CFG.root}/${enc(docPath)}`);
      const content = b64decode(file.content);
      const { nodes } = parseMd(content);
      // 文档名用文件名（去掉路径和 .md），不用 markdown 里的 # 标题
      const fileName = docPath.replace(/\.md$/, '').split('/').pop();
      return { path: docPath, title: fileName, nodes, raw: content };
    }
    if (method === 'PUT') {
      const { title, nodes } = body;
      const content = serializeNodes(title, nodes);
      const file = await gitee(`${GITEE_CFG.root}/${enc(docPath)}`);
      await gitee(`${GITEE_CFG.root}/${enc(docPath)}`, { method: 'PUT', body: { content: b64encode(content), message: `update ${docPath}`, sha: file.sha } });
      return { path: docPath, title, nodes, raw: content };
    }
    if (method === 'DELETE') {
      const file = await gitee(`${GITEE_CFG.root}/${enc(docPath)}`);
      await gitee(`${GITEE_CFG.root}/${enc(docPath)}`, { method: 'DELETE', body: { sha: file.sha, message: `delete ${docPath}` } });
      return { path: docPath };
    }
  }

  throw new Error(`未实现的 API: ${method} ${url}`);
};

// 节点序列化为 markdown
function serializeNodes(title, nodes) {
  let md = `# ${title}\n\n`;
  const walk = (arr, level) => {
    for (const n of arr || []) {
      md += '#'.repeat(level) + ' ' + n.text + '\n';
      if (n.children?.length) walk(n.children, level + 1);
    }
  };
  walk(nodes, 2);
  return md;
}
