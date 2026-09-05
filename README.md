# prts-terrarchive

PRTS.chat 为 DeepSeek Harness（DSH）提供的资料插件：把《明日方舟》与
《明日方舟：终末地》的官方剧情原文，以及社区整理 Wiki、实体图鉴与《泰拉年表》装进本地资料包，为 Agent 提供
带官方行号的检索与引用工具，并可按需接入 PRTS.chat 云端混合检索与 DSH 原生网页工具。

[中文](README.md) | [English](README.en.md)

## 这是什么

本插件为 DSH 提供明日方舟与终末地联合资料检索能力。插件先从 PRTS.chat 取得已批准的
最新 release 与逐文件摘要，再从 ModelScope 镜像或 PRTS.chat 下载本地语料；
Agent 可以离线检索并按官方行号阅读原文；可选的 PRTS.chat 云端混合检索用于发现
候选材料，并将结果映射回本地原文核验。由于云端服务承载能力有限，当前为每个 DSH
实例提供 1000 次匿名调用额度（按实例累计）；额度策略可能根据实际运行情况调整。
- **本地检索**：`corpus_search` 用同一组参数同时检索两款游戏，
  支持游戏、资料类型、内容形式、角色、活动／任务、Wiki 字段等结构化过滤；
- **原文阅读**：`corpus_read` 可按关卡代号、密录名、角色资料类别直接定位，
  并可连续阅读整个明日方舟活动或终末地任务；引用格式统一为《篇章名》第 N 行；
- **活动时间线**：`timeline_search` 检索 PRTS Wiki《泰拉年表》本地投影，
  支持实体别名自动裂变与出处标记反查；
- **云端混合检索**：一次 `cloud_search` 默认并行查询两款游戏的图谱、档案、
  原文与 Wiki，联合排序后映射回本地篇章；
## 核心特性

| 特性 | 说明 |
| --- | --- |
| 按需加载 | 工具只挂在「PRTS 模式」预设下，标准/极简等模式不受污染 |
| 资料全面 | 使用了自己搭建的完善资料指导agent |
| 读取去重 | 会话级证据状态跟踪已进入模型上下文的原文，重复/重叠读取自动回放或只补读新行 |
| 自带皮肤 | Harness 默认 / PRTS Agent / Endfield AIC（含 3D 地图终端风格） |
## 环境要求

- Node.js **≥ 22.19**
- DSH 运行时 **≥ 0.1.2-alpha.1**（已验证安全 `web_fetch` provider 与插件完整加载）
- 磁盘空间：以 release 清单为准；压缩分片保持原样存储，不建立未校验的明文旁路缓存

> `0.1.2-alpha.1` 可用于桌面整合包或从官方 tag 构建，但该版本未发布到 npm。
> 通过 npm 安装 DSH 时请使用 `0.1.2-alpha.2` 或更新版本。

## 安装

本插件不从 npm registry 发布。普通用户优先使用已内置插件的
PRTS/DSH portable 发行版；已安装 DSH 的开发者可以从本地源码目录安装：

```bash
npm install --global @deepseek-ai/dsh@0.1.2-alpha.2
git clone https://github.com/HTian-qwq/prts-terrarchive.git
cd prts-terrarchive
node bin/install.js web
```

安装脚本做两件事：把插件加入指定 profile（`dsh plugin add`），并在
`$DSH_HOME/.agent-presets/prts` 创建「PRTS 模式」预设。不传第二个位置参数时，
安装器固定使用它自身所在的本地插件目录，不会访问 npm registry。

也可以显式传入另一个已存在的本地插件目录或压缩包：

```bash
node bin/install.js web /path/to/prts-terrarchive
```

卸载插件时直接使用 DSH：

```bash
dsh plugin --profile web remove prts-terrarchive
```

### DSH Desktop（anywhere-labs）

使用已内置插件的 portable/DSH Desktop 发行版。如需在托盘菜单打开的
专用终端中从本地源码安装到 `desktop` profile，运行：

```bash
node bin/install.js desktop
```

安装后重启 DSH Desktop。插件使用普通 DSH Host/Web Client 接口；建议先使用 Desktop
的兼容模式。发行版打包器如果已经把插件实体放入 profile，可执行
`node bin/install.js desktop --preset-only`，只生成或迁移「PRTS 模式」preset。

