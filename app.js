'use strict';
/* like-mubu 前端：幕布风格大纲编辑器（零依赖，本地静态文件） */

// ============ 工具 ============
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'n' + Date.now() + Math.random().toString(36).slice(2, 8));
const pad = (n) => String(n).padStart(2, '0');
const normPath = (p) => {
  let s = String(p || '').replace(/^\/+|\/+$/g, '');
  if (!s.endsWith('.md')) s += '.md';
  return s;
};
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(url, opt);
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

// ============ 状态 ============
const state = {
  health: null,
  current: null,          // { path, title, nodes }
  tree: [],
  filteredTree: null,
  collapsed: new Set(JSON.parse(localStorage.getItem('lm.collapsed') || '[]')),
  expand: new Set(JSON.parse(localStorage.getItem('lm.expand') || '[]')),
  dirty: false,
  saving: false,
  lastSaved: null,
  undo: [],
  redo: [],
  lastSnapAt: 0,
  searchResults: [],
  view: 'outline',
  tags: [],
};

function persistCollapsed() { localStorage.setItem('lm.collapsed', JSON.stringify([...state.collapsed])); }

// 收集所有节点 id
function collectNodeIds(nodes, depth) {
  let ids = [];
  for (const n of (nodes || [])) {
    if (n.children && n.children.length) {
      ids.push({ id: n.id, depth: depth || 1 });
      ids = ids.concat(collectNodeIds(n.children, (depth || 1) + 1));
    }
  }
  return ids;
}

// 全部展开 / 全部折叠
function setAllCollapsed(collapse) {
  if (!state.current || !state.current.nodes) return;
  const all = collectNodeIds(state.current.nodes, 1);
  state.collapsed = new Set();
  if (collapse) all.forEach(x => state.collapsed.add(x.id));
  persistCollapsed();
  renderDoc();
}

// 折叠到指定层级（1=只显示一级）
function collapseToLevel(level) {
  if (!state.current || !state.current.nodes) return;
  const all = collectNodeIds(state.current.nodes, 1);
  state.collapsed = new Set();
  all.forEach(x => { if (x.depth >= level) state.collapsed.add(x.id); });
  persistCollapsed();
  renderDoc();
}

// 展开/折叠某节点的所有子孙
function toggleSubtree(nodeId, collapse) {
  function find(nodes) {
    for (const n of (nodes || [])) {
      if (n.id === nodeId) return n;
      if (n.children) {
        const r = find(n.children);
        if (r) return r;
      }
    }
    return null;
  }
  const node = find(state.current.nodes || []);
  if (!node) return;
  const sub = collectNodeIds([node], 1);
  sub.forEach(x => {
    if (collapse) state.collapsed.add(x.id);
    else state.collapsed.delete(x.id);
  });
  persistCollapsed();
  renderDoc();
}
function persistExpand() { localStorage.setItem('lm.expand', JSON.stringify([...state.expand])); }

// ============ 状态栏 / Toast ============
function setStatus(text, isErr) {
  const el = $('#save-status');
  el.textContent = text;
  el.classList.toggle('err', !!isErr);
}
function markDirty() {
  if (!state.current) return;
  state.dirty = true;
  setStatus('未保存');
  scheduleSave();
}
let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 1200);
}
async function save() {
  if (!state.current || state.saving) return;
  clearTimeout(saveTimer);
  state.saving = true;
  setStatus('保存中…');
  try {
    await api('PUT', `/api/docs/${encPath(state.current.path)}`, {
      title: state.current.title || '',
      nodes: state.current.nodes,
    });
    state.dirty = false;
    state.lastSaved = new Date();
    setStatus(`已保存 ${pad(state.lastSaved.getHours())}:${pad(state.lastSaved.getMinutes())}:${pad(state.lastSaved.getSeconds())}`);
    refreshSidebar();
  } catch (e) {
    setStatus('保存失败，请重试', true);
    console.error(e);
  }
  state.saving = false;
}

// ============ 撤销 / 重做 ============
function snapshot() {
  if (!state.current) return;
  state.undo.push(JSON.stringify({ title: state.current.title, nodes: state.current.nodes }));
  if (state.undo.length > 120) state.undo.shift();
  state.redo = [];
  state.lastSnapAt = Date.now();
}
function maybeSnap() {
  if (Date.now() - state.lastSnapAt > 3000) snapshot();
}
function undo() {
  if (!state.undo.length || !state.current) return;
  state.redo.push(JSON.stringify({ title: state.current.title, nodes: state.current.nodes }));
  const prev = JSON.parse(state.undo.pop());
  applySnapshot(prev);
}
function redo() {
  if (!state.redo.length || !state.current) return;
  state.undo.push(JSON.stringify({ title: state.current.title, nodes: state.current.nodes }));
  const next = JSON.parse(state.redo.pop());
  applySnapshot(next);
}
function applySnapshot(snap) {
  state.current.title = snap.title;
  state.current.nodes = snap.nodes;
  renderDoc();
  markDirty();
}

// ============ 大纲树操作 ============
function findInfo(nodes, id, chain = []) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.id === id) return { node: n, list: nodes, index: i, parentEntry: chain.length ? chain[chain.length - 1] : null, chain };
    if (n.children && n.children.length) {
      const r = findInfo(n.children, id, [...chain, { node: n, list: nodes, index: i }]);
      if (r) return r;
    }
  }
  return null;
}
function rootNodes() { return state.current ? state.current.nodes : []; }

