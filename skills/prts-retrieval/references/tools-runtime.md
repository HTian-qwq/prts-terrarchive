# 当前工具契约

## `corpus_search`

它是本地结构化字面检索，不接收完整研究问题。可用参数为 `query`、`games`、`resource_types`、`content_types`、`collection_names`、`character_names`、`story_names`、`activity_names`、`wiki_sections`、`entity_names`、`speakers`、`match_mode`、`context_terms`、`after`。

同一数组内 OR，不同过滤字段间 AND。`query` 默认连续字面匹配；只有确需模式时才用受限 `regex`。省略 `query` 可按归属列目录；省略 `query` 且指定一个 Wiki 字段可返回完整字段。已有证据足以回答时停止；只有需要完整清单、确认零命中或当前页证据不足时才继续分页。续页保留原条件并把 `page.next_after` 原样放进 `after`；要证明搜索范围已穷尽则继续到 `page.exhausted=true`。`next_after` 含完整 `data_version`；资料版本切换后旧锚点会被拒绝，须从首屏重新搜索。

## `corpus_read`

- 明日方舟单篇关卡：`{stage_code:"TW-ST-1"}`；同代号存在多篇时加 `story_part:"before"|"after"|"story"`。提供 `line` 时读上下文，否则直接读全文首段。
- 干员密录：`{character_name:"安洁莉娜", record_name:"没写收件人的包裹", segment:2}`；只有一段时可省略 `segment`。
- 角色资料：`{character_name:"凯尔希", material:"profile"}`；`material` 支持 `profile/module/voice/skin/recruitment/potential`，双模块同名时加 `game`。
- 明日方舟活动连续阅读：`{activity_name:"孤星", mode:"activity"}`。
- 终末地任务连续阅读：`{collection_name:"武陵特厨", mode:"collection"}`；可加 `content_types`。
- 其他资料定点上下文：`{title, line, before?, after?}`。
- Wiki 字段：`{title, section}`。
- 其他资料全文首段：`{title, mode:"document", max_lines?, max_chars?}`。
- 搜索结果给出 `document_uid` 时表示标题同名：用它替代 `title`，两者不得同时提交；单篇用 `{document_uid, line}` 或 `{document_uid, mode:"document"}`。
- 所有续读：原样提交结果的 `page.continuation`。单篇使用 `line`，活动/任务合集使用版本绑定的 `position`；可以另加 `max_lines/max_chars`。

每次只选一种主定位方式：`title`、`document_uid`、`stage_code`（可带 `story_part`）、角色密录组合、角色资料组合、`activity_name` 或 `collection_name`。`max_lines/max_chars` 只限制输出量，不会选择读取方式；裸 `title` 不能只配这两个限制字段。

稳定定位字段已经足够时直接读取，不要先搜索标题。合集结果的每行都带所属篇章标题和篇内行号，应按它们引用。工具返回歧义时收窄条件，不能猜第一篇。新调用不要创建 cursor；旧会话已有 cursor 时才使用兼容入口。

## `timeline_search`

可用 `query`、`activity_names`、`entity_names`、`year_start`、`year_end`、`source_marker`、`max_results`。`entity_names` 会展开别名；不同维度取交集。`source_marker` 仅用于反查来源，不写入回答。

## `cloud_search`

模型可见参数只有 `query`、`games`、兼容字段 `depth`、`evidence_policy`，以及可选的 `options.search_intent="single_sentence_search"`。不要发送 channels、filters、阈值、候选预算、`quote_search` 或 `scene_search`。

默认省略 `depth/options` 并使用 `evidence_policy="mixed"`。只有一句官方剧情原文的大意且措辞可能不准时使用 `single_sentence_search`；`original_only` 会切到仅官方剧情原文的向量路线。结果末尾的可读取标题与行号可直接交给 `corpus_read`。

## `cloud_inspect`

仅在云端结果截断、来源不清或诊断召回时使用。通常省略 `request_id`，运行时会关联最近一次云端请求；按返回的整数 `next_cursor` 分页。优先查看 `selected_sources` 或 `answer_context`，诊断时再看 `candidates/events/trace_steps`。
