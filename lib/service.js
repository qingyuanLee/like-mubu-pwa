import { parseMarkdown, serializeDoc, titleOf, extractTags, safeName, autoName, today } from './outline.js';
import { dailyPath, dailyTemplate } from './journal.js';

export function createService({ store, journalFolder = 'journal' }) {
  const svc = {
    store,
    journalFolder,

    async listDocs() {
      const files = await store.list();
      return files.map((f) => ({
        path: f.path,
        title: f.path.replace(/\.md$/, '').split('/').pop(),
        tags: [],
        size: f.size ?? 0,
      })).sort((a, b) => a.path.localeCompare(b.path, 'zh'));
    },

    async docTree() {
      const docs = await svc.listDocs();
      const root = { name: '', type: 'folder', path: '', children: [] };
      for (const d of docs) {
        const parts = d.path.split('/');
        let cur = root;
        for (const p of parts.slice(0, -1)) {
          let f = cur.children.find((c) => c.type === 'folder' && c.name === p);
          if (!f) {
            f = { name: p, type: 'folder', path: '', children: [] };
            cur.children.push(f);
          }
          cur = f;
        }
        cur.children.push({ name: parts[parts.length - 1], type: 'doc', path: d.path, title: d.title });
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
    },

    async getDoc(relPath) {
      const content = await store.read(relPath);
      if (content === null) return null;
      const { title, nodes } = parseMarkdown(content);
      return { path: relPath, title, nodes, raw: content, tags: extractTags(content) };
    },

    async saveDoc(relPath, { title, nodes }) {
      if (!Array.isArray(nodes)) throw new Error('nodes 必须是数组');
      const content = serializeDoc({ title, nodes });
      await store.write(relPath, content, `update ${relPath}`);
      return { path: relPath, title, nodes, raw: content };
    },

    async createDoc({ title = '', folder = '' }) {
      const name = safeName(title) || autoName('未命名');
      const relPath = `${folder ? `${folder}/` : ''}${name}.md`;
      const unique = await svc._uniquePath(relPath);
      const content = title ? `# ${title}\n\n` : `# ${name}\n\n`;
      await store.write(unique, content, `create ${unique}`);
      return { path: unique };
    },

    async moveDoc(from, to) {
      const content = await store.read(from);
      if (content === null) throw Object.assign(new Error(`文档不存在: ${from}`), { status: 404 });
      const unique = await svc._uniquePath(to);
      if (unique !== from) {
        await store.write(unique, content, `move ${from} -> ${unique}`);
        await store.remove(from, `move ${from} -> ${unique}`);
      }
      return { from, to: unique };
    },

    async removeDoc(relPath) {
      await store.remove(relPath, `delete ${relPath}`);
      return { path: relPath };
    },

    async renameFolder(from, to) {
      const fromF = String(from || '').replace(/^\/+|\/+$/g, '');
      const toF = String(to || '').replace(/^\/+|\/+$/g, '');
      if (!fromF || !toF) throw new Error('from / to 不能为空');
      if (fromF === toF) return { from: fromF, to: toF, moved: 0, movedPaths: [] };
      const files = await store.list();
      const affected = files.filter((f) => f.path.startsWith(fromF + '/'));
      if (!affected.length) throw Object.assign(new Error(`文件夹不存在或为空: ${fromF}`), { status: 404 });
      const movedPaths = [];
      for (const f of affected) {
        const rel = toF + f.path.slice(fromF.length);
        const unique = await svc._uniquePath(rel);
        const content = await store.read(f.path);
        if (content === null) continue;
        await store.write(unique, content, `move ${f.path} -> ${unique}`);
        await store.remove(f.path, `move ${f.path} -> ${unique}`);
        movedPaths.push({ from: f.path, to: unique });
      }
      return { from: fromF, to: toF, moved: movedPaths.length, movedPaths };
    },

    async removeFolder(folder) {
      const f = String(folder || '').replace(/^\/+|\/+$/g, '');
      if (!f) throw new Error('folder 不能为空');
      const files = await store.list();
      const affected = files.filter((x) => x.path.startsWith(f + '/'));
      const removed = [];
      for (const x of affected) {
        await store.remove(x.path, `delete folder ${f}`);
        removed.push(x.path);
      }
      return { folder: f, removed: removed.length, paths: removed };
    },

    async search(q, { limit = 30 } = {}) {
      const kw = String(q || '').trim().toLowerCase();
      if (!kw) return [];
      const files = await store.list();
      const results = await Promise.all(
        files.map(async (f) => {
          const content = await store.read(f.path);
          if (!content) return null;
          const lines = content.split('\n');
          const hits = [];
          for (const line of lines) {
            if (line.toLowerCase().includes(kw)) {
              const snippet = line.trim().replace(/^[-*+]\s+/, '').slice(0, 200);
              hits.push(snippet);
              if (hits.length >= 3) break;
            }
          }
          if (!hits.length) return null;
          return { path: f.path, title: titleOf(content) || f.path.replace(/\.md$/, ''), snippets: hits };
        })
      );
      return results.filter(Boolean).slice(0, limit);
    },

    async tags() {
      const files = await store.list();
      const map = new Map();
      for (const f of files) {
        const content = await store.read(f.path);
        if (!content) continue;
        for (const t of extractTags(content)) {
          if (!map.has(t)) map.set(t, []);
          map.get(t).push(f.path);
        }
      }
      return [...map.entries()].map(([tag, paths]) => ({ tag, count: paths.length, paths })).sort((a, b) => b.count - a.count);
    },

    async getOrCreateDaily(dateStr = today()) {
      const rel = dailyPath(dateStr, svc.journalFolder);
      const existing = await store.read(rel);
      if (existing !== null) {
        const { title, nodes } = parseMarkdown(existing);
        return { path: rel, title, nodes, raw: existing, created: false };
      }
      const content = dailyTemplate(dateStr);
      await store.write(rel, content, `create daily ${rel}`);
      const { title, nodes } = parseMarkdown(content);
      return { path: rel, title, nodes, raw: content, created: true };
    },

    async uploadImage({ name, dataBase64 }) {
      const b64 = String(dataBase64 || '').replace(/^data:[^;]*;base64,/, '');
      if (!b64) throw new Error('dataBase64 为空');
      return store.uploadImage({ name, dataBase64: b64 });
    },

    async _uniquePath(relPath) {
      if (!relPath.endsWith('.md')) relPath += '.md';
      const base = relPath.replace(/\.md$/, '');
      let p = relPath;
      let n = 2;
      while ((await store.read(p)) !== null) {
        p = `${base}_${n}.md`;
        n++;
        if (n > 99) throw new Error('同名文件过多');
      }
      return p;
    },
  };
  return svc;
}
