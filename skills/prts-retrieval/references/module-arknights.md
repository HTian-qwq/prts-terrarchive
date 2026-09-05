# 当前模块：明日方舟

调用本地或云端检索时使用 `games:["arknights"]`，除非运行时上下文表明问题还涉及终末地。

明日方舟本地资料类型：

- 原文：`story`；干员密录原文可用 `operator_record`。
- 官方角色资料：`character_profile`、`character_module`、`character_voice`、`character_skin`；不确定落在哪类时用 `character_bundle`。
- 整理资料：`character_wiki`、`story_wiki`、`character_activity_wiki`；确需跨 Wiki 搜索才用 `reviewed_wiki`。
- 设定与导航：`terra_journey`、`entity_profile`、`reference`。

`character_names` 是资料归属，`speakers` 是亲口说话，`entity_names` 是正文或结构化关系中出现；不同字段取交集。活动使用 `activity_names`，篇章使用 `story_names`，上级集合也可使用 `collection_names`。

常见路线：

- 用户给出关卡代号：直接以 `stage_code` 调用 `corpus_read`；工具提示存在多篇时再加 `story_part`。纯剧情/幕间使用 `story`。
- 用户给出干员与密录名：直接用 `character_name + record_name`；多段密录加 `segment`。
- 用户要求连续阅读整个活动原文：用 `activity_name + mode:"activity"`；同名多合集报歧义时先搜索具体篇章，再用其 `document_uid + mode:"activity"` 选定合集，不合并猜测。
- 用户明确要某角色的档案、模组、语音、时装、招聘合同或信物：用 `character_name + material` 直读。
- 角色—活动关系省略 `query`：角色→活动用 `corpus_search({games:["arknights"], resource_types:["character_activity_wiki"], character_names:[角色]})`；活动→角色用 `corpus_search({games:["arknights"], resource_types:["character_activity_wiki"], activity_names:[活动]})`；确认一对关系用 `corpus_search({games:["arknights"], resource_types:["character_activity_wiki"], character_names:[角色], activity_names:[活动]})`。完整清单或确认零命中时保持原条件翻页到 `page.exhausted=true`；零命中只表示当前资料版本没有这条整理记录。
- 角色在活动中的作用：`story_wiki + activity_names + wiki_sections:["角色剧情概括"]`，再按需要查 `character_activity_wiki` 或官方原文。
- 亲口台词：`story/operator_record + speakers`，不要以 `entity_names` 代替说话人。
- 事件年代与顺序：优先 `timeline_search`；时间线是整理性证据，精确剧情仍回原文。