### Windows

核心功能（本地三工具、设置页、资料下载）为纯 Node 实现，Windows 直接可用：

1. 安装 Node.js ≥ 22.19 与 npm 可用的 `@deepseek-ai/dsh@0.1.2-alpha.2` 或更新版本（`npm i -g` 后确认 `dsh.cmd` 命令可用）；
2. 取得本插件源码，在其根目录执行 `node bin/install.js web`。安装脚本经 cmd
   调用 `dsh.cmd`，路径含
   `%` `&` `|` `<` `>` `^` `"` 等字符时会明确报错——把项目放到不含这些字符的
   目录（或设置 `DSH` 环境变量指向 `dsh.cmd` 绝对路径）即可；
3. 资料目录默认 `%USERPROFILE%\.dsh\prts-corpus\releases`。

## 安装后：五步上手

1. **重启** `dsh web`；
2. **设置 → 插件 →「PRTS 语料」**：选择皮肤（Harness 默认 / PRTS Agent / Endfield AIC）；Endfield AIC 的模型与贴图已随插件包安装，切换皮肤不会触发额外下载；
3. **版本管理**：下载双游戏资料（约 330 MiB，优先 ModelScope 镜像）。未安装资料时
   PRTS 模式仍可进入；调用本地工具会提醒前往本设置页安装；
4. **新建会话，顶部模式下拉选「PRTS 模式」**；
5. 直接用自然语言提问，或让模型调用下列工具。

## PRTS 模式的工具面

| 来源 | 工具 | 用途 |
| --- | --- | --- |
| dsh-base（所有模式共有） | bash/sandbox 等 | 常规 Agent 能力，本插件不裁剪 |
| 本插件 | `corpus_search` | 本地语料 grep 检索与目录浏览 |
| 本插件 | `corpus_read` | 按玩家可见定位器或自然标题读取官方行号原文 |
| 本插件 | `timeline_search` | 活动时间线检索 / 出处反查 |
| 本插件 | `cloud_search` / `cloud_inspect` | PRTS.chat 云端混合检索（默认匿名会话） |
| `@deepseek-ai/dsh-tool-web` | `web_search` / `web_fetch` | 公网检索与已知 URL 精读核验 |
| `@deepseek-ai/dsh-tool-skill` | skill 加载器 | 按需加载检索策略技能 |
| 本插件 | `prts-retrieval` 技能 | 检索配方与字段语义（按需注入，不占 system prompt） |

## 工具详解

### corpus_search — 本地语料检索

像 grep 一样搜索本地语料；命中立即返回原行及上下各一行，按文档归并。`query` 使用
短实体名、篇章展示名或原句片段；也可省略 `query`，仅按过滤条件列出资料入口。

| 参数 | 说明 |
| --- | --- |
| `query` | 搜索词（≤512 码点）；在 NFKC 归一化 + 小写后的文本上匹配 |
| `games` | 可选游戏过滤；省略时同时搜索 `arknights` 与 `endfield` |
| `resource_types` | 资料类型过滤（数组内 OR）；明日方舟与终末地可选值见下文 |
| `content_types` | 内容形式，例如 `dialogue`、`cutscene`、`radio`、`sns_chat` |
| `collection_names` | 明日方舟活动名或终末地任务名，使用同一个字段 |
| `match_mode` | `literal`（默认，连续字面匹配）/ `regex`（线性安全子集：字面量、`^`/`$`、`.`、字符类、转义和固定次数 `{n}`；不支持分组、分支及可变量词） |
| `character_names` / `story_names` / `activity_names` | 角色 / 篇章 / 活动展示名过滤 |
| `entity_names` | 只返回出现指定实体的行（自动展开别名） |
| `speakers` | 结构化说话人过滤，只匹配亲口台词 |
| `wiki_sections` | Wiki 标签字段过滤（相关活动、剧情总结、角色剧情概括等 16 种） |
| `context_terms` | 要求命中附近（±3 行）同时出现的语境词，≤8 个 |
| `after` | 下一页的版本绑定可读锚点 `{ data_version, resource_type, title, position }`；与原搜索条件一起原样提交 |

