/**
 * prts-terrarchive：PRTS.chat 明日方舟检索五工具的 deepseek-harness 插件。
 *
 * 零 npm 依赖：不经 defineTool（避免与宿主 dsh-tools 版本漂移），直接向
 * ctx.tools 注册原始 ToolDefinition。模型使用扁平参数（title 或关卡代号 + 行动前后
 * corpus_read、anyOf 拆为 execute 内跨字段校验），执行层再落实版本化契约。
 *
 * 工具集（与浏览器 agent/browser 五工具对齐）：
 *   corpus_search   grep 风格本地语料搜索/目录（literal/受限 regex）
 *   corpus_read     按关卡代号 + 行动前后或完整标题直读原文（不自动夹带伴随资料）
 *   timeline_search 活动时间线检索（别名裂变 / 年份交集 / 出处标记反查）
 *   cloud_search    云端组合语义检索（需 cloud.baseUrl 配置）
 *   cloud_inspect   云端检索状态复查（request_id 由运行时注入）
 *
 * 加载方式（任选其一）：
 *   1) bundle：dsh plugin --profile <name> add /path/to/agent-dsh
 *   2) overlay：dsh web --patch ./agent-dsh/cordis.patch.yml（需可被 Node 解析）
 *
 * 配置（cordis.patch.yml 行内 config）：
 *   releasesDir      资料包 releases 目录（默认 $DSH_HOME/prts-corpus/releases）
 *   cacheShards      分片 LRU 缓存大小（默认 24）
 *   download         { order, siteBaseUrl } 设置页字节源；可信元数据固定来自 PRTS.chat
 *   cloud            { baseUrl, game, userId, token, timeoutMs }；game 默认 all（双游戏）
 */

import { isAbsolute, join, parse, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { watch } from 'node:fs'
import { mkdir, realpath } from 'node:fs/promises'
import { CorpusStore, documentGame, documentUid, naturalDocumentTitle, publicStoryStageCode,
  publicStoryPart } from './store.js'
import { readCurrentReleasePointer } from './installer.js'
import { END_FIELD_STORY_CONTENT_TYPES, executeRead, readContractFromCursor,
  projectReadPublic, renderRead } from './read.js'
import { executeSearch, renderSearch } from './search.js'
import { executeTimelineSearch, renderTimeline } from './timeline.js'
import { AnonymousSessionProvider, CloudRetrievalClient, StaticTokenProvider,
  createAgentCloudClientRegistry,
  cloudErrorResponse, readOrCreateClientId } from './cloud.js'
import { createSharedState } from './state.js'
import { applyUi } from './ui.js'
import { attachLocalSourceMappings } from './source-map.js'
import { projectCloudInspect, projectCloudSearch } from './cloud-projection.js'
import { combinePartialReadResponses, coveredRead, createEvidenceStateRegistry,
  planReadCoverage, rememberCloudMappings, rememberRead,
  rememberSearchCandidates, replayCoveredRead, resolveReadWindow,
  visibleToolResults } from './evidence-state.js'
import { applyEntityRecognition, prepareEntityRecognition } from './entity-recognizer.js'
import { attachRetravelerRelations } from './entity-routing.js'
import { WIKI_SECTION_VALUES } from './wiki.js'

/** Cordis 插件名（Loader 诊断用，与 Node 包名 prts-terrarchive 相互独立）。 */
export const name = 'prts-corpus'

/** 同一 Host 进程中，host 常驻实例与会话 preset 共用一份大型索引。 */
const storesByDirectory = new Map()

const LOCAL_CORPUS_MISSING_MESSAGE =
  '本地数据包暂未安装，请提醒用户前往“设置 → 插件 → PRTS 语料”安装。'
const DATA_VERSION_PATTERN = /^[0-9a-f]{64}$/

function sameFilesystemPath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase() : left === right
}

function filesystemAncestorOrSame(parent, child) {
  const normalizedParent = process.platform === 'win32' ? parent.toLowerCase() : parent
  const normalizedChild = process.platform === 'win32' ? child.toLowerCase() : child
  return normalizedChild === normalizedParent
    || normalizedChild.startsWith(`${normalizedParent.replace(/[\\/]$/u, '')}${process.platform === 'win32' ? '\\' : '/'}`)
}

async function resolveSafeReleasesDirectory(path, dshHome) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const actual = await realpath(path)
  const forbidden = []
  for (const entry of [parse(actual).root, homedir(), dshHome, process.cwd(), tmpdir()]) {
    const resolved = resolve(entry)
    forbidden.push(await realpath(resolved).catch(() => resolved))
  }
  // 不仅拒绝这些目录本身，也拒绝它们的祖先（例如 /home）：否则一个合法
  // releaseId 仍可能把宿主家目录变成 UI 递归删除的候选目标。
  if (forbidden.some((entry) => sameFilesystemPath(actual, entry)
      || filesystemAncestorOrSame(actual, entry))) {
    throw Object.assign(new Error(`releasesDir 不能指向宽目录：${actual}`), {
      code: 'INVALID_CONFIG',
    })
  }
  return actual
}

/** Convert local release/index failures into one actionable model-facing error. */
async function requireLocalCorpus(store) {
  try {
    await store.ready()
  } catch (error) {
    throw Object.assign(new Error(LOCAL_CORPUS_MISSING_MESSAGE), {
      code: 'CORPUS_NOT_INSTALLED', retryable: false, cause: error,
    })
  }
}

const READ_DESCRIPTION = [
  '读取 PRTS.chat 本地资料。明日方舟关卡用 stage_code，只有多篇时才填 story_part；干员密录用 character_name + record_name + segment；角色资料用 character_name + material。',
  '整个明日方舟活动用 activity_name + mode=activity，终末地任务用 collection_name + mode=collection；合集续页原样提交 page.continuation 的 position。其他资料使用完整 title。',
  '搜索结果若给出 document_uid，说明标题或合集同名：它替代 title，读取时只提交 document_uid，不得同时提交 title；单篇可配 line 或 mode=document，所属合集可配 mode=activity/collection。',
  'line 扩大单篇原文上下文，section 读取 Wiki 字段，mode=document 分页全文。所有续页都原样提交 page.continuation；旧会话里的 cursor 仅用于兼容。',
  '引用原文使用“《篇章名》第 N 行”；同名结果保留工具给出的 document_uid 作为唯一定位器。不要使用内部代号、路径或自造篇章名。',
].join(' ')

const SEARCH_DESCRIPTION = [
  '像 grep 一样搜索 PRTS.chat 本地语料；命中立即返回原行及上下各一行，并按文档归并。',
  'query 使用短实体名、篇章展示名或原句片段；也可省略 query，仅按过滤条件列出资料入口。',
  '角色个人页用 character_wiki；活动/密录整理页用 story_wiki；角色在单个活动中的辅助整理用 character_activity_wiki。wiki_sections 可精确限定相关活动、相关角色、剧情总结、角色剧情概括等标签字段。',
  'literal 是默认连续字面匹配；只有特殊模式才使用受限 regex。下一页保留原搜索条件，并把返回的 next_after 原样放入 after；锚点由完整资料版本、资料类型与自然标题组成，不再暴露内部 cursor。',
].join(' ')

const TIMELINE_DESCRIPTION = [
  '按活动名、年份及自动展开的实体别名检索活动时间线（PRTS Wiki《泰拉年表》本地投影）。',
  '人物放 entity_names 以自动裂变别名；结果只给时间、事件正文和“年表出处”标记，把标记原样传回 source_marker 可反查完整来源。',
].join(' ')

const CLOUD_SEARCH_DESCRIPTION = [
  '用一次自然语言请求同时查询 PRTS.chat 云端的明日方舟与终末地图谱、档案、原文、自建 Wiki 和时间线组合索引；只有用户明确限定游戏时才使用 games 收窄。',
  '返回末尾的「## 可读取原文」列出已映射到本地篇章的完整自然语言标题与行号；有同名消歧标记时按 document_uid + line 调用，否则按 title + line。',
].join(' ')

