# 本地开发交接 · 2026-09-17

当前 `main` 包含莱茵生命三维场景、性能优化、手动证据板交互、屏幕边缘场景切换，以及独立的界面布局提案。已合入远端 npm 发布流程和 Windows 测试兼容提交。

## 本地继续开发

使用 Node.js 22.19 或更新版本，在仓库目录执行：

```sh
git pull --ff-only origin main
npm ci
npm run build:rhine
npm run preview:rhine
```

预览地址：`http://127.0.0.1:4177`；证据板入口：`http://127.0.0.1:4177/?rhineView=board`。

本地语料包在 `data/releases/`，不进入 Git。可沿用插件设置页下载的资料包，或通过 `PRTS_RHINE_RELEASES` 环境变量指定已有的 releases 目录。便携 Node、依赖目录和会话数据也不进入 Git。

界面源文件在 `ui/rhine/`，构建产物在 `lib/rhine/`。详细操作见 [资料馆开发说明](rhine-lab.md)。

## 尚未应用的设计稿

[`work/interface-study-20260917/`](../work/interface-study-20260917/README.md) 是独立提案，未应用到正式界面。该目录保留 HTML、背景、字体和设计图片，可独立预览。证据板的 Agent 接入仍留待后续开发。

## 本次验证

- `npm run check` 通过。
- `npm run build:rhine` 通过，重新构建后产物无变化。
- `npm test`：366 项，360 通过、5 跳过、1 失败。证据板相关测试通过。

唯一失败发生在 `test/source-map.test.js` 的「每篇资料有稳定 document_uid，云端来源可映射到本地标题和官方行号」用例，旧 v2 游标的续页返回 `PAGE_ANCHOR_INVALID`。

原因：`src/search.js` 的 `exposeTitleContinuation()` 使用 `decoded.nextCandidateIndex` 生成标题锚点，而旧游标解码结果携带 `offset`。用例随后访问错误结果中不存在的 `documents.length`，表现为 TypeError。

相关 `src/search.js`、`src/store.js`、`src/source-map.js` 和 `test/source-map.test.js` 与合入的远端版本一致；这次交接保留现状并记录问题。可使用已安装的真实资料包复现：

```sh
node --test test/source-map.test.js
```