约束：过滤数组每项非空、最多 16 项、单项最长 512 码点。结果预算固定，
保留原搜索条件，并把返回的 `next_after` 原样放入 `after`，可确定性扫描到
`exhausted=true`。锚点使用完整 `data_version`、资料类型和自然标题；资料版本切换后
旧锚点会被拒绝，必须重新搜索。分页不向模型暴露内部签名串。

**明日方舟资料类型（resource_types）**：`story` 官方剧情原文；`character_profile` 档案/招聘/
潜能；`character_module` 模组；`character_voice` 语音；`character_skin` 时装；
`operator_record` 干员密录；`character_bundle` 指定角色的档案+模组+语音+密录；
`character_wiki` 规范角色 Wiki；`story_wiki` 活动/密录 Wiki；
`character_activity_wiki` 角色×活动辅助 Wiki；`reviewed_wiki` 全部自建 Wiki；
`terra_journey` 大地巡旅；`entity_profile` 实体资料；`reference` 时间线等引用资料。

**终末地资料类型**：`original_story` 官方剧情原文；`archive` 官方档案；
`knowledge` 知识资料；`wiki` 整理性 Wiki；`character_story` 角色故事；
`timeline` 时间线资料；`entity_profile` 实体资料。可配合 `content_types` 区分对话、
过场、广播、通讯、环境对话、SNS 等内容形式。

### corpus_read — 原文阅读

优先使用游戏内关卡代号、密录名、角色名、活动名或任务名；无法稳定定位时再使用搜索返回的完整标题。
不使用内部 ID、ref 或路径，同名多合集不会自动合并。

| 用法 | 参数 |
| --- | --- |
| 明日方舟关卡 | `stage_code`；同代号多篇时加 `story_part`：`before` / `after` / `story`；加 `line` 可定点读上下文 |
| 干员密录 | `character_name` + `record_name`；多段密录加 `segment` |
| 角色官方资料 | `character_name` + `material`，类别为 `profile/module/voice/skin/recruitment/potential` |
| 整活动连续阅读 | `activity_name` + `mode: "activity"` |
| 终末地任务连续阅读 | `collection_name` + `mode: "collection"`，可选 `content_types` |
| 其他资料定点上下文 | `title` + `line` |
| 读 Wiki 字段 | `title` + `section`（精确读取标签字段，不含标签行） |
| 分页读其他全文 | `title` + `mode: "document"`（`max_lines` 默认 100、上限 500；`max_chars` 默认 12000、上限 100000） |
| 续读 | 原样提交 `page.continuation`；单篇使用 `line`，活动/任务使用版本绑定的 `position`；旧 `cursor` 仅兼容历史会话 |

引用格式统一为「《篇章名》第 N 行」。剧情文档只返回请求的原文；剧情总结与活动
时间线必须通过 `timeline_search` 或 Wiki 字段显式检索，不自动夹带。

### timeline_search — 活动时间线

按活动名、年份及自动展开的实体别名检索活动时间线（PRTS Wiki《泰拉年表》本地投影）。

| 参数 | 说明 |
| --- | --- |
| `query` | 可选的事件正文短语（≤200 字符） |
| `activity_names` | 活动展示名（≤20 项，如「孤星」；接受主线章节号常见写法） |
| `entity_names` | 角色/实体展示名（≤20 项，自动经别名图鉴裂变后检索） |
| `year_start` / `year_end` | 年份范围（含端点，可单独使用） |
| `source_marker` | 反查模式：原样传回结果中的「年表出处:tle_…」标记，返回该事件完整来源 |
| `max_results` | 最多返回事件数，默认 20、上限 100 |

### cloud_search / cloud_inspect — 云端混合检索（可选）

用自然语言查询 PRTS.chat 云端的图谱、档案、原文、自建 Wiki 和时间线组合索引。
默认走**匿名会话**（内置 PoW 挑战，无需账号），也可在设置页配置静态 token。
返回末尾的「## 可读取原文」列出已映射到本地篇章的完整标题与行号，直接按
`title + line` 调用 `corpus_read` 核验。`cloud_inspect` 用于复查最近一次云端
检索的状态（回答材料、候选、诊断），`request_id` 由运行时自动注入。

### web_search / web_fetch — DSH 原生网页工具

