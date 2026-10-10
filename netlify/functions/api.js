import express from 'express';
import serverless from 'serverless-http';
import { createStore } from '../../lib/gitee-store.js';
import { createService } from '../../lib/service.js';

const store = createStore();
const service = createService({ store, journalFolder: process.env.JOURNAL_FOLDER || 'journal' });

const app = express();
app.use(express.json({ limit: '20mb' }));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    const status = typeof e.status === 'number' ? e.status : 500;
    if (status >= 500) console.error('[api error]', req.method, req.url, e);
    res.status(status).json({ ok: false, error: e.message || String(e) });
  });

app.get('/api/health', (req, res) =>
  res.json({
    ok: true,
    mode: 'gitee',
    repo: process.env.GITEE_REPO,
    branch: process.env.GITEE_BRANCH,
    root: process.env.GITEE_ROOT,
    time: new Date().toISOString()
  })
);

app.get('/api/tree', wrap(async (req, res) => res.json(await service.docTree())));
app.get('/api/docs', wrap(async (req, res) => res.json(await service.listDocs())));
app.post('/api/docs', wrap(async (req, res) => {
  const { title = '', folder = '' } = req.body || {};
  res.status(201).json(await service.createDoc({ title, folder }));
}));

app.get('/api/search', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  res.json(q ? await service.search(q) : []);
}));
app.get('/api/tags', wrap(async (req, res) => res.json(await service.tags())));
app.get('/api/daily', wrap(async (req, res) => {
  res.json(await service.getOrCreateDaily(String(req.query.date || '')));
}));

app.post('/api/move', wrap(async (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to) throw new Error('from / to 必填');
  res.json(await service.moveDoc(from, to));
}));
app.post('/api/folder/rename', wrap(async (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to) throw new Error('from / to 必填');
  res.json(await service.renameFolder(from, to));
}));
app.delete('/api/folder', wrap(async (req, res) => {
  const p = String(req.query.path || '');
  if (!p) throw new Error('path 必填');
  res.json(await service.removeFolder(p));
}));
app.post('/api/upload-image', wrap(async (req, res) => {
  const { name, dataBase64 } = req.body || {};
  if (!dataBase64) throw new Error('dataBase64 必填');
  res.json(await service.uploadImage({ name, dataBase64 }));
}));

app.get('/api/docs/*', wrap(async (req, res) => {
  const doc = await service.getDoc(req.params[0]);
  if (!doc) return res.status(404).json({ ok: false, error: '文档不存在' });
  res.json(doc);
}));
app.put('/api/docs/*', wrap(async (req, res) => {
  const { title, nodes } = req.body || {};
  res.json(await service.saveDoc(req.params[0], { title, nodes }));
}));
app.delete('/api/docs/*', wrap(async (req, res) => res.json(await service.removeDoc(req.params[0]))));

export const handler = serverless(app);
