# 终末地官方多语言工具

插件 0.2.0 提供 `corpus_i18n`。当前支持终末地官方资料，采用游戏原有文本 ID 查询本地化字典，不生成翻译。资料正文仍保持原有结构和中文行号。

## 使用方式

```js
// 只有名称或原句时，直接反查；默认不显示文本 ID。
corpus_i18n({query: "管理员，你来了。", languages: ["EN", "JP", "KR"]})

// 已有检索结果时，优先沿用可引用位置。
corpus_i18n({title: "<检索结果的完整标题>", line: 1, languages: ["EN"]})
corpus_i18n({document_uid: "<检索结果的定位>", line: 1, languages: ["JP"]})

// 外语原句或片段也可反查。
corpus_i18n({query: "Endmin, you're here.", source_language: "EN", languages: ["CN"]})
corpus_i18n({query: "管理员", match_mode: "literal", languages: ["EN"]})

// 仅在核验/精确复查时暴露内部 ID；ID 始终是字符串。
corpus_i18n({query: "管理员，你来了。", languages: ["EN"], include_ids: true})
corpus_i18n({text_ids: ["3040337695571803105"], languages: ["EN"]})
```

`query`、`title`、`document_uid`、`text_ids` 四选一。`languages` 必填，一次最多 4 种；原句语言默认 `CN`，也接受 `en`、`ja`、`ko`、`zh-CN` 等代码。匹配会规范化大小写、空白及已识别的游戏富文本标签，返回正文保留官方字典值。对相同原文对应的多个文本 ID 保留全部候选和各自来源，不用语义猜测选译文。

结果给出目标语言原文、篇章定位、游戏和资料版本。默认每页 5 个候选、16,000 个正文字符；`max_matches` 为 1–20，`max_chars` 为 1,000–48,000。字符预算约束原文及译文，不含固定的引用元数据。每个候选最多显示 8 个来源位置和 8 个调试来源字段。使用结果中的 `page.continuation` 原样续查；改变查询或资料版本会拒绝旧续页。

大段档案按各语言自身的 Unicode 字符位置分块，`character_start/end` 是从零开始的左闭右开区间，不构成译文逐字符对齐。角色档案 `alignment:record` 返回整条记录，档案库 `alignment:document` 返回整篇中的原始内容块；中文第 N 行只是定位锚点，引用目标文本须注明语言。

状态区分：

- `missing_localization`：对应 ID 在目标语言没有非空文本。
- `unmapped_source`：文档/行尚无可证明的本地化映射。
- `unavailable`：该资料包没有本地化附件，或某种语言未安装。
- `not_found`：本次原句/文本 ID 查询没有命中。

旧资料包可继续搜索、阅读；新工具不会因附件不存在而破坏原有功能。

## 导出与数据格式

`data_update/endfield_documents.py` 在原有规范行上增加可选的 `localization` 字段。它只保存 `_debug.fields` 中的文本 ID、来源表、行、字段、子节点及原始字符串 hash，不携带完整调试内容和开发机路径。所有 int64 文本 ID 在 Python 中转为字符串。

`agent/scripts/build_endfield_browser_pack.py --i18n-table-root` 编译附件。剧情映射来自上述字段；角色记录通过 `char_id + recordID/voId` 回到 `CharacterTable`，并验证中文正文一致；档案使用原始档案 ID，通过 `PrtsAllItem`、`RichContentTable` 或 `RadioTable` 关联。角色记录新增来源 ID，默认阅读响应仍只展示原有字段。

附件只包含已收录官方资料引用的正文、说话人、名称、标题和提示 ID。不是全游戏 UI/物品字典。文件布局：

```text
endfield_official_game/
  pack-manifest.json              # localization 元数据、每个附件的大小及 SHA-256
  localization/catalog.jsonl.gz   # text_id → 来源字段及文档/中文行/对齐粒度
  localization/CN.jsonl.gz        # [text_id, 官方原始字符串]
  localization/EN.jsonl.gz
  localization/JP.jsonl.gz
  ...
  localization-report.json        # 本地构建诊断；不在分发附件内
```

附件 hash 和语言元数据共同纳入 release 内容根；安装器验证大小、hash、路径及来源版本。发布校验、站点资源路由、镜像和增量资源枚举均包含附件。带附件的 release 要求最低插件版本 0.2.0。

运行时首次查询加载来源目录及所需语言，后续精确查询走内存索引；片段搜索扫描缓存后的标准化字典。最多缓存 4 种语言，不影响中文 `corpus_read` 的证据覆盖。切版会废弃旧缓存，进行中的查询拒绝混合版本。

## 构建示例

以下命令在 PRTS.chat 父仓库执行。各路径应来自同一个游戏数据快照；输出使用新目录。

```bash
python -m data_update.cli materialize-endfield-originals \
  --source /home/cloudstack/sda/endfieldgamedata/story \
  --release-id xuesong-youmeng --game-version 1.5.3 \
  --output var/endfield_i18n/<build>/original_game

python agent/scripts/build_endfield_browser_pack.py \
  --source var/endfield_i18n/<build>/original_game \
  --archive-root Endfield_Wiki_Lib/data/export/prts \
  --character-root Endfield_Wiki_Lib/data/export/char_profiles \
  --i18n-table-root /home/cloudstack/sda/endfieldgamedata/tables/1.5.3/Table \
  --output var/endfield_i18n/<build>/endfield_official_game

python agent/scripts/compose_endfield_i18n_release.py \
  --base-release prts-terrarchive/data/releases/<base-release> \
  --endfield-pack var/endfield_i18n/<build>/endfield_official_game \
  --output prts-terrarchive/data/releases/<new-release>
```

组合命令复用其他包的不可变文件，验证新 release，默认标记为 development；它不改 current 指针、不发布。构建后可在本地版本管理中激活。后续正式分发继续使用现有的 release 发布与镜像流程。

## 本次真实数据验证

2026-09-19，游戏版本 1.5.3：

- 77,034 个被官方资料引用的文本 ID，14 种语言，压缩附件约 50.5 MB。
- 剧情正文 42,724 行，其中 42,689 行有直接文本 ID。
- 2,721 条角色档案/语音记录全部建立映射。
- 430 篇档案中 429 篇通过原始 ID 建立映射。
- 未映射清单包含 32 行 SNS、3 行 research-kit 自带的 WebUI 说明，以及原始 ID 为“桂花糕”的一篇档案；这些不会被猜测翻译。

数据覆盖随版本变化，构建报告及实际工具返回状态为准。

2026-09-19 本地验证使用 `agent-corpus-v2-20260919-endfield-i18n-v2`，内容版本为 `7e70f3d55b556d57bc9da5abdefa5a7b36356cb57845f1658fb23074bf9ef75b`。当时为 development release，未发布远端。原本的本地 current 指针备份在 `work/i18n/previous-current.json`。

已通过注册后的插件工具验证中文原句反查、外语反查、剧情行定位、角色记录和资料库内容块；结果保存在 `work/i18n/smoke-v2.json`。首次调用约 4 秒（包含资料初始化，并行运行测试时测得），缓存后同句查询低于 1 毫秒，文档定位约 3–7 毫秒，均为本机单次测量。

2026-09-20 验证结果：相关 Python 测试 28 项通过；注册工具的真实资料验收 17 项通过；全部 14 种语言的 1,078,476 个字段值与原始官方表一致。发布前修复了修改前已存在的旧搜索游标分页问题，全量插件测试 46 个测试文件全部通过。
