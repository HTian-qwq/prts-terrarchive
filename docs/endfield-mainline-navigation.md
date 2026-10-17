# 终末地主线导航

`corpus_navigate` 是确定性的本地主线目录入口，不调用云端检索，也不生成剧情内容。玩家不必先知道数据包中的系列名或任务名。

```json
{}
{"query":"最新主线"}
{"query":"1.6的主线"}
{"query":"丹青渡主线"}
{"query":"第二章第八进程"}
{"query":"进程VIII"}
{"query":"第二章第三进程"}
```

仅支持可选 `query` 和 `game:"endfield"`。省略 query 返回完整目录。目录包括序章和第一、二章共13个进程。返回值绑定当前 `data_version`，每个进程提供多个梗概及其 `corpus_search`/`corpus_read` 参数、任务集合入口、上下进程入口和逐项 `availability`。默认目录文本约2300字符，完整分类和来源元数据保留在结构化结果中。

最新仅指目录中当前本地可定位的最新进程，不宣称实时游戏版本；旧资料包会降到实际覆盖边界，同时保留新进程的未安装说明。缺少正文不会被解释为没有剧情。读取时原样使用返回的 `read` 定位，合集续页使用 `page.continuation`，不推断文件名中的时间先后。

## 三种信息分别取证

- **任务分类**：原始 `MissionRuntimeAsset/{missionId}.json` 的 `missionType`、`charId`、`missionChapterBitmask`、`sortId`、`missionName.key`。导出器生成的 e/c 前缀分类独立保存。唐唐的 c27m1–c27m5 原始 `missionType=0`，属于第二章进程III的主线导航，且有角色关联。角色 Wiki 的文档类型不等于任务分类。
- **显示目录与任务顺序**：社区显式有序目录提供旧进程的章/进程/任务顺序。英文任务名经 TextTable.id→官方 EN/CN I18n 表精确连接至原始任务ID，不凭英文同名强行选ID。`sortId` 全为0，不能用于排序；`missionChapterBitmask` 不当作章编号。两处 Work Preparation 与一处 Freedom of Expansion 保留候选和未决状态。第二章进程VIII目前只证实五篇正文成员，跨任务顺序 `unknown`，逐任务 `order=null`。
- **公开版本归属**：版本主题与完整内部构建号分开。1.1进程III、1.4进程VII有官方开放边界；1.2进程IV–VI来自前后官方边界的推导；1.6进程VIII由社区资料支持。1.0、1.3、1.5的新增进程映射保留未知，不表示该版本无新增主线。返回 `mapping_status`、`evidence`，不截取内部构建号推断公开版本。

第二章进程III跨“意外来袭”和“风平水不静”两个生成系列，因此返回两份梗概；第二章进程I的现有生成梗概名为“准备工作”，保留可验证的现有标题。任务名与进程名同名时，“上一段/下一段”不会把任务前后关系偷换成进程前后关系；结果明确 `navigation_level:"process"` 并说明锚点。

## 重建与验证

目录文件为 `resources/endfield-mainline.json`，构建器为 `bin/build-mainline-catalog.py`。构建器仅用Python标准库，按保存的来源快照和固定资料构建，不在运行工具时联网。默认输入为本仓库的最新导出和同机拆包目录，可通过脚本参数指定；先运行 `--help` 查看可配置路径。

```sh
python3 -B bin/build-mainline-catalog.py
node --test test/navigation.test.js
npm test
```

父仓库还提供 `agent/evals/endfield-mainline.mjs RELEASES_DIR [REPORT]`：用实际 CorpusStore 运行玩家问法，读取所有梗概以及最新进程的五个任务原文，验证返回定位器而非只验证结果非空。

来源：

- https://endfield.wiki.gg/wiki/Mission/Main?oldid=63259
- https://endfield.wiki.gg/wiki/Sanctuary_of_Ink?oldid=65256
- https://endfield.gryphline.com/en-us/news/8907
- https://endfield.gryphline.com/en-us/news/0751
- https://endfield.gryphline.com/en-us/news/5200