function insertSibling(id) {
  const info = findInfo(rootNodes(), id);
  if (!info) return;
  if (!info.node.text.trim()) {
    // 空节点 + Enter → 上移一层（成为父节点的同级）
    dedent(id);
    return;
  }
  snapshot();
  info.list.splice(info.index + 1, 0, { id: uid(), text: '', children: [] });
  rebuildAndFocus(info.list[info.index + 1].id);
  markDirty();
}
function insertChild(id) {
  const info = findInfo(rootNodes(), id);
  if (!info) return;
  snapshot();
  const node = { id: uid(), text: '', children: [] };
  info.node.children = info.node.children || [];
  info.node.children.push(node);
  rebuildAndFocus(node.id);
  markDirty();
}
function indent(id) {
  const info = findInfo(rootNodes(), id);
  if (!info || info.index === 0) return;
  snapshot();
  const prev = info.list[info.index - 1];
  const node = info.node;
  info.list.splice(info.index, 1);
  prev.children = prev.children || [];
  prev.children.push(node);
  rebuildAndFocus(id);
  markDirty();
}
function dedent(id) {
  const info = findInfo(rootNodes(), id);
  if (!info || !info.parentEntry) return;
  snapshot();
  const node = info.node;
  info.list.splice(info.index, 1);
  const grand = info.chain.length >= 2 ? info.chain[info.chain.length - 2] : null;
  const target = grand ? grand.node.children : rootNodes();
  const at = grand ? grand.index + 1 : info.parentEntry.index + 1;
  target.splice(Math.min(at, target.length), 0, node);
  rebuildAndFocus(id);
  markDirty();
}
function moveNode(id, dir) {
  const info = findInfo(rootNodes(), id);
  if (!info) return;
  const t = info.index + dir;
  if (t < 0 || t >= info.list.length) return;
  snapshot();
  const [node] = info.list.splice(info.index, 1);
  info.list.splice(t, 0, node);
  rebuildAndFocus(id);
  markDirty();
}
function deleteNode(id) {
  const info = findInfo(rootNodes(), id);
  if (!info) return;
  snapshot();
  info.list.splice(info.index, 1);
  const focusTarget = info.list[info.index] || info.list[info.index - 1] || (info.parentEntry ? info.parentEntry.node : null);
  renderDoc();
  if (focusTarget) focusNode(focusTarget.id);
  markDirty();
}

// ============ 渲染 ============
function renderInline(raw) {
  let t = esc(raw);
  const codes = [];
  t = t.replace(/`([^`]+)`/g, (m, p) => { codes.push(p); return `\u0000${codes.length - 1}\u0000`; });
  t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, url) => { const fixed = window.fixGiteeImg ? window.fixGiteeImg(url) : url; return `<img src="${esc(fixed)}" alt="${esc(alt)}" loading="lazy" data-orig="${esc(m)}">`; });
  t = t.replace(/^\[([ xX])\]\s+/, (m, c) => `<span class="cb-mark">[${c.toLowerCase()}]</span> `);
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
       .replace(/\*([^*]+)\*/g, '<i>$1</i>')
       .replace(/~~([^~]+)~~/g, '<s>$1</s>')
       .replace(/==([^=]+)==/g, '<mark>$1</mark>')
       .replace(/(^|[\s(（])(#[A-Za-z0-9_\-\u4e00-\u9fa5]{1,40})/g, '$1<span class="tag">$2</span>');
  t = t.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${codes[+i]}</code>`);
  return t;
}
function readRaw(span) {
  const img = span.querySelector('img[data-orig]');
  if (img) return img.dataset.orig;
  return span.textContent;
}
function renderInlineSafe(raw) { // 渲染失败兜底
  try { return renderInline(raw); } catch { return esc(raw); }
}

