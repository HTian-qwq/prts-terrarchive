# 当前工具契约

## `corpus_navigate`

终末地主线导航（明日方舟的时间位置用 `timeline_search`）。参数只有可选 `query` 和 `game:"endfield"`；省略 query 返回有序目录，不需要先知道任务名。支持“最新主线”“1.6 主线”“丹青渡”“第二章第八进程”及准确任务名。返回章/进程顺序、所属任务、前后主线，以及可直接提交给 `corpus_read` 的参数；任务元数据只展示 id/名称/类型等判别字段，来源 URL 与源文件路径保留在结构化结果中。版本映射与顺序带来源；最新仅表示当前安装资料覆盖的最新。缺少版本映射或本地正文时保留缺口提示。章/进程/任务顺序不代表任务内部所有原文碎片的严格时间顺序。目录不能充当台词证据，具体剧情仍读正文。

## `corpus_search`

它是本地结构化字面检索，不接收完整研究问题。可用参数为 `query`、`games`、`resource_types`、`content_types`、`collection_names`、`character_names`、`story_names`、`activity_names`、`wiki_sections`、`entity_names`、`speakers`、`match_mode`、`context_terms`、`after`。

同一数组内 OR，不同过滤字段间 AND。`query` 默认连续字面匹配；只有确需模式时才用受限 `regex`。省略 `query` 可按归属列目录；省略 `query` 且指定一个 Wiki 字段可返回完整字段。已有证据足以回答时停止；只有需要完整清单、确认零命中或当前页证据不足时才继续分页。续页保留原条件并把 `page.next_after` 原样放进 `after`；要证明搜索范围已穷尽则继续到 `page.exhausted=true`。`next_after` 带短版本号 `data_version`（前 12 位；至少 8 位前缀即可）；资料版本切换后旧锚点会被拒绝，须从首屏重新搜索。

`speakers` 匹配亲口台词，会自动展开已登记别名（如 `银灰` 也匹配原文说话人 `恩希欧迪斯`）。`query` 只匹配台词正文，不含说话人名；从命中复制的 `说话人: 台词` 形式也能直接搜。命中行显示原文标点，命中片段以 `⟦⟧` 标出，引用时去掉 `⟦⟧`。目录型结果每篇附可直接执行的 `corpus_read` 调用。

## `corpus_read`

- 明日方舟单篇关卡：`{stage_code:"TW-ST-1"}`；同代号存在多篇且未给 `story_part` 时默认读行动前（无行动前则读幕间），结果开头说明其他篇的 `story_part`。提供 `line` 时读上下文，否则直接读全文首段。
- 干员密录：`{character_name:"安洁莉娜", record_name:"没写收件人的包裹", segment:2}`；只有一段时可省略 `segment`。
- 角色资料：`{character_name:"凯尔希", material:"profile"}`；`material` 支持 `profile/module/voice/skin/recruitment/potential`，双模块同名时加 `game`。
- 明日方舟活动连续阅读：`{activity_name:"孤星", mode:"activity"}`。
- 终末地任务连续阅读：`{collection_name:"武陵特厨", mode:"collection"}`；可加 `content_types`。两款游戏的连续阅读是同一入口：`activity_name` 填了终末地任务名、或 `collection_name` 填了明日方舟活动名时，工具会自动改道并说明。
- 其他资料定点上下文：`{title, line, before?, after?}`。
- Wiki 字段：`{title, section}` 或 `{document_uid, section}`；只读字段时省略 `mode`。
- 其他资料全文首段：`{title}`（可加 `max_lines/max_chars`；`mode:"document"` 可省略）。
- 标题不必一字不差：分隔符 `·`、空格、全半角差异和 Wiki 的“ · 第 N 篇”后缀可省略；唯一匹配时直接读取并在开头说明实际标题，多个候选或找不到时错误信息列出最接近的完整标题。
- 搜索结果给出 `document_uid` 时表示标题同名：复制其 `doc_…` 值替代 `title`，不能把展示标题填入 `document_uid`，两者不得同时提交；单篇用 `{document_uid, line}` 或 `{document_uid, mode:"document"}`。
- 所有续读：直接复制结果末尾给出的 `corpus_read(...)` 调用。单篇使用 `line`，活动/任务合集使用 `position`；`data_version` 为短版本号且可省略（省略时按当前版本读取），可以另加 `max_lines/max_chars`。
- 角色资料中导出脚本写入的溯源行（数据表路径、记录 ID、解锁条件枚举）默认隐藏，行号保持原样；Wiki 的 `<字段>` 标签显示为 `字段：值` 或 `［字段］`。