由 PRTS 模式挂载：`web_search` 发现网页候选，`web_fetch` 读取已知 URL 正文，
用于语料之外的历史沿革、词源、民俗等公网信息核验。DSH `0.1.2-alpha.1` 起的匿名
HTTP provider 只允许公网 HTTP(S)，并包含 DNS 解析校验、连接地址固定、同源重定向
以及响应大小和超时限制。

## 检索配方

Wiki 资料不是无差别文本池：工具会区分规范角色页、活动/密录页和角色×活动辅助页。
常见问题的组合方式：

```text
凯尔希参加过哪些活动？
  → corpus_search({ resource_types: ["character_wiki"],
                     character_names: ["凯尔希"], wiki_sections: ["相关活动"] })

凯尔希在《孤星》里做了什么？
  → corpus_search({ resource_types: ["story_wiki"], activity_names: ["孤星"],
                     wiki_sections: ["角色剧情概括"], query: "凯尔希" })

1102 年 1 月发生了什么？
  → timeline_search({ year_start: 1102, year_end: 1102 })

某人亲口说过什么？
  → corpus_search({ speakers: ["阿米娅"], query: "博士" })
```

完整字段语义与更多配方见 `skills/prts-retrieval/references/wiki-schema.md`
与 `retrieval-recipes.md`（模型通过 `prts-retrieval` 技能按需读取）。

## 资料与配置

- 默认资料目录：`$DSH_HOME/prts-corpus/releases`；用户配置：`$DSH_HOME/prts-corpus.json`
- 配置分三层：内置默认值 ← `cordis.patch.yml` 行内 config ← 用户文件（设置页写入，立即生效）
- 版本检查固定请求 `https://prts.chat` 的 `current`；release、pack 和逐分片摘要均以
  PRTS.chat 为信任源，不能被配置改到其他站点。ModelScope 与可配置回退站点只提供
  该固定 release 的压缩字节；
  文件写入前校验大小和 SHA-256，同一 release 的并发准备由跨进程锁合并
- 设置页通过 Harness Connection 认证 RPC 访问 Host；修改配置后云端工具热注册/注销

**可配置项**（`$DSH_HOME/prts-corpus.json`，设置页可视化编辑）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `uiSkin` | `harness` | 皮肤：`harness` / `prts-agent` / `endfield-aic` |
| `cloudEnabled` | `false` | 云端工具开关 |
| `cloudBaseUrl` | `https://prts.chat` | 云端地址（https，或仅环回主机的 http） |
| `cloudToken` | 空 | 静态 Bearer token；留空使用匿名 PoW 会话 |
| `cloudGame` | `all` | `all`（一次检索两款游戏）/ `arknights` / `endfield` |
| `enabledGames` | `["arknights","endfield"]` | 本地与云端工具允许检索的模块；单模块可只保留其中一项，新会话会装配对应 Skill |
| `cloudUserId` | 空 | 匿名会话的稳定用户标识 |
| `cloudTimeoutMs` | `90000` | 云端请求超时（1000–600000） |
| `cloudMaxResponseBytes` | 32 MiB | 云端响应上限（1 KiB–64 MiB） |
| `downloadSiteBaseUrl` | `https://prts.chat` | 仅作为校验哈希后的字节回退站点；不参与选版或签发摘要 |
| `downloadOrder` | `["modelscope","site"]` | 下载源顺序 |
| `cacheShards` | `24` | 正文分片 LRU 缓存大小（1–128） |

若在 preset 的 `prts-corpus.config.enabledGames` 设置基础范围，也应把相同数组传给相邻的 `prts-terrarchive/skill` entry；安装器生成和迁移的官方 PRTS preset 已自动保持两者一致。用户配置文件中的 `enabledGames` 会同时覆盖两边，修改后请新建会话以装配新的模块说明。

**内存说明**：新版资料包附带轻量 `document_catalog`，启动只从目录建立篇章定位、
标题、别名和检索元数据；正文分片在读取或命中后才解压，并由 `cacheShards` 限制缓存
数量。旧资料包仍兼容，但首次初始化需要扫描其正文分片。Node/V8 可能保留已申请的
堆页，因此操作系统看到的常驻内存不会在查询结束后立即回落。

## 皮肤

设置 → 插件 → PRTS 语料中选择：