function buildList(nodes) {
  const ul = document.createElement('ul');
  ul.className = 'node-list';
  for (const n of nodes) {
    const li = document.createElement('li');
    li.className = 'node-item';
    li.dataset.id = n.id;
    if (state.collapsed.has(n.id)) li.classList.add('collapsed');

    const row = document.createElement('div');
    row.className = 'node-row';

    const caret = document.createElement('span');
    caret.className = 'caret';
    if (n.children && n.children.length) {
      caret.classList.add('has-children');
      caret.textContent = state.collapsed.has(n.id) ? '▸' : '▾';
    }
    caret.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!n.children || !n.children.length) return;
      if (state.collapsed.has(n.id)) state.collapsed.delete(n.id);
      else state.collapsed.add(n.id);
      persistCollapsed();
      li.classList.toggle('collapsed', state.collapsed.has(n.id));
      caret.textContent = state.collapsed.has(n.id) ? '▸' : '▾';
    });

    const bullet = document.createElement('span');
    bullet.className = 'bullet';
    bullet.textContent = '•';

    const text = document.createElement('span');
    text.className = 'node-text';
    text.contentEditable = 'true';
    text.spellcheck = false;
    text.dataset.raw = n.text;
    text.innerHTML = renderInlineSafe(n.text);
    text.addEventListener('focus', () => {
      text.textContent = text.dataset.raw ?? '';
    });
    text.addEventListener('input', () => {
      n.text = text.textContent;
      text.dataset.raw = n.text;
      markDirty();
      maybeSnap();
    });
    text.addEventListener('blur', () => {
      n.text = text.textContent;
      text.dataset.raw = n.text;
      text.innerHTML = renderInlineSafe(n.text);
    });
    text.addEventListener('paste', (e) => {
      e.preventDefault();
      for (const item of e.clipboardData.items) {
        if (item.type && item.type.startsWith('image/')) {
          const f = item.getAsFile();
          if (f) { uploadPastedImage(f, n.id); return; }
        }
      }
      const txt = e.clipboardData.getData('text/plain');
      document.execCommand('insertText', false, txt);
      n.text = text.textContent; text.dataset.raw = n.text;
    });

    const actions = document.createElement('span');
    actions.className = 'node-actions';
    const mk = (act, label, title) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', () => {
        if (act === 'child') insertChild(n.id);
        else if (act === 'up') moveNode(n.id, -1);
        else if (act === 'down') moveNode(n.id, 1);
        else if (act === 'del') deleteNode(n.id);
      });
      return b;
    };
    // 折叠/展开该节点的所有子孙（仅对有子节点的行显示）
    if (n.children && n.children.length) {
      const subBtn = document.createElement('button');
      subBtn.textContent = '⤓';
      subBtn.title = '折叠/展开所有子孙';
      subBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        // 判断当前是否有子孙被折叠
        const sub = collectNodeIds([n], 1);
        const hasCollapsed = sub.some(x => state.collapsed.has(x.id));
        toggleSubtree(n.id, !hasCollapsed);
      });
      actions.append(subBtn);
    }
    actions.append(mk('child', '+', '新增子节点 (Ctrl+Enter)'), mk('up', '↑', '上移 (Alt+↑)'), mk('down', '↓', '下移 (Alt+↓)'), mk('del', '×', '删除节点'));

    row.append(caret, bullet, text, actions);
    li.appendChild(row);

    if (n.children && n.children.length) li.appendChild(buildList(n.children));
    ul.appendChild(li);
  }
  return ul;
}

function renderDoc() {
  const editor = $('#editor');
  editor.classList.remove('hidden');
  $('#welcome').classList.add('hidden');
  $('#outline').classList.toggle('hidden', state.view === 'mindmap');
  $('#mindmap-wrap').classList.toggle('hidden', state.view !== 'mindmap');
  $('#btn-map').classList.toggle('hidden', state.view === 'mindmap');
  $('#btn-outline').classList.toggle('hidden', state.view !== 'mindmap');
  $('#doc-title').value = state.current.title || '';
  $('#doc-meta').innerHTML = `<span class="meta-path">${esc(state.current.path)}</span>` +
    (state.current.tags || []).map((t) => `<span class="meta-tag" data-tag="${esc(t)}">${esc(t)}</span>`).join('');
  $$('#doc-meta .meta-tag').forEach((el) => el.addEventListener('click', () => runSearch(el.dataset.tag)));

  if (state.view === 'outline') {
    const box = $('#outline');
    box.innerHTML = '';
    box.appendChild(buildList(state.current.nodes || []));
    if (!(state.current.nodes || []).length) box.appendChild(makePlaceholderItem());
  } else {
    renderMindMap();
  }
  refreshSidebar();
  // 重建 DOM 后主动加载 Gitee 图片（折叠再展开时新 img 需要重新加载）
  if (window.loadGiteeImages) window.loadGiteeImages();
}

/** 空文档占位节点：点击即可输入，输入后自动转为真实首节点 */
function makePlaceholderItem() {
  const li = document.createElement('li');
  li.className = 'node-item';
  const row = document.createElement('div');
  row.className = 'node-row';
  row.append(Object.assign(document.createElement('span'), { className: 'bullet', textContent: '•' }));
  const text = document.createElement('span');
  text.className = 'node-text placeholder-text';
  text.contentEditable = 'true';
  text.spellcheck = false;
  text.dataset.raw = '';
  text.textContent = '点击开始输入…';
  text.addEventListener('focus', () => {
    if (!text.dataset.live) { text.textContent = ''; text.dataset.live = '1'; }
  });
  const promote = () => {
    if (!text.dataset.live) return;
    snapshot();
    const node = { id: uid(), text: text.textContent, children: [] };
    state.current.nodes = [node];
    markDirty();
    rebuildAndFocus(node.id);
  };
  text.addEventListener('input', promote);
  text.addEventListener('blur', () => {
    if (text.dataset.live && text.textContent.trim() === '') {
      text.dataset.live = '';
      text.textContent = '点击开始输入…';
    }
  });
  text.addEventListener('keydown', (e) => {
    if (!text.dataset.live) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); promote(); }
  });
  row.appendChild(text);
  li.appendChild(row);
  return li;
}

function focusNode(id) {
  const span = $(`#outline .node-item[data-id="${id}"] .node-text`);
  if (!span) return;
  span.scrollIntoView({ block: 'center', behavior: 'smooth' });
  span.focus();
  const range = document.createRange();
  range.selectNodeContents(span);
  range.collapse(false);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}
