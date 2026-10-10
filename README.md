# like-mubu PWA + Vercel 部署

把 like-mubu 部署成 PWA，手机浏览器打开即可用，可"添加到主屏幕"像 App 一样。

## 架构

```
手机浏览器（PWA，可添加到主屏幕）
  ↓ /api/*
Vercel Serverless Function（Express，api/index.js）
  ↓ https://gitee.com/api/v5
Gitee 私有仓库 notes/*.md
```

## 部署步骤（10 分钟）

### 1. 把代码推到 Git 仓库
Vercel 连接 GitHub/Gitee 仓库自动部署。
- 在 GitHub 或 Gitee 新建仓库（公开或私有都行）
- 把 `pwa-vercel/` 目录下所有文件推上去

### 2. Vercel 导入
- 打开 https://vercel.com → 用 GitHub/Gitee 账号登录
- 「Add New → Project」→ 选你刚推的仓库
- Framework Preset 选 **Other**
- Root Directory 默认即可
- 点「Deploy」

### 3. 配置环境变量
Vercel 项目 → Settings → Environment Variables，加 4 个：

| Name | Value |
|---|---|
| `GITEE_TOKEN` | `9b369911bce7fc7126b34f4e72db1b1f` |
| `GITEE_REPO` | `liqy153/daily_life` |
| `GITEE_BRANCH` | `main` |
| `GITEE_ROOT` | `notes` |

加完后 Redeploy 一次。

### 4. 手机使用
- 部署完成后 Vercel 给你一个域名（如 `like-mubu.vercel.app`）
- 手机浏览器打开这个 URL
- **iOS Safari**：分享 → 添加到主屏幕
- **Android Chrome**：菜单 → 添加到主屏幕
- 之后桌面图标点开就是全屏 App

## 本地开发（可选）

```bash
cd pwa-vercel
npm install
# 装 vercel CLI
npx vercel dev
```

## 注意事项

- **PAT 安全**：Gitee token 存在 Vercel 环境变量里，不进前端代码包。用完后建议在 Gitee 重置 token。
- **Vercel 免费额度**：100GB 带宽/月 + 10 万次函数调用/天，个人笔记够用。
- **国内访问**：Vercel 域名（.vercel.app）国内访问速度一般，偶尔被墙。如果太慢，可绑自己的域名（需 ICP 备案）。
- **离线**：Service Worker 缓存了静态资源，首次加载后离线可打开 UI，但读写笔记仍需网络。