const CLOUD_INSPECT_DESCRIPTION = [
  '按 section 和过滤条件读取最近一次云端检索状态（request_id 由运行时自动注入）。',
  '用于定点读取回答材料、候选状态或诊断记录，并支持按 next_cursor 分页。',
].join(' ')

/** ---- 模型可见参数（DSH ctx.tools 的 JSON Schema 子集：无 anyOf/$defs/pattern/数值边界） ---- */

const RESOURCE_TYPES = ['story', 'character_profile', 'character_module', 'character_voice',
  'character_skin', 'operator_record', 'character_bundle', 'character_wiki', 'story_wiki',
  'character_activity_wiki', 'reviewed_wiki',
  'terra_journey', 'entity_profile', 'reference',
  'original_story', 'archive', 'knowledge', 'wiki', 'character_story', 'timeline']

const CONTENT_TYPES = ['dialogue', 'cutscene', 'radio', 'remote_comm', 'black_screen',
  'environment_talk', 'sns_topic', 'sns_chat', 'narration', 'archive', 'knowledge']

const stringList = (description) => ({ type: 'array', items: { type: 'string' }, description })

const SEARCH_PARAMETERS = {
  type: 'object', additionalProperties: false,
  properties: {
    query: { type: 'string', description: '短搜索词：实体名、篇章展示名、活动名或原句片段；不要直接提交整句研究问题' },
    resource_types: { type: 'array', items: { type: 'string', enum: RESOURCE_TYPES },
      description: '资料类型；character_bundle 可一次查看角色档案、模组、语音和密录' },
    games: { type: 'array', items: { type: 'string', enum: ['arknights', 'endfield'] },
      description: '可选游戏过滤；省略时在同一次调用中同时检索明日方舟与终末地' },
    content_types: { type: 'array', items: { type: 'string', enum: CONTENT_TYPES },
      description: '统一内容形式，例如 dialogue、cutscene、radio、sns_chat；两款游戏使用相同参数' },
    collection_names: stringList('上级资料集合展示名；明日方舟活动与终末地任务都使用此字段'),
    character_names: stringList('角色展示名，如“凯尔希”'),
    story_names: stringList('剧情篇章的展示名，如“晶簇之内”；不要填写内部 story_id 或路径'),
    activity_names: stringList('活动展示名'),
    wiki_sections: { type: 'array', items: { type: 'string', enum: WIKI_SECTION_VALUES },
      description: 'Wiki 标签字段，可与资料类型、角色、活动和 query 组合；角色页常用相关活动/相关角色/剧情高光，活动页常用剧情总结/关键人物/角色剧情概括' },
    entity_names: stringList('只返回出现指定实体的行'),
    speakers: stringList('结构化说话人展示名，只匹配亲口台词；适合查某人亲口说过什么'),
    match_mode: { type: 'string', enum: ['literal', 'regex'],
      description: '默认 literal 连续字面匹配；除非必须，不使用受限 regex' },
    context_terms: { type: 'array', items: { type: 'string' },
      description: '要求命中附近同时出现的语境词（最多 8 个）' },
    after: { type: 'object', additionalProperties: false,
      description: '版本绑定的下一页锚点；与原 query 和过滤条件一起原样提交上次返回的 next_after',
      required: ['data_version', 'resource_type', 'title', 'position'], properties: {
        data_version: { type: 'string',
          description: '上一页所用资料包的完整 SHA-256 版本；版本切换后必须重新搜索' },
        resource_type: { type: 'string', enum: RESOURCE_TYPES },
        title: { type: 'string', description: '上一页扫描到的资料自然标题' },
        position: { type: 'integer', description: '该标题在当前资料版本中的顺序位置（0..10000000）' },
      } },
  },
}

const SEARCH_OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['result_kind', 'documents', 'page', 'truncated', 'truncation_reasons'],
  properties: {
    result_kind: { type: 'string', enum: ['text_matches', 'structured_matches',
      'complete_sections', 'documents'] },
    documents: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['game', 'title', 'resource_type', 'content_type', 'matches', 'matches_truncated'],
      properties: {
        game: { type: 'string', enum: ['arknights', 'endfield'] },
        title: { type: 'string' }, document_uid: { type: 'string' }, resource_type: { type: 'string' },
        content_type: { type: 'string' }, collection_name: { type: 'string' },
        activity_name: { type: 'string' }, character_name: { type: 'string' },
        matches_truncated: { type: 'boolean' },
        matches: { type: 'array', items: { type: 'object', additionalProperties: false,
          required: ['match_kind', 'evidence_kind', 'excerpt', 'citation'],
          properties: {
            line_start: { type: 'integer' }, line_end: { type: 'integer' },
            match_kind: { type: 'string' }, evidence_kind: { type: 'string' },
            citation: { type: 'string' },
            excerpt: { type: 'array', items: { type: 'object', additionalProperties: false,
              required: ['line', 'role', 'line_type', 'speaker', 'text', 'truncated'],
              properties: { line: { type: 'integer' },
                role: { type: 'string', enum: ['match', 'context', 'constraint'] },
                line_type: { type: 'string' }, speaker: { type: 'string' },
                text: { type: 'string' }, truncated: { type: 'boolean' } } } },
          } } },
        section_content: { type: 'object', additionalProperties: false,
          required: ['section', 'completeness', 'blocks', 'citation'],
          properties: { section: { type: 'string' },
            completeness: { type: 'string', enum: ['complete', 'partial'] },
            blocks: { type: 'array', items: { type: 'object', additionalProperties: false,
              required: ['type', 'text'], properties: { type: { type: 'string', enum: ['text'] },
                text: { type: 'string' } } } }, citation: { type: 'string' } } },
        entity_summary: { type: 'object', additionalProperties: false,
          required: ['canonical_name', 'truncated', 'citation'],
          properties: { canonical_name: { type: 'string' }, description: { type: 'string' },
            history_summary: { type: 'string' }, truncated: { type: 'boolean' },
            citation: { type: 'string' } } },
      } } },
    page: { type: 'object', additionalProperties: false,
      required: ['returned_documents', 'total_relation', 'has_more', 'exhausted', 'next_after'],
      properties: { returned_documents: { type: 'integer' }, total_documents: { type: 'integer' },
        total_relation: { type: 'string', enum: ['eq', 'unknown'] },
        has_more: { type: 'boolean' },
        exhausted: { type: 'boolean' },
        next_after: { oneOf: [{ type: 'object', additionalProperties: false,
          required: ['data_version', 'resource_type', 'title', 'position'], properties: {
            data_version: { type: 'string' },
            resource_type: { type: 'string' }, title: { type: 'string' },
            position: { type: 'integer' },
          } }, { type: 'null' }] } } },
    truncated: { type: 'boolean' },
    truncation_reasons: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['code', 'game', 'message'], properties: {
        code: { type: 'string' }, game: { type: 'string', enum: ['arknights', 'endfield'] },
        message: { type: 'string' },
      } } },
    retraveler_relations: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['relation_kind', 'endfield_name', 'relation_status', 'not_alias'], properties: {
        relation_kind: { type: 'string', enum: ['endfield_retraveler_memory_prototype'] },
        endfield_name: { type: 'string' }, terra_memory_prototype: { type: 'string' },
        relation_status: { type: 'string' }, not_alias: { type: 'boolean' },
      } } },
  },
}