function rebuildAndFocus(id) {
  renderDoc();
  focusNode(id);
}
function flashNode(id) {
  const row = $(`#outline .node-item[data-id="${id}"] .node-row`);
  if (!row) return;
  row.scrollIntoView({ block: 'center' });
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 1600);
}

// ============ 键盘 ============
$('#outline').addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  const active = document.activeElement;
  if (!active || !active.classList.contains('node-text')) return;
  const li = active.closest('.node-item');
  if (!li) return;
  const id = li.dataset.id;
  const hasSel = getSelection() && !getSelection().isCollapsed;

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    insertSibling(id);
  } else if (e.key === 'Enter' && e.shiftKey) {
    e.preventDefault();
    document.execCommand('insertLineBreak');
    active.dataset.raw = active.textContent;
  } else if (e.key === 'Tab') {
    e.preventDefault();
    if (e.shiftKey) dedent(id); else indent(id);
  } else if (e.key === 'ArrowUp' && e.altKey) {
    e.preventDefault(); moveNode(id, -1);
  } else if (e.key === 'ArrowDown' && e.altKey) {
    e.preventDefault(); moveNode(id, 1);
  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault(); insertChild(id);
  } else if (e.key === 'Backspace' && !hasSel) {
    const text = active.textContent;
    const sel = getSelection();
    const atStart = sel.rangeCount && sel.getRangeAt(0).startOffset === 0 && sel.getRangeAt(0).collapsed;
    if (text === '' || atStart) {
      // 光标在节点开头：先尝试光标前的字符（空节点才删除）
      const isEmpty = text.trim() === '';
      const pos = sel.rangeCount ? sel.getRangeAt(0).startOffset : 0;
      if (isEmpty || pos === 0) {
        e.preventDefault();
        deleteNode(id);
      }
    }
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault(); save();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault(); undo();
  } else if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') || ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z')) {
    e.preventDefault(); redo();
  }
});

// ============ 图片粘贴上传 ============
async function uploadPastedImage(file, nodeId) {
  toast('图片上传中…');
  try {
    const b64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1]);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
    const r = await api('POST', '/api/upload-image', { name: file.name || 'pasted.png', dataBase64: b64 });
    const info = findInfo(rootNodes(), nodeId);
    if (!info) return;
    snapshot();
    const node = { id: uid(), text: `![图](${r.url})`, children: [] };
    info.node.children = info.node.children || [];
    info.node.children.push(node);
    rebuildAndFocus(node.id);
    markDirty();
    toast('图片已上传并插入');
  } catch (e) {
    toast('图片上传失败: ' + e.message);
  }
}

// ============ 侧边栏 ============
async function refreshSidebar() {
  const [tree, tags] = await Promise.all([api('GET', '/api/tree').catch(() => []), api('GET', '/api/tags').catch(() => [])]);
  state.tags = tags || [];
  state.tree = tree || [];
  renderTree(state.tree);
  renderTags(state.tags);
}

/** 收集所有已有目录路径（用于快捷选择） */
function folderHints() {
  const set = new Set();
  const walk = (items) => items.forEach((it) => {
    if (it.type === 'folder') { set.add(it.path); walk(it.children || []); }
  });
  walk(state.tree || []);
  return [...set].sort((a, b) => a.localeCompare(b, 'zh'));
}
function countDocsUnder(items, folderPath) {
  let n = 0;
  for (const it of items || []) {
    if (it.type === 'doc' && it.path.startsWith(folderPath + '/')) n++;
    else if (it.type === 'folder' && (it.path === folderPath || it.path.startsWith(folderPath + '/'))) n += countDocsUnder(it.children, folderPath);
  }
  return n;
}
function renderTree(tree) {
  const nav = $('#tree');
  nav.innerHTML = '';
  if (!tree.length) {
    nav.innerHTML = '<div class="t-row" style="color:var(--text-dim)">暂无文档，点击「新建文档」开始</div>';
    return;
  }
  const mkBtn = (label, title, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return b;
  };
  const build = (items) => {
    const ul = document.createElement('ul');
    for (const it of items) {
      const li = document.createElement('li');
      if (it.type === 'folder') {
        const row = document.createElement('div');
        row.className = 't-row';
        const open = state.expand.has(it.path || it.name);
        const caret = document.createElement('span');
        caret.className = 't-caret';
        caret.textContent = open ? '▾' : '▸';
        const acts = document.createElement('span');
        acts.className = 't-acts';
        acts.append(
          mkBtn('+', '在此目录新建文档', () => newDoc(it.path)),
          mkBtn('改', '重命名文件夹', () => renameFolder(it.path)),
          mkBtn('×', '删除文件夹', () => deleteFolder(it.path))
        );
        row.append(caret, Object.assign(document.createElement('span'), { className: 't-ico', textContent: '▤' }), Object.assign(document.createElement('span'), { className: 't-name', textContent: it.name }), acts);
        row.addEventListener('click', () => {
          const key = it.path || it.name;
          if (state.expand.has(key)) state.expand.delete(key); else state.expand.add(key);
          persistExpand();
          renderTree(state.filteredTree || state.tree);
        });
        li.appendChild(row);
        if (open) {
          const sub = build(it.children || []);
          if (sub.children.length) li.appendChild(sub);
        }
      } else {
        const row = document.createElement('div');
        row.className = 't-row' + (state.current && state.current.path === it.path ? ' active' : '');
        const acts = document.createElement('span');
        acts.className = 't-acts';
        acts.append(mkBtn('移', '移动到文件夹', () => moveDocTo(it.path)));
        row.append(Object.assign(document.createElement('span'), { className: 't-caret', textContent: '' }), Object.assign(document.createElement('span'), { className: 't-ico', textContent: '·' }), Object.assign(document.createElement('span'), { className: 't-name', textContent: it.title || it.name }), acts);
        row.addEventListener('click', () => openDoc(it.path));
        li.appendChild(row);
      }
      ul.appendChild(li);
    }
    return ul;
  };
  nav.appendChild(build(tree));
}

