# 终末地官方资料多语言查询调研

调研日期：2026-09-19。本文是实现建议，尚未修改工具、资料包或发布版本。

## 结论

现有游戏数据足以提供官方多语言查询。建议先增加一个通用命名的 `corpus_i18n` 工具：输入中文/外语原句或已有资料定位，返回同一文本 ID 对应的官方本地化文本。第一版围绕名称、原句和记录级对照；全文切换语言可以随后在同一数据层上扩展。

主要工作是把来源文本 ID 接入资料包，并提供查询入口。无需为此改造整个界面，也无需生成翻译、重建多语言向量库或复制十四套剧情结构。

## 实际数据与验证

当前插件激活资料：`agent-corpus-v2-20260916-yuexingshuishang-milu4-v2`。

终末地官方包：`endfield_official_game`，游戏版本 `1.5.3`，内容版本 `xuesong-youmeng`。包内共有 11,257 篇文档、51,884 行，其中剧情/游戏内文本 10,763 篇、官方档案 430 篇、角色档案及语音各 32 篇。

实际来源以 `Endfield_Wiki_Lib/data/export/source.json` 为准：

- 原始表：`/home/cloudstack/sda/endfieldgamedata/tables/1.5.3/Table`。
- 含来源追踪的中文 Story：`/home/cloudstack/sda/endfieldgamedata/story/data/lang/CN`。
- 仓库内的 `endfield_research_kit/webui/data` 是较早的一份输出，不能直接作为当前版本的数据源。

当前版本存在 14 张 `I18nTextTable_<LANG>.json`：`CN EN JP KR TC MX BR FR DE RU IT ID TH VN`。每张均有 147,602 个键，键集合一致；外语表中存在空值，不能据此承诺每条都有十四种文本。当前 `I18nHotFix.json` 为空，但后续版本仍须应用热修复。

实测同一文本 ID `3040337695571803105`：

| 语言 | 官方文本 |
| --- | --- |
| CN | 管理员，你来了。 |
| EN | Endmin, you're here. |
| JP | 管理人、お疲れ様です。 |
| KR | 관리자, 왔어? |

它来自 `DialogTextTable[dlg_a1m10_1_001].dialogText`，不是按语义相似度匹配。说话人也有独立文本 ID，可同时返回佩丽卡 / Perlica / ペリカ / 펠리카。

### 对当前已发布资料的只读核对

核对方法：读取插件的全部终末地官方 gzip 分片，与当前来源 Story 重放 `_clean_line` 的过滤、补 ID 规则，逐行验证文本和 ID，再检查 `_debug.fields.text.raw.id`。环境对话需要保留子节点，SNS 需要恢复导出时的补 ID 规则；仅按 `source_line_id` 建字典会误报大量缺失。

| 资料 | 核对结果 | 实现含义 |
| --- | --- | --- |
| 剧情及游戏内文本 | 42,724 行全部与来源重放结果一致；42,689 行有可直接提取的正文文本 ID，约 99.92% | 可在导出时保存简化后的来源映射 |
| 正文文本 ID | 上述行共涉及 42,425 个不同 ID；45 行渲染文本与原始字典不同 | 保留清洗/渲染规则，不能只替换可见字符串 |
| 暂无直接正文 ID | SNS 32 行、黑屏文字 3 行 | 需检查组合文本/媒体等来源；不能自动宣称缺少官方翻译 |
| 普通对话 | 21,719 行均能定位文本 ID；其中 20,781 行的 EN/JP/KR 文本非空 | 938 行目标语言为空，需返回缺失状态 |
| 角色档案与语音 | 2,477 行档案和 2,535 行语音均能通过角色及记录 ID 回到表字段；EN/JP/KR/TC 对应记录文本非空 | 保留角色命名空间，按记录/语音文本 ID 查找 |
| 档案库 | 430 篇中 429 篇的原始 ID 能直接命中 `PrtsAllItem` | 剩余条目的原始 ID 是“桂花糕”，需要单独核实映射 |
| 角色档案分段 | 186 条档案记录中，38 条在 CN/EN/JP/KR/TC 之间存在非空段落数量差异 | 不能将中文 `pN` 当作跨语言对齐键 |

例如佩丽卡 `CN_02`：中文 4 段、英文 3 段、日文 4 段、韩文 7 段、繁中 4 段。跨语言返回这条完整记录，标注 `alignment: "record"`，比制造段落一一对应更可靠。

以上统计绑定本次本地数据快照，不代表未来版本的覆盖率；映射成功也不等于所有目标语言均有正文。

## 现有链路的缺口

1. `src/index.js` 的 `modelReadToContract` 使用参数白名单，目前拒绝 `language`；`corpus_search` 和契约也没有语料语言维度。
2. `data_update/endfield_documents.py` 已支持 `language="CN"` 参数，但 `_clean_line` 只保留可读内容和行 ID，丢弃了包含 i18n ID 的来源追踪。
3. `agent/scripts/build_endfield_browser_pack.py` 保留剧情 `source_line_id`、角色 `source_record_id` / `source_paragraph`，未编译本地化字典或字段映射。文档 ID 也没有语言维度，不能把多个语言包直接当普通文档合并。
4. `Endfield_Wiki_Lib/scripts/export_game_data.py::step_char_profiles` 写死读取 CN，导出时去掉了 `recordDesc` / `voiceDesc` 的文本 ID。
5. 档案目前从整理后的 Markdown 编译，主要保留档案级 `original_id`。底层可通过 `PrtsAllItem.contentId → RichContentTable.contentList` 找到正文 ID；多媒体走 `RadioTable.radioSingleDataList`。现成 `endfield-exporters/exporters/archive_exporter.py` 已演示这些关联，并保留正文 `textId`。
6. `src/evidence-state.js` 按文档和行号缓存读取及覆盖状态。直接给 `corpus_read` 增加语言参数，还必须修改去重、缓存、分页、引用与展示，否则读完中文后请求英文可能错误复用中文结果。