const READ_PARAMETERS = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '未使用其他定位器时，填写资料完整展示标题；不得与 document_uid 同时提交' },
    document_uid: { type: 'string',
      description: '仅在搜索结果提示同名歧义时原样复制 doc_ 开头的稳定定位；它替代 title，不得与 title 同时提交；可配合 mode=activity/collection 选择所属合集' },
    stage_code: { type: 'string', description: '明日方舟游戏内关卡代号，如 15-17、GT-3、TW-ST-1' },
    story_part: { type: 'string', enum: ['before', 'after', 'story'],
      description: '关卡存在多篇剧情时用于消歧：before=行动前，after=行动后，story=纯剧情/幕间；单篇关卡可省略' },
    character_name: { type: 'string', description: '角色展示名；与 record_name 或 material 配合' },
    record_name: { type: 'string', description: '明日方舟干员密录名称；多段密录再提供 segment' },
    segment: { type: 'integer', description: '干员密录段号，如 1、2' },
    material: { type: 'string', enum: ['profile', 'module', 'voice', 'skin', 'recruitment', 'potential'],
      description: '角色资料类别；profile=档案、module=模组、voice=语音、skin=时装' },
    game: { type: 'string', enum: ['arknights', 'endfield'],
      description: '角色资料在双模块同名时用于消歧；其他定位器不要填写' },
    activity_name: { type: 'string', description: '明日方舟活动展示名；按活动连续阅读全部剧情' },
    collection_name: { type: 'string', description: '终末地任务或剧情集合展示名；跨碎片连续阅读' },
    content_types: { type: 'array', items: { type: 'string', enum: END_FIELD_STORY_CONTENT_TYPES },
      description: '终末地集合可选内容形式过滤；续页时原样保留' },
    line: { type: 'integer', description: 'around 的中心官方行号；与 mode=document 同用时表示续读起始行' },
    position: { type: 'integer', description: '活动/任务连续阅读的下一位置；只从 page.continuation 原样复制' },
    mode: { type: 'string', enum: ['document', 'activity', 'collection'],
      description: '单篇全文用 document；活动用 activity；终末地任务集合用 collection。title 不会自动推断，必须配 line、section 或 mode=document；document_uid、关卡、密录和角色资料可自动推断单篇全文' },
    section: { type: 'string', enum: WIKI_SECTION_VALUES, description: '读取 Wiki 标签字段' },
    before: { type: 'integer', description: 'around 前文行数，默认 3，上限 100' },
    after: { type: 'integer', description: 'around 后文行数，默认 3，上限 100' },
    cursor: { type: 'string', description: '仅兼容旧会话中的不透明游标；新调用应原样提交上次结果的 page.continuation' },
    data_version: { type: 'string', description: '续页时原样提交 page.continuation.data_version，防止版本切换后混读' },
    max_lines: { type: 'integer', description: '最多返回行数，默认 100，上限 500；只限制输出量，不能代替 line、section 或 mode' },
    max_chars: { type: 'integer', description: '最多返回字符数，默认 12000，上限 100000；只限制输出量，不能代替 line、section 或 mode' },
  },
  additionalProperties: false,
}

const READ_OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['primary', 'page', 'presentation'],
  properties: {
    primary: { type: 'object', additionalProperties: false,
      required: ['game', 'title', 'kind', 'selection', 'lines', 'citation'],
      properties: { game: { type: 'string', enum: ['arknights', 'endfield'] },
        title: { type: 'string' }, stage_code: { type: 'string' },
        story_part: { type: 'string', enum: ['before', 'after', 'story'] },
        character_name: { type: 'string' }, record_name: { type: 'string' },
        segment: { type: 'integer' }, material: { type: 'string' }, kind: { type: 'string' },
        selection: { type: 'object', additionalProperties: false,
          required: ['mode', 'line_start', 'line_end', 'truncated'],
          properties: { mode: { type: 'string' }, line_start: { type: 'integer' },
            line_end: { type: 'integer' }, section: { type: 'string' },
            truncated: { type: 'boolean' } } },
        lines: { type: 'array', items: { type: 'object', additionalProperties: false,
          required: ['line', 'line_type', 'speaker', 'text'],
          properties: { line: { type: 'integer' }, source_line_id: { type: 'string' },
            line_type: { type: 'string' }, speaker: { type: 'string' }, speaker_id: { type: 'string' },
            text: { type: 'string' }, document_title: { type: 'string' },
            document_uid: { type: 'string' },
            stream_position: { type: 'integer' }, citation: { type: 'string' },
            audio: { type: 'string' }, hint: { type: 'string' } } } },
        text: { type: 'string' }, ordering: { type: 'string' }, ordering_note: { type: 'string' },
        citation: { type: 'string' } } },
    presentation: { type: 'object', additionalProperties: false,
      required: ['document_id', 'data_version'], properties: {
        document_id: { type: 'string' }, data_version: { type: 'string' },
        sources: { type: 'array', items: { type: 'object', additionalProperties: false,
          required: ['document_id', 'document_uid', 'title', 'line_start', 'line_end'], properties: {
            document_id: { type: 'string' }, document_uid: { type: 'string' },
            title: { type: 'string' }, line_start: { type: 'integer' }, line_end: { type: 'integer' },
          } } },
        sources_truncated: { type: 'boolean' },
      } },
    page: { type: 'object', required: ['returned_lines', 'has_more', 'continuation'],
      properties: { returned_lines: { type: 'integer' }, has_more: { type: 'boolean' },
        continuation: { oneOf: [{ type: 'object', additionalProperties: false,
          required: ['mode', 'data_version'], properties: {
            title: { type: 'string' }, document_uid: { type: 'string' }, stage_code: { type: 'string' },
            story_part: { type: 'string', enum: ['before', 'after', 'story'] },
            character_name: { type: 'string' }, record_name: { type: 'string' },
            segment: { type: 'integer' }, material: { type: 'string' },
            game: { type: 'string', enum: ['arknights', 'endfield'] },
            activity_name: { type: 'string' }, collection_name: { type: 'string' },
            content_types: { type: 'array', items: { type: 'string', enum: END_FIELD_STORY_CONTENT_TYPES } },
            mode: { type: 'string', enum: ['document', 'activity', 'collection'] },
            line: { type: 'integer' }, position: { type: 'integer' }, data_version: { type: 'string' },
          } }, { type: 'null' }] } } },
  },
}

/** 保留 UI 重放所需的稳定文档定位；renderRead 不把该字段送给模型。 */
function projectReadToolValue(response, store) {
  const projected = projectReadPublic(response)
  const continuation = projected.page?.continuation
  if (continuation?.mode === 'document') {
    if (!continuation.stage_code && !continuation.record_name && !continuation.material
        && store.requiresDocumentUid?.(response.document?.document_id)) {
      projected.page.continuation = {
        document_uid: documentUid(response.document.document_id), mode: 'document',
        line: continuation.line, data_version: continuation.data_version,
      }
    }
    const uniqueStage = continuation.stage_code && continuation.story_part
      && store.hasUniqueStoryStage(response.document?.document_id)
    const uniqueRecord = continuation.record_name
      && store.hasUniqueOperatorRecord(response.document?.document_id)
    const uniqueMaterial = continuation.material
      && store.hasUniqueCharacterMaterial(response.document?.document_id)
    if (!projected.page.continuation.document_uid
        && (continuation.stage_code || continuation.record_name || continuation.material)
        && !uniqueStage && !uniqueRecord && !uniqueMaterial) {
      projected.page.continuation = {
        title: projected.primary.title, mode: 'document', line: continuation.line,
        data_version: continuation.data_version,
      }
    }
  }
  const sources = new Map()
  for (const source of response.stream?.sources || []) {
    if (source?.document_id) sources.set(String(source.document_id), { ...source })
  }
  for (const line of response.content?.format === 'lines' ? response.content.lines || [] : []) {
    const documentId = String(line.document_id || response.document?.document_id || '')
    if (!documentId) continue
    const location = store.documents.get(documentId)?.document || {}
    const current = sources.get(documentId) || {
      document_id: documentId,
      document_uid: documentUid(documentId),
      title: String(line.document_title || naturalDocumentTitle(location) || projected.primary?.title || ''),
      line_start: Number(line.line_number), line_end: Number(line.line_number),
    }
    current.line_start = Math.min(current.line_start, Number(line.line_number))
    current.line_end = Math.max(current.line_end, Number(line.line_number))
    sources.set(documentId, current)
  }
  if (!sources.size && response.document?.document_id) {
    sources.set(response.document.document_id, {
      document_id: String(response.document.document_id),
      document_uid: documentUid(response.document.document_id),
      title: String(projected.primary?.title || naturalDocumentTitle(response.document)),
      line_start: Number(projected.primary?.selection?.line_start || 1),
      line_end: Number(projected.primary?.selection?.line_end || 1),
    })
  }
  const allSources = [...sources.values()]
  return { ...projected, presentation: {
    document_id: String(response.document?.document_id ?? ''),
    data_version: String(response.data_version ?? ''),
    sources: allSources.slice(0, 128),
    sources_truncated: allSources.length > 128,
  } }
}

