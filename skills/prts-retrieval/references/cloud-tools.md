# 云端工具补充

## `cloud_search`

默认路线适合情节、关系、动机和综合研究。`query` 应是主体、事件和所求关系完整的自然语言问题；准确原句、标题和行号优先本地字面检索。

模型当前只能选择默认主站路线，或在只记得一句官方剧情原文大意时设置 `options.search_intent="single_sentence_search"`。不要使用服务端内部的 channels、filters、预算、阈值，也不要发送 `quote_search` 或 `scene_search`。

`evidence_policy="mixed"` 使用主站混合检索；`original_only` 只运行官方剧情原文向量路线。两者都不改变“最终结论应按来源层级表述”的要求。结果中的可读取标题与行号可直接交给 `corpus_read`。

综合分析、人物经历、关系类问题不要设置 `options.search_intent` 或 `original_only`：它们会关闭档案、Wiki、图谱和年表。云端返回“没有可用材料”时，先去掉这两个字段用默认路线重试一次，仍无结果就改用 `corpus_search`；不要以相同参数反复调用。主站在 `single_sentence_search` 无材料时会自动改用默认路线重试一次，并在“警告”中注明；显式 `original_only` 不会被放宽。

## `cloud_inspect`

只在截断、来源不清或召回异常时检查。优先查看 `selected_sources`、`answer_context`、`candidates`；`events` 和 `trace_steps` 用于诊断。通常由运行时关联最近请求，分页时原样复制整数 `next_cursor`。不需要的过滤字段直接省略；`event_sequence_*` 从 1 开始，`event_time_*` 必须是带时区的 ISO 8601（如 `2025-01-01T08:00:00+08:00`）。