## 建议的工具接口

下面是拟议接口，当前尚不可调用。

最小入口：用名称或原句查询官方多语言文本。

```js
corpus_i18n({
  game: "endfield",
  query: "管理员，你来了。",
  source_language: "CN",
  languages: ["EN", "JP", "KR"]
})
```

定位入口：复用已有 `corpus_search` / `corpus_read` 返回的文档定位，避免 agent 复制长句。

```js
corpus_i18n({
  document_uid: "<已有结果返回的 document_uid>",
  line: 1,
  languages: ["EN", "JP"],
  data_version: "<已有结果返回的 data_version>"
})
```

建议同时允许 `text_ids: ["3040337695571803105"]`，用于精确复查和批量读取。查询、文档定位、文本 ID 三种入口需有明确的互斥规则。

返回内容包括：来源语言及原文、目标语言正文、`text_id`、可用的文档/来源字段定位、`game_version`、`data_version`、对齐粒度和每种语言的状态。名称、说话人、档案标题和正文分别保留映射。

约定：

- 查询优先精确匹配，可显式支持字面量片段搜索；相同原文对应多个 ID 时返回候选和上下文，不选第一个碰巧匹配的译文。
- 原句通常按 `text` 对齐；角色档案按 `record` 对齐；Markdown 档案的行号先定位原始内容块，无法证明行级映射时返回整条记录。
- 目标语言空值返回 `missing_localization`；未建立来源映射返回 `unmapped_source`；包未安装返回 `unavailable`。三者不能混为一谈，也不静默回退到中文。
- 所有文本 ID 使用字符串。游戏文本 ID 超出 JavaScript 安全整数范围，应在 Python 编译阶段转字符串，避免 Node 直接解析原始表的数字 ID 后丢精度。
- 新工具保留独立结果预算、分页和按版本缓存，不计入现有中文阅读覆盖。
- 引用明确标注语言与来源文本/记录。输入的中文行号只是定位锚点，不冒充目标语言中的同一行号。

## 数据与打包方案

采用“字段映射 + 各语言字典”，共享现有文档和剧情结构：

```text
已有 document_uid / 中文行
  → 版本绑定的来源字段映射
  → 文本 ID 或一组文本 ID
  → I18nTextTable_<目标语言>[ID]
```

映射建议保留 `source_table`、`row_id`、必要的 `node_id`、`field`、`text_id`、渲染规则。环境对话的 `source_line_id` 并不总是唯一；SNS 的当前行 ID 可能是导出器生成的，不能把二者都视为原始表主键。

第一版可以把 localization 作为 `endfield_official_game` 的版本化附件，先覆盖已收录官方资料引用的文本 ID及名称/标题字段；若需要查询所有游戏 UI、物品等词条，再明确扩展为完整字典范围。附件不作为普通剧情文档加入现有搜索，避免同一资料重复出现。

需要扩展 manifest 的附件声明、大小/hash 校验、安装下载和发布资产枚举。当前 `src/installer.js` 只识别固定 pack ID 和 `shards/`、`search-index/`、`catalog/` 资源路径，不能仅放入新 JSON 就期待客户端自动下载。旧包没有附件时应正常工作，并让新工具明确返回不具备此能力；新格式使用对应客户端最低版本约束。

读取采用预编译索引、分片及按需解压缓存，查询热路径不扫描全部原始游戏表。发布时绑定同一来源版本及 hash，复用现有官方资料的分发规则。

体积参考：全部十四种语言的完整字符串字典，紧凑 JSON 再 gzip 后实测约 **80.7 MB**，单种约 5.3–7.2 MB。这是全部游戏字符串的参考量，不是拟议官方资料子集的最终包体积，也不含查询索引和来源映射；正式实现应对实际子集重新测量。

## 实现顺序与验证

1. 编译官方资料的文本 ID 映射和多语言字典，输出覆盖率、空值、歧义及未映射清单；先确认“桂花糕”和上述 35 行的来源处理。
2. 给 manifest/installer/publisher 接入附件，再在 `src/store.js` 或独立只读 store 提供查找与缓存。
3. 新增 `src/i18n.js` 并在 `src/index.js` 注册 `corpus_i18n`，接入最小查询入口和已有文档定位。
4. 更新工具契约、检索 Skill 的终末地说明与示例，并同步 `docs/federated-corpus-protocol-v2.md` 的工具面约定。该协议当前列的是固定工具集合；新增工具应保持跨游戏命名，避免另设 `endfield_read` 类协议。
5. 验证剧情、角色档案、语音和六类档案；重点覆盖空译文、重复中文、64 位 ID、SNS/环境对话子节点、不同语言分段差异、富文本处理、版本切换及旧包兼容。

如果后续需要“整篇英文阅读”或“直接用日文搜索所有剧情”，可复用同一字典及映射，再为 `corpus_read` / `corpus_search` 引入完整的语言维度。首轮的 `corpus_i18n` 已能满足快速查官方其他语言的核心需求。