// 展开全部 / 折叠全部
function collectFolders(items, out) {
  out = out || [];
  for (const it of items || []) {
    if (it.type === 'folder') {
      out.push(it.path || it.name);
      collectFolders(it.children, out);
    }
  }
  return out;
}
function expandAll() {
  const folders = collectFolders(state.tree);
  folders.forEach((f) => state.expand.add(f));
  persistExpand();
  renderTree(state.tree);
}
function collapseAll() {
  state.expand.clear();
  persistExpand();
  renderTree(state.tree);
}
document.addEventListener('DOMContentLoaded', () => {
  $('#btn-expand-all')?.addEventListener('click', expandAll);
  $('#btn-collapse-all')?.addEventListener('click', collapseAll);
});
function renderTags(tags) {
  const box = $('#tag-list');
  box.innerHTML = '';
  for (const t of tags.slice(0, 24)) {
    const b = document.createElement('button');
    b.className = 'tag-chip';
    b.textContent = `${t.tag} ${t.count}`;
    b.addEventListener('click', () => { $('#search').value = t.tag; runSearch(t.tag); });
    box.appendChild(b);
  }
}

// ============ 搜索 ============
let searchTimer2;
$('#search').addEventListener('input', () => {
  clearTimeout(searchTimer2);
  const q = $('#search').value.trim();
  if (!q) { $('#search-results').classList.add('hidden'); return; }
  searchTimer2 = setTimeout(() => runSearch(q), 300);
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
    e.preventDefault();
    $('#search').focus();
  }
});
async function runSearch(q) {
  const results = await api('GET', `/api/search?q=${encodeURIComponent(q)}`).catch(() => []);
  state.searchResults = results;
  const box = $('#search-results');

  // 同时过滤左侧目录树：只显示匹配的文档
  if (!q) {
    state.filteredTree = null;
    renderTree(state.tree);  // 恢复完整目录
    box.classList.add('hidden');
    return;
  }

  // 构建过滤后的树（只保留路径/标题匹配的节点及其祖先）
  const matchedPaths = new Set(results.map(r => r.path));
  function filterTree(nodes) {
    const out = [];
    for (const n of nodes) {
      if (n.type === 'folder') {
        const filtered = filterTree(n.children || []);
        if (filtered.length) out.push({ ...n, children: filtered });
      } else {
        if (matchedPaths.has(n.path)) out.push(n);
      }
    }
    return out;
  }
  state.filteredTree = filterTree(state.tree);
  renderTree(state.filteredTree);

  box.classList.remove('hidden');
  box.innerHTML = '';
  if (!results.length) {
    box.innerHTML = '<div class="sr-empty">没有匹配的笔记</div>';
    return;
  }
  const ql = q.toLowerCase();
  for (const r of results) {
    const item = document.createElement('div');
    item.className = 'sr-item';
    const hl = (s) => {
      const i = s.toLowerCase().indexOf(ql);
      if (i < 0) return esc(s);
      return esc(s.slice(0, i)) + '<b>' + esc(s.slice(i, i + ql.length)) + '</b>' + esc(s.slice(i + ql.length));
    };
    item.innerHTML = `<div class="sr-title">${hl(r.title)}</div><div class="sr-path">${esc(r.path)}</div>` +
      (r.snippets || []).map((s) => `<div class="sr-snip">${hl(s.slice(0, 120))}</div>`).join('');
    item.addEventListener('click', () => { openDoc(r.path); });
    box.appendChild(item);
  }
}

// ============ 文档打开 / 新建 / 删除 ============
async function openDoc(path) {
  const doc = await api('GET', `/api/docs/${encPath(normPath(path))}`);
  if (!doc) return;
  state.current = { path: doc.path, title: doc.title || '', nodes: doc.nodes || [], tags: doc.tags || [] };
  state.undo = [];
  state.redo = [];
  state.dirty = false;
  state.view = 'outline';
  setStatus('已加载');
  location.hash = 'doc=' + encodeURIComponent(doc.path);
  // 默认折叠到一级（只显示顶层节点）
  state.collapsed = new Set();
  collectNodeIds(state.current.nodes || [], 1).forEach(x => { if (x.depth >= 1) state.collapsed.add(x.id); });
  renderDoc();
  $('#search-results').classList.add('hidden');
  $('#search').blur();
}