/** DSH 持久展示元数据：浏览器证据卡只依赖该有界投影。 */
function readPresentationMeta(_args, value) {
  return {
    kind: 'prts-corpus-read-v1',
    locator: { document_id: value.presentation.document_id },
    data_version: value.presentation.data_version,
    title: value.primary.title,
    line_start: value.primary.selection.line_start,
    line_end: value.primary.selection.line_end,
    sources: value.presentation.sources,
    sources_truncated: value.presentation.sources_truncated,
  }
}

const TIMELINE_PARAMETERS = {
  type: 'object', additionalProperties: false,
  properties: {
    query: { type: 'string', description: '可选的事件正文短语（≤200 字符）。人物应优先放入 entity_names 以自动展开别名' },
    activity_names: { type: 'array', items: { type: 'string' }, description: '活动展示名，例如“孤星”（≤20 项）' },
    entity_names: { type: 'array', items: { type: 'string' }, description: '角色或实体展示名；工具会用别名图鉴自动裂变后检索（≤20 项）' },
    year_start: { type: 'integer', description: '起始年份（含）；可单独使用' },
    year_end: { type: 'integer', description: '结束年份（含）；可单独使用' },
    source_marker: { type: 'string', description: '反查模式：原样复制时间线结果方括号内的年表出处标记（年表出处:tle_ 开头）' },
    max_results: { type: 'integer', description: '最多返回事件数，默认 20，上限 100' },
  },
}

const CLOUD_SEARCH_PARAMETERS = {
  type: 'object', additionalProperties: false, required: ['query'],
  properties: {
    query: { type: 'string', description: '改写为语义完整、适合向量检索的自然语言' },
    games: { type: 'array', items: { type: 'string', enum: ['arknights', 'endfield'] },
      description: '可选游戏范围；省略时同一次调用同时检索明日方舟与终末地' },
    depth: { type: 'string', enum: ['fast', 'standard', 'deep'],
      description: '兼容字段；不会改变云端主站的检索路由。回答深度由 Agent 自己的运行模式控制，通常省略' },
    evidence_policy: { type: 'string', enum: ['mixed', 'original_only'],
      description: 'mixed=完整复用 PRTS.chat 主站检索、审核与 Cleaner；original_only=只运行官方剧情原文向量路线' },
    options: {
      type: 'object', additionalProperties: false,
      description: '通常省略。只有用户记得一句原文大意且措辞可能不准时，选择官方剧情单句向量路线',
      properties: {
        search_intent: {
          type: 'string', enum: ['single_sentence_search'],
          description: '只检索官方剧情单句向量表，并执行原有 LLM 验证；其他问题使用默认主站路线',
        },
      },
    },
  },
}

const CLOUD_INSPECT_PARAMETERS = {
  type: 'object', additionalProperties: false,
  description: '查看最近一次云端检索的指定区段；request_id 由运行时自动注入',
  properties: {
    games: { type: 'array', items: { type: 'string', enum: ['arknights', 'endfield'] },
      description: '只查看指定游戏的候选、来源或事件；省略时查看联合状态' },
    section: { type: 'string', enum: ['summary', 'candidates', 'selected_sources', 'events', 'trace_steps', 'answer_context'],
      description: '默认 summary' },
    cursor: { type: 'integer', description: '分页游标：原样复制上次返回的 next_cursor' },
    limit: { type: 'integer', description: '本页条数' },
    channels: stringList('按渠道过滤（candidates/events）'),
    query_variants: stringList('按查询变体过滤'),
    retrievers: stringList('按检索器过滤'),
    source_types: { type: 'array', items: { type: 'string' }, description: '按来源类型过滤' },
    statuses: { type: 'array', items: { type: 'string' }, description: '按候选状态过滤' },
    stages: stringList('按处理阶段过滤'),
    candidate_ids: stringList('按候选 ID 精确过滤'),
    evidence_ids: stringList('按证据 ID 精确过滤'),
    event_sequence_from: { type: 'integer', description: '事件序号下界（含）' },
    event_sequence_to: { type: 'integer', description: '事件序号上界（含）' },
    event_time_from: { type: 'string', description: '事件时间下界' },
    event_time_to: { type: 'string', description: '事件时间上界' },
    content_mode: { type: 'string', enum: ['none', 'preview', 'full'],
      description: 'none 只取结构字段；preview 返回受限正文；full 返回该页完整正文' },
    content_max_chars: { type: 'integer', description: '正文字符上限' },
  },
}

/** ---- 模型扁平参数 → 版本化 wire contract ---- */