- **Harness 默认**：不改动宿主外观；
- **PRTS Agent**：PRTS 终端风格界面；
- **Endfield AIC**：明日方舟：终末地终端风格，含 3D 地图。所需运行代码、模型与贴图已预压缩并随插件包安装，切换皮肤不会触发额外下载。

Endfield AIC 的插件代码、UI 集成与地图渲染实现采用 MIT License；其中使用的游戏衍生模型与贴图不属于 MIT 授权范围，仅作为该可选皮肤的组成部分随包提供。具体文件范围见 [GAME_ASSETS.md](GAME_ASSETS.md)。这与「版本管理」下载的语料相互独立：语料按需从 ModelScope 下载，皮肤资源无需另行下载。

## 开发

```bash
npm run check        # 全部源码语法检查
npm test             # node --test 全量测试；语料集成用例需本地 data/releases，否则自动跳过
git diff --check     # 检查待提交文本
```

真实网络下载脚本 `test/real-download.mjs` 不在默认测试集中，避免单元测试意外
下载大型资料。

**目录结构**：

```text
src/
  index.js               插件入口：工具注册、配置装配、云端热重载
  search.js              corpus_search 执行层（候选预筛、扫描、签名游标分页）
  search-projection.js   搜索结果的模型可见投影与渲染
  read.js                corpus_read 执行层（单篇/活动/终末地任务连续阅读）
  timeline.js            timeline_search 执行层（别名裂变、年份交集、出处反查）
  store.js               资料包只读访问层（1/2/3-gram 倒排、旧包短词回退、分片 LRU）
  wiki.js                Wiki 文档角色与标签字段解析
  entity-recognizer.js   实体别名 Aho-Corasick 自动机
  evidence-state.js      会话级证据状态（读取覆盖去重、上下文可见性判定）
  cloud.js               云端客户端（匿名 PoW 会话、静态 token、限流）
  cloud-projection.js    云端结果的模型可见投影
  source-map.js          云端证据 → 本地篇章映射
  installer.js           资料下载器（双源回退、SHA-256 校验、跨进程锁）
  state.js               三层配置与共享状态
  ui.js                  设置页 API（Connection RPC）与静态资源
  skill.js               prts-retrieval 技能注册
lib/
  client.js              Web 客户端入口（皮肤生命周期、设置 UI 席位）
  skins/common.css       插件公共控件样式（始终加载）
  skins/prts-agent.css   PRTS Agent 独立皮肤（仅启用时加载）
  skins/endfield-aic.css Endfield AIC 独立皮肤（仅启用时加载）
  endfield-map/          终末地皮肤地图资源（brotli/gzip 预压缩）
bin/
  install.js             一键安装器
  pack-map-assets.mjs    地图资源压缩打包脚本
contracts/               工具请求/响应 JSON Schema
skills/prts-retrieval/   检索策略技能（字段语义、检索配方）
```

## 兼容性

已对照 DSH `0.1.2-alpha.1` 与 `0.1.2-alpha.2`（web profile）真机验证；其中
`alpha.1` 通过官方 tag 构建并完成安装、预设解析、宿主启动、设置路由和客户端 bundle
加载检查。插件依赖宿主内部
接口（`ctx.tools`、`agent/pre-step`、Host Connection RPC、webServer 路由、agent 预设、
客户端 slots/theme）；DSH 大版本升级后请按「安装 → 重启 → 设置页 → PRTS 模式 →
语料工具 → 网页工具 → 皮肤 → 版本热切换」过一遍冒烟。

## 许可证与第三方内容

本项目按以下边界提供和授权内容：

- **原创代码与文档**：采用 [MIT License](LICENSE)。
- **游戏相关内容**：《明日方舟》《明日方舟：终末地》相关名称、商标、图像、模型、贴图、游戏数据及其他游戏素材不属于 MIT 授权范围，其权利归各自权利人所有。终末地皮肤所携带资源的具体范围见 [GAME_ASSETS.md](GAME_ASSETS.md)。
- **语料数据**：完整语料不随 Git 仓库或插件代码分发；用户通过插件从 ModelScope 下载的资料适用对应数据集页面标明的许可证、来源声明和使用条款，不因本项目采用 MIT License 而改变。

本项目为非官方社区项目，与相关游戏的开发商、发行商及其关联方不存在隶属、赞助或背书关系。完整声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