async function openDaily() {
  const doc = await api('GET', '/api/daily');
  if (doc.created) toast('已创建今日日志');
  state.current = { path: doc.path, title: doc.title || '', nodes: doc.nodes || [], tags: doc.tags || [] };
  state.undo = [];
  state.redo = [];
  state.dirty = false;
  state.view = 'outline';
  setStatus('已加载');
  location.hash = 'doc=' + encodeURIComponent(doc.path);
  renderDoc();
}

async function newDoc(prefillFolder = '') {
  // 防御：事件对象等非字符串参数（按钮直接绑定函数时会把 PointerEvent 传进来）
  if (typeof prefillFolder !== 'string') prefillFolder = '';
  const vals = await modal({
    title: '新建文档',
    fields: [
      { label: '标题', name: 'title', placeholder: '文档标题（自动成为文件名）' },
      { label: '目录（可选，点击下方已有目录快速填入）', name: 'folder', value: prefillFolder, placeholder: '如 工作/项目A（留空为根目录）', hints: folderHints() },
    ],
    submitText: '创建',
  });
  if (!vals) return;
  try {
    const r = await api('POST', '/api/docs', { title: vals.title, folder: vals.folder.trim() });
    await openDoc(r.path);
  } catch (e) { toast('创建失败: ' + e.message); }
}

/** 快速移动到文件夹 */
async function moveDocTo(docPath) {
  const vals = await modal({
    title: '移动到文件夹',
    fields: [
      { label: '目标目录', name: 'folder', placeholder: '如 工作/项目A（留空移回根目录）', hints: folderHints() },
    ],
    submitText: '移动',
  });
  if (!vals) return;
  const name = docPath.split('/').pop();
  const target = normPath((vals.folder.trim() ? vals.folder.trim() + '/' : '') + name);
  if (target === docPath) return;
  try {
    const r = await api('POST', '/api/move', { from: docPath, to: target });
    if (state.current && state.current.path === docPath) await openDoc(r.to);
    toast('已移动');
    refreshSidebar();
  } catch (e) { toast('移动失败: ' + e.message); }
}

/** 重命名文件夹（批量移动目录下所有文档） */
async function renameFolder(path) {
  const vals = await modal({
    title: '重命名文件夹',
    fields: [
      { label: '新目录路径（可带父目录）', name: 'path', value: path, placeholder: '如 工作/新名字', hints: folderHints() },
    ],
    submitText: '重命名',
  });
  if (!vals) return;
  const to = vals.path.trim();
  if (!to || to === path) return;
  try {
    const r = await api('POST', '/api/folder/rename', { from: path, to });
    toast(`已移动 ${r.moved} 篇文档`);
    // 当前打开的文档如果在旧目录下，自动跟随新路径
    if (state.current && state.current.path.startsWith(path + '/')) {
      const hit = (r.movedPaths || []).find((x) => x.from === state.current.path);
      if (hit) await openDoc(hit.to);
      else { state.current = null; $('#editor').classList.add('hidden'); $('#welcome').classList.remove('hidden'); location.hash = ''; }
    }
    refreshSidebar();
  } catch (e) { toast('重命名失败: ' + e.message); }
}

/** 删除文件夹（批量删除目录下所有文档） */
async function deleteFolder(path) {
  const n = countDocsUnder(state.tree, path);
  const ok = await confirmModal(`删除文件夹「${path}」及其下 ${n} 篇文档？删除不可恢复。`);
  if (!ok) return;
  try {
    const r = await api('DELETE', '/api/folder?path=' + encodeURIComponent(path));
    if (state.current && state.current.path.startsWith(path + '/')) {
      state.current = null;
      $('#editor').classList.add('hidden');
      $('#welcome').classList.remove('hidden');
      location.hash = '';
    }
    toast(`已删除 ${r.removed} 篇文档`);
    refreshSidebar();
  } catch (e) { toast('删除失败: ' + e.message); }
}

async function showProps() {
  if (!state.current) return;
  const vals = await modal({
    title: '文档属性',
    fields: [
      { label: '标题', name: 'title', value: state.current.title, placeholder: '文档标题' },
      { label: '文件路径（相对笔记根目录，可改以移动文档）', name: 'path', value: state.current.path, placeholder: 'journal/2026/2026-09-23.md' },
    ],
    submitText: '保存',
  });
  if (!vals) return;
  try {
    let path = state.current.path;
    const target = normPath(vals.path.trim());
    if (target !== path) {
      const r = await api('POST', '/api/move', { from: path, to: target });
      path = r.to;
    }
    const doc = await api('GET', `/api/docs/${encPath(path)}`);
    state.current.title = vals.title;
    state.current.path = path;
    const saved = await api('PUT', `/api/docs/${encPath(path)}`, { title: vals.title, nodes: state.current.nodes });
    state.current = { path: saved.path, title: saved.title, nodes: saved.nodes, tags: doc.tags || [] };
    state.dirty = false;
    setStatus('已保存');
    location.hash = 'doc=' + encodeURIComponent(saved.path);
    renderDoc();
    toast('属性已更新');
  } catch (e) { toast('操作失败: ' + e.message); }
}