/** corpus_read：将模型使用的自然定位器转换为版本化读取契约。 */
async function modelReadToContract(args = {}, store, enabledGames = ['arknights', 'endfield']) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw Object.assign(new Error('读取参数必须是对象'), { code: 'INVALID_REQUEST' })
  }
  let expectedDataVersion
  if (args.data_version !== undefined) {
    expectedDataVersion = String(args.data_version)
    if (!DATA_VERSION_PATTERN.test(expectedDataVersion)) {
      throw Object.assign(new Error('data_version 必须是续页结果给出的 64 位小写 SHA-256'),
        { code: 'INVALID_REQUEST' })
    }
  }
  const requireEnabled = (found) => {
    if (!found) return
    const game = documentGame(found.record.document)
    if (!enabledGames.includes(game)) {
      throw Object.assign(new Error(`当前未启用${game === 'endfield' ? '终末地' : '明日方舟'}资料`),
        { code: 'INVALID_REQUEST' })
    }
  }
  if (args.cursor !== undefined) {
    const allowed = new Set(['cursor', 'title', 'stage_code', 'story_part', 'mode',
      'max_lines', 'max_chars', 'data_version'])
    if (Object.keys(args).some((key) => !allowed.has(key))) {
      throw Object.assign(new Error('旧 cursor 只能附带定位器、mode=document、max_lines/max_chars'),
        { code: 'INVALID_REQUEST' })
    }
    const restored = readContractFromCursor(args.cursor)
    const restoredRecord = await store.getDocument(restored.locator.document_id)
    if (!restoredRecord) {
      throw Object.assign(new Error('cursor 指向的资料不存在'), { code: 'CURSOR_INVALID' })
    }
    requireEnabled(restoredRecord)
    if (args.mode !== undefined && args.mode !== 'document') {
      throw Object.assign(new Error('旧 cursor 只兼容 mode=document'), { code: 'INVALID_REQUEST' })
    }
    const hasCursorStageLocator = args.stage_code !== undefined || args.story_part !== undefined
    if (args.title !== undefined && hasCursorStageLocator) {
      throw Object.assign(new Error('title 与 stage_code/story_part 是两种定位方式，不能同时提供'),
        { code: 'INVALID_REQUEST' })
    }
    if (args.title !== undefined) {
      const record = await store.getDocumentByTitle(String(args.title).trim())
      if (!record || record.record.document.document_id !== restored.locator.document_id) {
        throw Object.assign(new Error('title 与 cursor 指向的资料不一致；请使用 cursor 对应的完整标题'),
          { code: 'INVALID_REQUEST' })
      }
    }
    if (hasCursorStageLocator) {
      if (!enabledGames.includes('arknights')) {
        throw Object.assign(new Error('关卡代号定位仅用于明日方舟，但当前未启用明日方舟资料'),
          { code: 'INVALID_REQUEST' })
      }
      const stageCode = publicStoryStageCode(args.stage_code, { relaxedInput: true })
      const storyPart = args.story_part === undefined ? '' : publicStoryPart(args.story_part)
      if (!stageCode || (args.story_part !== undefined && !storyPart)) {
        throw Object.assign(new Error('旧 cursor 使用关卡定位时必须提供有效的 stage_code/story_part'),
          { code: 'INVALID_REQUEST' })
      }
      const record = await store.getDocumentByStoryStage(stageCode, storyPart)
      if (!record || record.record.document.document_id !== restored.locator.document_id) {
        throw Object.assign(new Error('stage_code/story_part 与 cursor 指向的资料不一致'),
          { code: 'INVALID_REQUEST' })
      }
    }
    return { ...restored,
      ...(expectedDataVersion ? { expected_data_version: expectedDataVersion } : {}), limits: {
      ...restored.limits,
      ...(args.max_lines !== undefined ? { max_lines: args.max_lines } : {}),
      ...(args.max_chars !== undefined ? { max_chars: args.max_chars } : {}),
    } }
  }
  const allowed = new Set(['title', 'document_uid', 'stage_code', 'story_part', 'character_name', 'record_name',
    'segment', 'material', 'game', 'activity_name', 'collection_name', 'content_types',
    'line', 'position', 'mode', 'section', 'before', 'after', 'max_lines', 'max_chars',
    'data_version'])
  if (Object.keys(args).some((key) => !allowed.has(key))) {
    throw Object.assign(new Error('corpus_read 包含不支持的参数'), { code: 'INVALID_REQUEST' })
  }

  const hasTitle = args.title !== undefined
  const hasDocumentUid = args.document_uid !== undefined
  const hasStageLocator = args.stage_code !== undefined || args.story_part !== undefined
  const hasRecordLocator = args.record_name !== undefined || args.segment !== undefined
  const hasMaterialLocator = args.material !== undefined
  const hasActivityLocator = args.activity_name !== undefined
  const hasCollectionLocator = args.collection_name !== undefined
  const locatorCount = [hasTitle, hasDocumentUid, hasStageLocator, hasRecordLocator, hasMaterialLocator,
    hasActivityLocator, hasCollectionLocator].filter(Boolean).length
  if (locatorCount !== 1) {
    throw Object.assign(new Error(
      '必须且只能提供一种定位方式：title、document_uid、stage_code、角色密录、角色资料、activity_name 或 collection_name；document_uid 会替代 title，不要同时提交二者',
    ), { code: 'INVALID_REQUEST' })
  }
  if (args.character_name !== undefined && !hasRecordLocator && !hasMaterialLocator) {
    throw Object.assign(new Error('character_name 必须与 record_name 或 material 配合'),
      { code: 'INVALID_REQUEST' })
  }
  if (args.game !== undefined && !hasMaterialLocator) {
    throw Object.assign(new Error('game 只用于角色资料定位'), { code: 'INVALID_REQUEST' })
  }
  if (hasMaterialLocator && !['profile', 'module', 'voice', 'skin', 'recruitment', 'potential']
    .includes(args.material)) {
    throw Object.assign(new Error('material 仅支持 profile/module/voice/skin/recruitment/potential'),
      { code: 'INVALID_REQUEST' })
  }
  if (args.game !== undefined && !['arknights', 'endfield'].includes(args.game)) {
    throw Object.assign(new Error('game 仅支持 arknights 或 endfield'), { code: 'INVALID_REQUEST' })
  }
  const uidStreamMode = hasDocumentUid && (args.mode === 'activity' || args.mode === 'collection')
  if (args.content_types !== undefined && !(hasCollectionLocator || (hasDocumentUid && args.mode === 'collection'))) {
    throw Object.assign(new Error('content_types 只用于终末地 collection_name 连续阅读'),
      { code: 'INVALID_REQUEST' })
  }
  if (args.position !== undefined && !hasActivityLocator && !hasCollectionLocator && !uidStreamMode) {
    throw Object.assign(new Error('position 只用于活动或任务集合续读'), { code: 'INVALID_REQUEST' })
  }

  if (hasActivityLocator || hasCollectionLocator || uidStreamMode) {
    const expectedMode = hasActivityLocator ? 'activity'
      : hasCollectionLocator ? 'collection' : args.mode
    if (args.mode !== undefined && args.mode !== expectedMode) {
      throw Object.assign(new Error(`${hasActivityLocator ? 'activity_name' : 'collection_name'} 必须使用 mode="${expectedMode}"`),
        { code: 'INVALID_REQUEST' })
    }
    if (args.line !== undefined || args.section !== undefined || args.before !== undefined
        || args.after !== undefined) {
      throw Object.assign(new Error('活动/任务连续阅读不能与 line、section、before 或 after 同用'),
        { code: 'INVALID_REQUEST' })
    }
    const requiredGame = expectedMode === 'activity' ? 'arknights' : 'endfield'
    if (!enabledGames.includes(requiredGame)) {
      throw Object.assign(new Error(`当前未启用${requiredGame === 'arknights' ? '明日方舟' : '终末地'}资料`),
        { code: 'INVALID_REQUEST' })
    }
    const name = String(hasActivityLocator ? args.activity_name : args.collection_name || '').trim()
    let anchorDocumentId = ''
    if (hasDocumentUid) {
      const anchor = await store.getDocumentByUid(String(args.document_uid || '').trim())
      if (!anchor) throw Object.assign(new Error('document_uid 对应的资料不存在'),
        { code: 'DOCUMENT_NOT_FOUND' })
      requireEnabled(anchor)
      if (documentGame(anchor.record.document) !== requiredGame) {
        throw Object.assign(new Error(`该 document_uid 不属于${requiredGame === 'endfield' ? '终末地任务' : '明日方舟活动'}资料`),
          { code: 'INVALID_REQUEST' })
      }
      anchorDocumentId = anchor.record.document.document_id
    } else if (!name) {
      throw Object.assign(new Error('活动/任务集合名称不能为空'), { code: 'INVALID_REQUEST' })
    }
    // 在进入执行层前先做一次歧义检查，让工具调用直接给出可操作的错误。
    try {
      const docs = hasActivityLocator
        ? store.activityStoryDocuments({ activityName: name })
        : expectedMode === 'activity'
          ? store.activityStoryDocuments({ anchorDocumentId })
          : store.endfieldCollectionDocuments({ collectionName: name, anchorDocumentId,
              contentTypes: Array.isArray(args.content_types) ? args.content_types : [] })
      if (!docs.length) throw Object.assign(new Error(
        `本地资料包中找不到${expectedMode === 'activity' ? '活动' : '终末地集合'}${name ? `“${name}”` : ''}的剧情原文`,
      ), { code: 'DOCUMENT_NOT_FOUND' })
    } catch (error) {
      throw Object.assign(new Error(error.message), { code: error.code || 'DOCUMENT_AMBIGUOUS' })
    }
    return {
      locator: hasDocumentUid ? { document_uid: String(args.document_uid).trim() }
        : { [hasActivityLocator ? 'activity_name' : 'collection_name']: name },
      selection: { mode: expectedMode, cursor: null,
        ...(args.position !== undefined ? { start_position: args.position } : {}),
        ...(args.content_types !== undefined ? { content_types: args.content_types } : {}) },
      ...(expectedDataVersion ? { expected_data_version: expectedDataVersion } : {}),
      limits: { ...(args.max_lines !== undefined ? { max_lines: args.max_lines } : {}),
        ...(args.max_chars !== undefined ? { max_chars: args.max_chars } : {}) },
    }
  }

  let locator
  if (hasStageLocator) {
    if (!enabledGames.includes('arknights')) {
      throw Object.assign(new Error('关卡代号定位仅用于明日方舟，但当前未启用明日方舟资料'),
        { code: 'INVALID_REQUEST' })
    }
    const stageCode = publicStoryStageCode(args.stage_code, { relaxedInput: true })
    const storyPart = args.story_part === undefined ? '' : publicStoryPart(args.story_part)
    if (!stageCode) {
      throw Object.assign(new Error('stage_code 必须是有效的明日方舟关卡代号，如 15-17、GT-3 或 BB-7'),
        { code: 'INVALID_REQUEST' })
    }
    if (args.story_part !== undefined && !storyPart) {
      throw Object.assign(new Error('story_part 仅支持 before（行动前）、after（行动后）或 story（纯剧情/幕间）'),
        { code: 'INVALID_REQUEST' })
    }
    if (args.section !== undefined) {
      throw Object.assign(new Error('关卡代号定位只读取官方剧情原文，不能与 Wiki section 同用'),
        { code: 'INVALID_REQUEST' })
    }
    let record
    try {
      record = await store.getDocumentByStoryStage(stageCode, storyPart)
    } catch (error) {
      throw Object.assign(new Error(error.message),
        { code: error.code || 'DOCUMENT_AMBIGUOUS' })
    }
    if (!record) {
      const partLabel = storyPart
        ? `的${{ before: '行动前剧情', after: '行动后剧情', story: '纯剧情/幕间' }[storyPart]}` : '剧情'
      throw Object.assign(new Error(
        `本地资料包中找不到关卡 ${stageCode}${partLabel}`,
      ), { code: 'DOCUMENT_NOT_FOUND' })
    }
    requireEnabled(record)
    locator = { document_id: record.record.document.document_id }
  } else if (hasRecordLocator) {
    if (!enabledGames.includes('arknights')) {
      throw Object.assign(new Error('干员密录定位仅用于明日方舟，但当前未启用明日方舟资料'),
        { code: 'INVALID_REQUEST' })
    }
    const characterName = String(args.character_name ?? '').trim()
    const recordName = String(args.record_name ?? '').trim()
    if (!characterName || !recordName) {
      throw Object.assign(new Error('干员密录定位必须同时提供 character_name 和 record_name'),
        { code: 'INVALID_REQUEST' })
    }
    if (args.segment !== undefined && (!Number.isInteger(args.segment) || args.segment < 1)) {
      throw Object.assign(new Error('segment 必须是从 1 开始的整数'), { code: 'INVALID_REQUEST' })
    }
    let record
    try {
      record = await store.getOperatorRecord(characterName, recordName, args.segment)
    } catch (error) {
      throw Object.assign(new Error(error.message), { code: error.code || 'DOCUMENT_AMBIGUOUS' })
    }
    if (!record) throw Object.assign(new Error(
      `本地资料包中找不到干员“${characterName}”的密录“${recordName}”${args.segment ? `第 ${args.segment} 段` : ''}`,
    ), { code: 'DOCUMENT_NOT_FOUND' })
    locator = { document_id: record.record.document.document_id }
  } else if (hasMaterialLocator) {
    const characterName = String(args.character_name ?? '').trim()
    if (!characterName) throw Object.assign(new Error('角色资料定位必须提供 character_name'),
      { code: 'INVALID_REQUEST' })
    const requestedGames = args.game ? [args.game] : enabledGames
    if (requestedGames.some((game) => !enabledGames.includes(game))) {
      throw Object.assign(new Error('指定的角色资料模块当前未启用'), { code: 'INVALID_REQUEST' })
    }
    let record
    try {
      record = await store.getCharacterMaterial(characterName, args.material, requestedGames)
    } catch (error) {
      throw Object.assign(new Error(error.message), { code: error.code || 'DOCUMENT_AMBIGUOUS' })
    }
    if (!record) throw Object.assign(new Error(
      `本地资料包中找不到角色“${characterName}”的 ${args.material} 资料`,
    ), { code: 'DOCUMENT_NOT_FOUND' })
    requireEnabled(record)
    locator = { document_id: record.record.document.document_id }
  } else if (hasDocumentUid) {
    const uid = String(args.document_uid || '').trim()
    const record = await store.getDocumentByUid(uid)
    if (!record) throw Object.assign(new Error(`本地资料包中找不到 document_uid=${uid}`),
      { code: 'DOCUMENT_NOT_FOUND' })
    requireEnabled(record)
    locator = { document_uid: uid }
  } else {
    const title = String(args.title ?? '').trim()
    if (!title) throw Object.assign(new Error('title 不能为空'), { code: 'INVALID_REQUEST' })
    const record = await store.getDocumentByTitle(title)
    requireEnabled(record)
    locator = { display_title: title }
  }
  const section = String(args.section ?? '').trim()
  if (section && !hasTitle) {
    throw Object.assign(new Error('section 只能与 title 定位器一起使用'), { code: 'INVALID_REQUEST' })
  }
  const naturalDocumentLocator = hasDocumentUid || hasStageLocator || hasRecordLocator || hasMaterialLocator
  const mode = args.mode || (section ? 'section' : Number.isInteger(args.line) ? 'around'
    : naturalDocumentLocator ? 'document' : '')
  if (!mode) throw Object.assign(new Error(
    '请提供 line、section 或 mode="document"；max_lines/max_chars 只限制输出量，不能代替读取方式',
  ), { code: 'INVALID_REQUEST' })
  if (!['around', 'section', 'document'].includes(mode)) {
    throw Object.assign(new Error('mode 仅支持 document；line/section 会自动选择模式'),
      { code: 'INVALID_REQUEST' })
  }
  if (mode === 'around' && !Number.isInteger(args.line)) {
    throw Object.assign(new Error('around 模式必须提供整数 line'), { code: 'INVALID_REQUEST' })
  }
  if (mode === 'section' && !section) {
    throw Object.assign(new Error('section 模式必须提供 section'), { code: 'INVALID_REQUEST' })
  }
  if (section && mode !== 'section') {
    throw Object.assign(new Error('section 只能与 mode=section 一起使用'), { code: 'INVALID_REQUEST' })
  }
  const selection = mode === 'document'
    ? { mode, cursor: null, ...(args.line !== undefined ? { start_line: args.line } : {}) }
    : mode === 'section'
          ? { mode, section }
        : { mode: 'around', center_line: args.line,
          ...(args.before !== undefined ? { before_lines: args.before } : {}),
          ...(args.after !== undefined ? { after_lines: args.after } : {}) }
  return {
    locator, selection,
    ...(expectedDataVersion ? { expected_data_version: expectedDataVersion } : {}),
    limits: { ...(args.max_lines !== undefined ? { max_lines: args.max_lines } : {}),
      ...(args.max_chars !== undefined ? { max_chars: args.max_chars } : {}) },
  }
}

