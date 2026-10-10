import crypto from 'node:crypto';

export function uid() {
  return crypto.randomUUID();
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)、])\s+(.*)$/;
const TITLE_RE = /^#\s+(.+)$/;

export function parseMarkdown(md) {
  const lines = String(md ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  let title = '';
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  const tm = i < lines.length ? lines[i].match(TITLE_RE) : null;
  if (tm) {
    title = tm[1].trim();
    i++;
  }

  const root = { id: 'root', text: '', children: [] };
  const stack = [root];
  let fence = null;

  const attach = (level, node) => {
    const lv = Math.max(0, Math.min(level, stack.length - 1));
    stack.length = lv + 1;
    stack[lv].children.push(node);
    stack[lv + 1] = node;
  };

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const indent = (line.match(/^\s*/) || [''])[0].replace(/\t/g, '  ').length;
    const level = Math.floor(indent / 2);
    const isFence = /^\s*```/.test(line);

    if (fence) {
      fence.children.push({ id: uid(), text: isFence ? line.trim() : line.replace(/^\s+/, ''), children: [] });
      if (isFence) fence = null;
      continue;
    }
    if (isFence) {
      const node = { id: uid(), text: line.trim(), children: [] };
      attach(level, node);
      fence = node;
      continue;
    }
    const lm = line.match(LIST_RE);
    if (lm) {
      attach(level, { id: uid(), text: lm[3].trim(), children: [] });
      continue;
    }
    attach(level, { id: uid(), text: line.trim(), children: [] });
  }
  return { title, nodes: root.children };
}

export function serializeDoc({ title, nodes }) {
  const out = [];
  if (title) out.push(`# ${title}`, '');
  const walk = (node, level) => {
    const text = String(node.text ?? '').replace(/\n/g, ' ').trim();
    if (text.startsWith('```')) {
      out.push('  '.repeat(level) + text);
      for (const c of node.children || []) {
        const ct = String(c.text ?? '');
        out.push('  '.repeat(level + 1) + ct);
      }
      return;
    }
    out.push('  '.repeat(level) + '- ' + text);
    for (const c of node.children || []) walk(c, level + 1);
  };
  for (const n of nodes) walk(n, 0);
  return out.length ? out.join('\n') + '\n' : '';
}

const TITLE_M = /^#\s+(.+)$/m;
export function titleOf(md) {
  const m = String(md ?? '').replace(/^\uFEFF/, '').match(TITLE_M);
  return m ? m[1].trim() : '';
}

const TAG_RE = /(?:^|[^\w#])(#[A-Za-z0-9_\-\u4e00-\u9fa5]{1,40})/g;
export function extractTags(md) {
  const set = new Set();
  for (const m of String(md ?? '').matchAll(TAG_RE)) set.add(m[1]);
  return [...set];
}

export function safeName(title) {
  const s = String(title ?? '')
    .replace(/[\\/:*?"<>|#\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .trim();
  return s.length > 0 && s.length <= 80 ? s : '';
}

export function autoName(prefix = '未命名') {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${prefix}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