async function delDoc() {
  if (!state.current) return;
  const ok = await confirmModal(`确定删除「${state.current.title || state.current.path}」？删除不可撤销。`);
  if (!ok) return;
  try {
    await api('DELETE', `/api/docs/${encPath(state.current.path)}`);
    state.current = null;
    $('#editor').classList.add('hidden');
    $('#welcome').classList.remove('hidden');
    location.hash = '';
    refreshSidebar();
    toast('已删除');
  } catch (e) { toast('删除失败: ' + e.message); }
}

// ============ 思维导图 ============
function renderMindMap() {
  const svg = $('#mindmap');
  const nodes = state.current ? state.current.nodes : [];
  svg.innerHTML = '';
  if (!nodes.length) { svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#888">暂无内容</text>'; return; }

  const W = 1800, H = 1100;
  const cx = W / 2, cy = H / 2;
  const leaf = (n) => (n.children && n.children.length ? n.children.reduce((s, c) => s + leaf(c), 0) : 1);
  const placed = [];
  const title = state.current.title || '未命名';

  const place = (n, ang0, angSpan, depth, px, py) => {
    const ang = ang0 + angSpan / 2;
    const r = 130 + depth * 130;
    const x = cx + r * Math.cos(ang);
    const y = cy + r * Math.sin(ang);
    placed.push({ n, x, y, depth, px, py });
    const kids = n.children || [];
    const total = kids.reduce((s, c) => s + leaf(c), 0) || 1;
    let acc = ang0;
    for (const c of kids) {
      const span = angSpan * (leaf(c) / total);
      place(c, acc, span, depth + 1, x, y);
      acc += span;
    }
  };
  // 虚拟根：标题在中心
  const virtualRoot = { children: nodes };
  place(virtualRoot, 0, Math.PI * 2, 0, cx, cy);

  const palette = ['#3b6ef6', '#5f8bff', '#22a06b', '#e0a32e', '#d4648a', '#7a5af8', '#3aa0b8'];
  const pad = 10;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const groups = [];
  for (const p of placed) {
    if (!p.n.children) continue; // 虚拟根不画
    const w = Math.min(46 + (p.n.text || '').length * 7.5, 210);
    const h = 32;
    const x = p.x - w / 2, y = p.y - h / 2;
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'mm-node');
    g.setAttribute('transform', `translate(${x},${y})`);
    g.dataset.nid = p.n.id;
    g.style.cursor = 'pointer';
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('width', w); rect.setAttribute('height', h);
    rect.setAttribute('rx', '9'); rect.setAttribute('ry', '9');
    rect.setAttribute('fill', palette[p.depth % palette.length]);
    g.appendChild(rect);
    const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    txt.setAttribute('x', pad); txt.setAttribute('y', h / 2 + 4);
    txt.textContent = (p.n.text || '').replace(/^#/, '').slice(0, 26);
    g.appendChild(txt);
    g.addEventListener('click', () => {
      state.view = 'outline';
      renderDoc();
      focusNode(p.n.id);
      flashNode(p.n.id);
    });
    groups.push(g);
  }

  // 连接线
  const ns = 'http://www.w3.org/2000/svg';
  for (const p of placed) {
    if (p.n.children && p.depth > 0) {
      for (const c of p.n.children) {
        const child = placed.find((q) => q.n.id === c.id);
        if (!child) continue;
        const line = document.createElementNS(ns, 'path');
        const mx = (p.x + child.x) / 2;
        line.setAttribute('d', `M ${p.x} ${p.y} C ${mx} ${p.y}, ${mx} ${child.y}, ${child.x} ${child.y}`);
        line.setAttribute('fill', 'none');
        line.setAttribute('stroke', '#c9c9c9');
        line.setAttribute('stroke-width', '1.5');
        svg.appendChild(line);
      }
    }
  }

  // 中心标题
  const cg = document.createElementNS(ns, 'g');
  const cw = Math.min(60 + title.length * 15, 320), ch = 40;
  cg.setAttribute('transform', `translate(${cx - cw / 2},${cy - ch / 2})`);
  const cr = document.createElementNS(ns, 'rect');
  cr.setAttribute('width', cw); cr.setAttribute('height', ch); cr.setAttribute('rx', '12');
  cr.setAttribute('fill', '#222'); cr.setAttribute('opacity', '.92');
  const ct = document.createElementNS(ns, 'text');
  ct.setAttribute('x', cw / 2); ct.setAttribute('y', ch / 2 + 5);
  ct.setAttribute('text-anchor', 'middle'); ct.setAttribute('fill', '#fff'); ct.setAttribute('font-weight', '600');
  ct.textContent = title.slice(0, 24);
  cg.append(cr, ct);
  svg.appendChild(cg);
  for (const g of groups) svg.appendChild(g);

  const padv = 60;
  const vw = Math.max(W, (maxX - minX) + padv * 2);
  const vh = Math.max(H, (maxY - minY) + padv * 2);
  svg.setAttribute('viewBox', `${Math.min(cx - vw / 2, minX - padv)} ${Math.min(cy - vh / 2, minY - padv)} ${vw} ${vh}`);
}

// ============ 弹窗 ============
function modal({ title, fields, submitText = '确定' }) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    const box = document.createElement('div');
    box.className = 'modal';
    box.innerHTML = `<h3>${esc(title)}</h3>` + fields.map((f, i) =>
      `<label for="m-${i}">${esc(f.label)}</label><input type="text" id="m-${i}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}">` +
      ((f.hints && f.hints.length) ? `<div class="m-hints">${f.hints.map((h) => `<button type="button" data-hint="${i}" data-v="${esc(h)}">${esc(h)}</button>`).join('')}</div>` : '')
    ).join('') +
      `<div class="m-actions"><button class="btn" data-act="cancel">取消</button><button class="btn primary" data-act="ok">${esc(submitText)}</button></div>`;
    root.innerHTML = '';
    root.appendChild(box);
    root.classList.add('show');
    const first = box.querySelector('input');
    if (first) setTimeout(() => first.focus(), 30);
    const done = (vals) => { root.classList.remove('show'); root.innerHTML = ''; resolve(vals); };
    box.querySelectorAll('.m-hints button').forEach((b) => b.addEventListener('click', () => {
      const inp = box.querySelector(`#m-${b.dataset.hint}`);
      if (inp) inp.value = b.dataset.v;
    }));
    box.querySelector('[data-act=ok]').addEventListener('click', () => {
      const vals = {};
      fields.forEach((f, i) => { vals[f.name] = box.querySelector(`#m-${i}`).value; });
      done(vals);
    });
    box.querySelector('[data-act=cancel]').addEventListener('click', () => done(null));
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') box.querySelector('[data-act=ok]').click();
      if (e.key === 'Escape') done(null);
    });
  });
}
function confirmModal(msg) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    const box = document.createElement('div');
    box.className = 'modal';
    box.innerHTML = `<h3>确认</h3><div class="m-msg">${esc(msg)}</div><div class="m-actions"><button class="btn" data-act="cancel">取消</button><button class="btn danger" data-act="ok">确定</button></div>`;
    root.innerHTML = '';
    root.appendChild(box);
    root.classList.add('show');
    const done = (v) => { root.classList.remove('show'); root.innerHTML = ''; resolve(v); };
    box.querySelector('[data-act=ok]').addEventListener('click', () => done(true));
    box.querySelector('[data-act=cancel]').addEventListener('click', () => done(false));
  });
}