每次只选一种主定位方式：`title`、`document_uid`、`stage_code`（可带 `story_part`）、角色密录组合、角色资料组合、`activity_name` 或 `collection_name`。`max_lines/max_chars` 只限制输出量，不会选择读取方式；裸 `title` 默认读取全文首段。

直接复制导航/搜索返回的最小读取参数，不要填齐其他用途的字段。可选枚举允许空字符串，等同省略。`story_part` 依附 `stage_code`，`segment` 依附 `record_name`，`material` 依附 `character_name`；已明确唯一目标时，兼容清理已知孤立默认值并在结果中说明，真实的双重定位仍报错并列出最小重试参数。显式 `mode:"document"` 表示读取全文；误带的合法 `section` 不应用，并在结果提示。只读 Wiki 字段时保留 `section`，省略 `mode`。非默认的孤立修饰参数、非零的无效分页位置及过期版本仍严格校验。

稳定定位字段已经足够时直接读取，不要先搜索标题。合集结果的每行都带所属篇章标题和篇内行号，应按它们引用。工具返回歧义时收窄条件，不能猜第一篇。新调用不要创建 cursor；旧会话已有 cursor 时才使用兼容入口。

## `corpus_i18n`

查询终末地官方本地化文本，不生成翻译。主定位四选一：`query`、`title`、`document_uid`、`text_ids`；必须指定 `languages`（1–4 种）。有原文定位时优先 `{title, line, languages:["EN","JP"]}` 或 `{document_uid, line, languages:["EN"]}`；仅有名称/原句时用 `{query, languages:["EN"]}`。`source_language` 默认 `CN`，外语反查可用 `EN/JP/KR` 或 `en/ja/ko`。`query` 默认精确匹配，短片段加 `match_mode:"literal"`。

默认无需请求底层 ID。需要核验时才设 `include_ids:true`，返回的 `text_id` 必须当作字符串使用，后续可传 `text_ids`。同文不同译保留候选，按 references 中的篇章和中文定位消歧，不能任选第一个。每个结果最多列出 8 个引用；`reference_count` 表示总数。

`alignment:"record"` 是整条角色档案，`alignment:"document"` 是档案库内容块；不保证各语言段落一一对应。引用注明工具返回的篇章、语言和中文定位，不能把中文第 N 行说成英文第 N 行。长文本按字符分块，`character_start/end` 是该语言自己的位置，不表示译文逐字符对应；续页直接复制结果末尾的 `corpus_i18n(...)` 调用（`after` 只需 `position/text_offset`，短 `data_version/request_hash` 用于校验，可省略）。

结果以文本展示。按名称查询时，原文与所有请求语言译文完全相同的条目合并为一组，出处汇总为“共 N 处，示例”；只有译文确有不同才分成多组。

`missing_localization`（显示为“该语言无对应译文”）表示该语言官方文本为空；`unmapped_source` 表示没有建立来源映射；`unavailable` 表示附件/语言未安装。均不能自行翻译后当成官方文本。旧资料包仍能正常搜索和阅读，但需要安装带本地化附件的版本才能使用此工具。

## `timeline_search`

可用 `query`、`activity_names`、`entity_names`、`year_start`、`year_end`、`source_marker`、`max_results`。`entity_names` 会展开别名；不同维度取交集。`source_marker` 仅用于反查来源，不写入回答。

## `cloud_search`

模型可见参数只有 `query`、`games`、兼容字段 `depth`、`evidence_policy`，以及可选的 `options.search_intent="single_sentence_search"`。不要发送 channels、filters、阈值、候选预算、`quote_search` 或 `scene_search`。

默认省略 `depth/options` 并使用 `evidence_policy="mixed"`。只有一句官方剧情原文的大意且措辞可能不准时使用 `single_sentence_search`；`original_only` 会切到仅官方剧情原文的向量路线。结果末尾的可读取标题与行号可直接交给 `corpus_read`。

## `cloud_inspect`

仅在云端结果截断、来源不清或诊断召回时使用。通常省略 `request_id`，运行时会关联最近一次云端请求；按返回的整数 `next_cursor` 分页。优先查看 `selected_sources` 或 `answer_context`，诊断时再看 `candidates/events/trace_steps`。
