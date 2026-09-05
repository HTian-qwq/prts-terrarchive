# 当前模块：明日方舟：终末地

调用本地或云端检索时使用 `games:["endfield"]`，除非运行时上下文表明问题还涉及明日方舟。

终末地采用跨游戏统一类型，不要套用明日方舟干员资料类型：

- `original_story`：官方剧情原文；可用 `content_types` 区分 `dialogue`、`cutscene`、`radio`、`remote_comm`、`black_screen`、`environment_talk`、`sns_topic`、`sns_chat`、`narration`。
- `archive`：官方档案类资料。
- `knowledge`：知识与设定资料。
- `wiki`：整理性 Wiki。
- `character_story`：角色故事资料。
- `timeline`：时间线类资料；通过 `corpus_search` 检索，不能假定 `timeline_search` 覆盖终末地。
- `entity_profile`：实体概述和检索入口。

终末地任务或资料集合优先使用 `collection_names`；角色归属仍使用 `character_names`，亲口台词使用 `speakers`，实体出现使用 `entity_names`。只记得场景内容时，先用 `cloud_search`；已有短原句或名称时，用 `corpus_search` 的 `original_story` 与合适的 `content_types`。

用户已经给出任务或剧情集合的完整展示名，并要连续阅读原文时，直接使用 `corpus_read({collection_name, mode:"collection"})`。终末地碎片没有可证明的全局时间线时，工具只按内容类型分组、组内自然编号排列，并在 `ordering_note` 明示；不得把它描述成游戏内剧情先后。只要某类表现形式时加 `content_types`。同名对应多个集合时，先用 `corpus_search({collection_names:[...]})` 找到具体篇章，再把其 `document_uid` 与 `mode:"collection"` 交给 `corpus_read`；`content_types` 不是可靠的合集消歧器。

引用台词、说话人、具体动作或场景因果前，读取 `original_story` 的标题和行号上下文。`archive` 属于官方结构化资料，`knowledge/wiki/timeline/entity_profile` 的结论应按各自整理粒度表述。