// ============ 事件绑定 ============
$('#btn-daily').addEventListener('click', openDaily);
$('#btn-new').addEventListener('click', () => newDoc());
$('#btn-props').addEventListener('click', showProps);
$('#btn-del').addEventListener('click', delDoc);
$('#btn-map').addEventListener('click', () => { state.view = 'mindmap'; renderDoc(); });
$('#btn-outline').addEventListener('click', () => { state.view = 'outline'; renderDoc(); });
$('#btn-doc-expand').addEventListener('click', () => setAllCollapsed(false));
$('#btn-doc-collapse').addEventListener('click', () => collapseToLevel(1));
$('#doc-title').addEventListener('input', (e) => {
  if (!state.current) return;
  state.current.title = e.target.value;
  markDirty();
});
$('#btn-theme').addEventListener('click', () => {
  document.body.classList.toggle('dark');
  localStorage.setItem('lm.dark', document.body.classList.contains('dark') ? '1' : '');
});
window.addEventListener('beforeunload', (e) => {
  if (state.dirty && state.current) { e.preventDefault(); e.returnValue = ''; }
});
window.addEventListener('hashchange', async () => {
  const m = location.hash.match(/^#doc=(.+)$/);
  if (m) {
    const p = decodeURIComponent(m[1]);
    if (!state.current || state.current.path !== p) {
      try { await openDoc(p); } catch { /* 文档可能已删除 */ }
    }
  }
});

// ============ 启动 ============
window.addEventListener('DOMContentLoaded', async function init() {
  if (localStorage.getItem('lm.dark')) document.body.classList.add('dark');
  try {
    const h = await api('GET', '/api/health');
    state.health = h;
    const badge = $('#mode-badge');
    badge.textContent = h.mode === 'github' ? 'GitHub 存储' : (h.mode === 'gitee' ? 'Gitee 存储' : '本地模式');
    badge.title = h.repo ? `${h.repo}/${h.branch}/${h.root}` : '';
    $('#foot-info').textContent = h.repo || '离线可用';
  } catch (e) {
    toast('无法连接后端服务，请确认已运行 npm start');
  }
  // token 就绪后（PWA 首次打开输入 PAT 后）自动刷新目录
  if (typeof onTokenReady === 'function') onTokenReady(() => refreshSidebar().catch(() => {}));
  await refreshSidebar().catch(() => {});
  const m = location.hash.match(/^#doc=(.+)$/);
  if (m) {
    try { await openDoc(decodeURIComponent(m[1])); } catch { /* 文档可能已删除 */ }
  }
});

// 移动端侧边栏抽屉
(function() {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (!sidebar) return;
  function toggle() { sidebar.classList.toggle('open'); }
  function close() { sidebar.classList.remove('open'); }
  // 文档头部的菜单按钮
  const btn1 = document.getElementById('menu-toggle');
  if (btn1) btn1.addEventListener('click', toggle);
  // 欢迎页的浮动菜单按钮
  const btn2 = document.getElementById('menu-toggle-welcome');
  if (btn2) btn2.addEventListener('click', toggle);
  if (backdrop) backdrop.addEventListener('click', close);
  // 选中文档后自动关闭抽屉
  window.addEventListener('hashchange', close);
})();