/** ---- 云端渲染（output.render 用，压缩为模型可读文本） ---- */

function renderCloudSearch(_args, value) {
  if (value.status === 'error') {
    return [{ type: 'text', text: `[cloud_search:error] ${value.error.code}: ${value.error.message}` }]
  }
  return [{ type: 'text', text: projectCloudSearch(value) }]
}

function renderCloudInspect(_args, value) {
  if (value.status === 'error') {
    return [{ type: 'text', text: `[cloud_inspect:error] ${value.error.code}: ${value.error.message}` }]
  }
  return [{ type: 'text', text: JSON.stringify(projectCloudInspect(value)) }]
}

/** ---- 插件入口 ---- */

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{
 *   releasesDir?: string,
 *   cacheShards?: number,
 *   uiSkin?: 'harness' | 'prts-agent',
 *   download?: { order?: ('modelscope'|'site')[], siteBaseUrl?: string },
 *   cloud?: { baseUrl?: string, game?: 'arknights' | 'endfield', userId?: string, token?: string, timeoutMs?: number, maxResponseBytes?: number },
 * }} [config]
 */
export async function apply(ctx, config = {}) {
  // Cordis 传空配置时可能是 null 而非 undefined，默认参数不生效，需兜底
  config = config ?? {}
  // 工具开关：host 常驻时只做资料管理（registerTools:false），PRTS 预设（模式）加载时才注册工具（true）
  const enableTools = config.registerTools !== false
  const configuredHome = process.env.DSH_HOME?.trim()
  const dshHome = resolve(configuredHome || join(homedir(), '.dsh'))
  const portableReleasesDir = process.env.PRTS_CORPUS_RELEASES_DIR?.trim()
  const configuredReleasesDir = config.releasesDir
    ? (isAbsolute(config.releasesDir) ? config.releasesDir : resolve(process.cwd(), config.releasesDir))
    : portableReleasesDir ? resolve(portableReleasesDir) : join(dshHome, 'prts-corpus', 'releases')
  const releasesDir = await resolveSafeReleasesDirectory(configuredReleasesDir, dshHome)

  // 共享状态：三层配置（默认 ← patch ← $DSH_HOME/prts-corpus.json），设置页可运行时改
  const configPath = join(dshHome, 'prts-corpus.json')
  const shared = createSharedState({ patchConfig: config, configPath, releasesDir })
  await shared.loadConfig()

  // 云端匿名会话的持久 client id：跨重启稳定，服务端据此统计独立 DSH 用户。
  // 读不出来（只读 HOME 等）不致命——退回每次加载随机的旧行为。
  let cloudClientId = null
  try {
    cloudClientId = await readOrCreateClientId(join(dshHome, 'prts-corpus', 'client-id'))
  } catch (error) {
    ctx.logger?.warn?.(`prts-corpus: client-id 持久化失败（独立用户统计将不准确）: ${error?.message ?? error}`)
  }

  let storeEntry = storesByDirectory.get(releasesDir)
  if (!storeEntry) {
    storeEntry = {
      store: new CorpusStore({ releasesDir, cacheShards: shared.effective().cacheShards,
        cursorSecretPath: join(dshHome, 'prts-corpus', 'cursor-secret.bin') }),
      watcher: null,
      watchRefs: 0,
      releaseTimer: null,
      refs: 0,
    }
    storesByDirectory.set(releasesDir, storeEntry)
  }
  storeEntry.refs += 1
  ctx.effect(() => () => {
    storeEntry.refs -= 1
    if (storeEntry.refs === 0) storesByDirectory.delete(releasesDir)
  }, 'prts-corpus: shared store')
  const store = storeEntry.store
  shared.store = store
  // 若本地已有资料，插件装载后立即在后台建立目录与实体索引。初始化仍然
  // 幂等且不阻塞 Cordis ready；用户第一问通常可以直接复用已完成的预热。
  // 没装资料时保持安静，工具被调用后再返回统一的安装提示。
  let prewarmCancelled = false
  const prewarmHandle = config.registerUi === false ? null : setImmediate(async () => {
    const started = Date.now()
    try {
      await readCurrentReleasePointer(releasesDir)
      if (prewarmCancelled) return
      await prepareEntityRecognition(store)
      if (!prewarmCancelled) {
        ctx.logger?.info?.(`prts-corpus: local indexes prewarmed in ${Date.now() - started}ms`)
      }
    } catch (error) {
      if (!prewarmCancelled && error?.code !== 'ENOENT') {
        ctx.logger?.warn?.(`prts-corpus: 后台索引预热失败: ${error?.message ?? error}`)
      }
    }
  })
  ctx.effect(() => () => { prewarmCancelled = true; if (prewarmHandle) clearImmediate(prewarmHandle) },
    'prts-corpus: background index prewarm')
  const evidenceStates = createEvidenceStateRegistry()
  // DSH 自身不会以同一 callId 重试工具执行；此缓存只防御第三方 tools/execute
  // 策略在同一 exec 内的重放，避免重复扫描语料。完整跨重启幂等仍由未来共享
  // 调用存储承担，避免把检索正文写入配置目录。

  const stopWatching = await shared.watchConfig(ctx.logger)
  ctx.effect(() => stopWatching, 'prts-corpus: config watch')
  ctx.effect(() => shared.subscribe((effective) => {
    store.cacheShards = effective.cacheShards
  }), 'prts-corpus: store config')

  const mountTools = (toolCtx) => {
    const tools = toolCtx.tools
    // Host 的 preset 准入已经完成初始化；工具挂载不再触发下载或全量扫描。
    applyEntityRecognition(toolCtx, store, shared)
    tools.register({
      name: 'corpus_search',
      description: SEARCH_DESCRIPTION,
      parameters: SEARCH_PARAMETERS,
      output: { schema: SEARCH_OUTPUT_SCHEMA, render: renderSearch },
      timeoutMs: 120_000,
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        await requireLocalCorpus(store)
        const evidenceState = evidenceStates.forExecution(exec, store.dataVersion)
        const completedSearchCalls = evidenceState.completedSearchCalls
        const callId = String(exec?.callId || '')
        // 先做对象校验再做幂等哈希：JSON.stringify(undefined) 返回 undefined，
        // 直接 update 会抛 TypeError，绕过本工具的 INVALID_REQUEST 错误通道。
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw Object.assign(new Error('搜索参数必须是对象'),
            { code: 'INVALID_REQUEST', retryable: false })
        }
        const enabledGames = shared.effective().enabledGames
        let scopedArgs = args
        if (args.cursor == null) {
          const requestedGames = Array.isArray(args.games) ? args.games : enabledGames
          const games = requestedGames.filter((game) => enabledGames.includes(game))
          if (!games.length) {
            throw Object.assign(new Error('请求的游戏资料库当前未启用，请先在 PRTS 资料设置中勾选'),
              { code: 'INVALID_REQUEST', retryable: false })
          }
          scopedArgs = { ...args, games }
        }
        const requestHash = createHash('sha256').update(JSON.stringify(scopedArgs)).digest('hex')
        if (callId && completedSearchCalls.has(callId)) {
          const cached = completedSearchCalls.get(callId)
          if (cached.requestHash !== requestHash) return {
            contract_version: 'prts-corpus-tools-v1', status: 'error', request_id: callId,
            data_version: store.dataVersion ?? null,
            error: { code: 'INVALID_REQUEST', message: 'callId 已绑定到另一个搜索请求', retryable: false },
          }
          return structuredClone(cached.response)
        }
        let response = await executeSearch(store, scopedArgs, { signal: exec?.signal,
          requestId: callId || undefined, allowedGames: enabledGames })
        if (response?.error) {
          throw Object.assign(new Error(response.error.message),
            { code: response.error.code, retryable: response.error.retryable })
        }
        response = await attachRetravelerRelations(store, response, scopedArgs, enabledGames)
        if (callId) {
          completedSearchCalls.set(callId, { requestHash, response: structuredClone(response) })
          if (completedSearchCalls.size > 256) completedSearchCalls.delete(completedSearchCalls.keys().next().value)
        }
        rememberSearchCandidates(evidenceState, response)
        return response
      },
    })

    tools.register({
      name: 'corpus_read',
      description: READ_DESCRIPTION,
      parameters: READ_PARAMETERS,
      output: { schema: READ_OUTPUT_SCHEMA, render: renderRead,
        presentationMeta: readPresentationMeta },
      timeoutMs: 120_000,
      // 原文覆盖去重依赖前一个 tool/result 已进入模型可见 surface。并行
      // 读取会让同一步的每个调用都误判为首次读取，因此必须由 Harness 按
      // 模型调用顺序独占执行并逐个提交结果。
      isConcurrencySafe: () => false,
      execute: async (args, exec) => {
        await requireLocalCorpus(store)
        const evidenceState = evidenceStates.forExecution(exec, store.dataVersion)
        let contract
        try {
          contract = await modelReadToContract(args, store, shared.effective().enabledGames)
        } catch (error) {
          throw Object.assign(new Error(error.message),
            { code: error.code || 'INVALID_REQUEST', retryable: false })
        }
        if (contract.expected_data_version !== undefined
            && contract.expected_data_version !== store.dataVersion) {
          throw Object.assign(new Error('续页所属资料版本与当前激活版本不一致，请重新读取'),
            { code: 'PACKAGE_VERSION_MISMATCH', retryable: true })
        }
        // 证据覆盖按 Harness Agent 隔离；模型不感知 intent_id。
        contract.intent_id = evidenceState.intentId
        const requested = await resolveReadWindow(store, contract)
        const visibleResults = visibleToolResults(exec?.agent)
        if (coveredRead(evidenceState, requested, visibleResults)) {
          const replay = replayCoveredRead(evidenceState, requested, contract)
          if (replay) return projectReadToolValue(replay, store)
        }
        const coveragePlan = planReadCoverage(evidenceState, requested, visibleResults)
        const requestedLineCount = requested ? requested.lineEnd - requested.lineStart + 1 : Infinity
        const partial = coveragePlan?.reusedRanges.length > 0 && coveragePlan.unreadRanges.length > 0
          && requestedLineCount <= Number(contract.limits?.max_lines || 100)
        if (partial) {
          const responses = []
          for (const range of coveragePlan.unreadRanges) {
            const partialContract = structuredClone(contract)
            partialContract.selection = { mode: 'range', start_line: range.lineStart, end_line: range.lineEnd }
            const response = await executeRead(store, partialContract, { signal: exec?.signal })
            if (response.status !== 'ok') throw Object.assign(new Error(response.error.message), response.error)
            rememberRead(evidenceState, response, { callId: String(exec?.callId || ''), store })
            responses.push(response)
            if (exec?.callId) {
              visibleResults.set(String(exec.callId),
                responses.map((item) => renderRead({}, item)[0]?.text || '').join('\n'))
            }
          }
          return projectReadToolValue(combinePartialReadResponses(requested, contract, coveragePlan, responses,
            Boolean(coveredRead(evidenceState, requested, visibleResults))), store)
        }
        const response = await executeRead(store, contract, { signal: exec?.signal })
        if (response.status !== 'ok') throw Object.assign(new Error(response.error.message), response.error)
        rememberRead(evidenceState, response, { callId: String(exec?.callId || ''), store })
        return projectReadToolValue(response, store)
      },
    })

    tools.register({
      name: 'timeline_search',
      description: TIMELINE_DESCRIPTION,
      parameters: TIMELINE_PARAMETERS,
      output: { schema: {}, render: renderTimeline },
      timeoutMs: 60_000,
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        await requireLocalCorpus(store)
        return executeTimelineSearch(store, args, { signal: exec?.signal })
      },
    })

    // 云端工具：按生效配置注册，配置变更（设置页）时 dispose + 热重建
    const cloudDisposers = []
    const rebuildCloud = () => {
      for (const dispose of cloudDisposers.splice(0)) {
        try { dispose() } catch { /* 卸载旧注册 */ }
      }
      const c = shared.effective()
      if (!c.cloudEnabled || !c.cloudBaseUrl) return false
      const cloudClients = createAgentCloudClientRegistry(() => {
        const tokenProvider = c.cloudToken
          ? new StaticTokenProvider(c.cloudToken)
          : new AnonymousSessionProvider({ baseUrl: c.cloudBaseUrl,
            userId: c.cloudUserId || cloudClientId || undefined,
            timeoutMs: c.cloudTimeoutMs })
        const cloudGame = c.enabledGames.length === 2 ? 'all' : c.enabledGames[0]
        return new CloudRetrievalClient({
          baseUrl: c.cloudBaseUrl, tokenProvider, game: cloudGame,
          timeoutMs: c.cloudTimeoutMs, maxResponseBytes: c.cloudMaxResponseBytes,
        })
      })
      const searchDispose = tools.register({
        name: 'cloud_search',
        description: CLOUD_SEARCH_DESCRIPTION,
        parameters: CLOUD_SEARCH_PARAMETERS,
        output: { schema: {}, render: renderCloudSearch },
        timeoutMs: 180_000,
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
          try {
            const evidenceState = evidenceStates.forExecution(exec, store.dataVersion)
            const cloud = cloudClients.forExecution(exec)
            await cloud.capabilities({ signal: exec?.signal })
            const requestedGames = Array.isArray(args.games) ? args.games : c.enabledGames
            const games = requestedGames.filter((game) => c.enabledGames.includes(game))
            if (!games.length) throw Object.assign(
              new Error('请求的游戏资料库当前未启用，请先在 PRTS 资料设置中勾选'),
              { code: 'INVALID_REQUEST', retryable: false })
            const payload = { ...args, games, intent_id: evidenceState.cloudIntentId }
            const response = await cloud.search(payload, { signal: exec?.signal })
            const mapped = await attachLocalSourceMappings(store, response, { signal: exec?.signal })
            const enriched = await attachRetravelerRelations(store, mapped, args, c.enabledGames)
            rememberCloudMappings(evidenceState, enriched)
            return enriched
          } catch (error) {
            return cloudErrorResponse(error)
          }
        },
      })
      if (typeof searchDispose === 'function') cloudDisposers.push(searchDispose)

      const inspectDispose = tools.register({
        name: 'cloud_inspect',
        description: CLOUD_INSPECT_DESCRIPTION,
        parameters: CLOUD_INSPECT_PARAMETERS,
        output: { schema: {}, render: renderCloudInspect },
        timeoutMs: 120_000,
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
          try {
            const evidenceState = evidenceStates.forExecution(exec, store.dataVersion)
            const cloud = cloudClients.forExecution(exec)
            await cloud.capabilities({ signal: exec?.signal })
            const payload = { ...args,
              ...(args.request_id || !evidenceState.lastCloudRequestId
                ? {} : { request_id: evidenceState.lastCloudRequestId }) }
            const response = await cloud.inspect(payload, { signal: exec?.signal })
            const mapped = await attachLocalSourceMappings(store, response, { signal: exec?.signal })
            rememberCloudMappings(evidenceState, mapped)
            return mapped
          } catch (error) {
            return cloudErrorResponse(error)
          }
        },
      })
      if (typeof inspectDispose === 'function') cloudDisposers.push(inspectDispose)

      toolCtx.logger?.info?.(`prts-corpus: cloud tools enabled (baseUrl=${c.cloudBaseUrl}, games=${c.enabledGames.join(',')})`)
      return true
    }
    rebuildCloud()
    toolCtx.effect(() => shared.subscribe(rebuildCloud), 'prts-corpus: cloud config')
  }

  // tools/connection 都是可选部署能力；ctx.inject 会等待其出现并在其消失时
  // 自动卸载对应子树，避免“插件 ACTIVE 但永久漏注册”的启动顺序竞态。
  // Agent preset 的 standing mount 必须等工具子 fiber 完成注册后才能宣告就绪。
  // 不 await 会形成“Skill 已可见、工具仍缺席”的半挂载会话，且子 fiber 的
  // schema/注册异常也无法阻止该会话创建。
  if (enableTools) await ctx.inject(['tools'], mountTools)

  if (enableTools) {
    await mkdir(releasesDir, { recursive: true })
    storeEntry.watchRefs += 1
    if (!storeEntry.watcher) {
      storeEntry.watcher = watch(releasesDir, { persistent: false }, (_event, filename) => {
        if (String(filename ?? '') !== 'current.json') return
        if (storeEntry.releaseTimer) clearTimeout(storeEntry.releaseTimer)
        storeEntry.releaseTimer = setTimeout(async () => {
          storeEntry.releaseTimer = null
          try {
            const pointer = await readCurrentReleasePointer(releasesDir)
            if (store.loaded && store.releaseId === pointer.release_id) return
          } catch { /* 让 ready() 输出真实指针错误 */ }
          store.reset()
          prepareEntityRecognition(store).catch((error) => {
            ctx.logger?.warn?.(`prts-corpus: 版本热切换失败: ${error?.message ?? error}`)
          })
        }, 100)
      })
    }
    ctx.effect(() => () => {
      storeEntry.watchRefs -= 1
      if (storeEntry.watchRefs > 0) return
      if (storeEntry.releaseTimer) clearTimeout(storeEntry.releaseTimer)
      storeEntry.releaseTimer = null
      storeEntry.watcher?.close()
      storeEntry.watcher = null
    }, 'prts-corpus: release watch')
  }

  // 设置页 API 与 AIC 地图静态资源（connection/webServer 为可选服务；
  // headless profile 不挂载）。必须把两项都注入子上下文；只等待 connection
  // 时，隔离服务拓扑中 applyUi 看不到 webServer，浏览器能加载插件却会让地图 404。
  // host 常驻（registerUi 缺省 true）注册 /api/prts-corpus + 设置 tab 数据源；
  // PRTS 预设（registerUi:false）只注册工具，避免与 host 重复注册同名前缀路由。
  if (config.registerUi !== false) {
    ctx.inject(['connection', 'webServer'], (webCtx) => { applyUi(webCtx, shared) })
  }
}
