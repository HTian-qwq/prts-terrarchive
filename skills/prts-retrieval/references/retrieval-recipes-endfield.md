# 终末地检索配方

以下流程只在终末地模块启用时使用，并始终带 `games:["endfield"]`。

## 任务或剧情过程

1. 已知任务名且要连续阅读时，直接用 `corpus_read({collection_name:任务名, mode:"collection"})`；同名歧义时用 `collection_names` 配合 `resource_types:["original_story"]` 搜索具体篇章，再以返回的 `document_uid + mode:"collection"` 选定合集。要定位某个片段时也先按该集合搜索；只知道大概情节时先用默认 `cloud_search`。
2. 用 `content_types` 区分对话、过场、广播、远程通讯、环境对话或 SNS，避免不同表现形式的同词混在一起。
3. 对行动、指代、态度和因果，用命中标题与行号读取连续上下文。

## 台词、广播或通讯

1. 确切短句：搜索 `original_story`，并在已知表现形式时增加对应 `content_types`。
2. 查询某人亲口表达时使用 `speakers`；只要求出现某实体时使用 `entity_names`。
3. 只记得一句话大意时使用 `single_sentence_search`，再回读原文。

## 人物综合资料

1. 用 `entity_profile` 或默认云端检索建立人物和关联资料入口。
2. 身份、经历或机构记录优先查 `archive`；角色叙事查 `character_story`；实际剧情表现查 `original_story`。
3. 若 `knowledge/wiki` 提供概括，只按其资料等级表述；具体行动和原话回到 `original_story`。

## 设定、地点或组织

1. 正式名称明确时先查 `archive/knowledge/entity_profile`。
2. 涉及多个实体关系或事件过程时用默认 `cloud_search` 建立候选，再用本地正式资料确认定义。
3. 若结论来自剧情中的展示而不是档案定义，补读 `original_story` 上下文并区分两者。

## 时间与事件顺序

1. 使用 `corpus_search({games:["endfield"], resource_types:["timeline"], query:事件或实体})`；可配合 `collection_names`。
2. 时间线只支持整理性顺序；具体事件发生方式仍查 `original_story`。
3. 不调用明日方舟专用的 `timeline_search` 来推断终末地没有相关事件。

## 查找某类资料目录

省略 `query`，用一个或少量 `resource_types` 加 `character_names/collection_names` 列出入口。正式标题命中优先打开对应档案，不被普通剧情中的同词提及带走。
