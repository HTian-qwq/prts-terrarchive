# 莱茵皮肤性能诊断 v3.5

右下角打开「性能测试 · 临时」，标题应为 **性能诊断 / v3.5**。新版本导出 `rhine-render-capture/v3`；逐帧字段延续 v2，高频诊断通道改为按秒汇总，解析器需按 schema 区分。本次不改变性能档位、镜头或渲染效果。

## 下一次采样

1. 在平时出现问题的同一个宿主/浏览器里载入新构建，保持窗口尺寸和原来的性能档位。
2. 选择 120 秒，保留「GPU 计时」，开始后收起面板，按你描述的情况正常开着即可。
3. 结束后导出 JSON；开始新测试会覆盖内存中的上一份记录，刷新也会清除记录。
4. 再单独记录滚动、抽出、切换区域和模型查看器。有明显卡顿时，可展开面板点「标记刚才的卡顿」，该时间是事后手动标记，不能等同于停顿起点。
5. 如怀疑 GPU 查询影响表现，再取消「GPU 计时」，在相同条件下重复。这个开关只关闭测量，不改变画质。面板收起事件也会记录，便于比较面板绘制的开销。

测试时限是墙钟时间，后台/暂停也计入 120 秒。最多保留 24,000 帧，达到任一限制自动停止。停止后最多等 5 秒排空 GPU 查询，再导出。可以导出没有渲染帧、但含心跳/错误的采集。

## 逐帧时间线

所有 `at` 为距采集开始的毫秒；`timeOrigin + captureStartTime + at` 可转换到统一的绝对时间。负的 `rafAt` 表示首个 RAF 时间戳早于开始按钮触发。

| 字段 | 含义 |
| --- | --- |
| `at` | 实际进入渲染探针时的 `performance.now()` |
| `rafAt` | 浏览器传入的原始 RAF 时间戳，转换到同一原点 |
| `intervalMs` | 相邻有效 RAF 时间戳差，保留 v1 兼容字段 |
| `callbackIntervalMs` | 实际开始执行两个连续渲染回调的间隔；排除已知暂停/切换渲染器边界和一次性同步绘制 |
| `rafLagMs` | 实际开始执行与 RAF 时间戳之差 |
| `outsideFrameMs` | 上次探针结束到本次开始之间的空档；包含其他任务、调度与等待，不能直接叫作 CPU 阻塞时间 |
| `cpuMs` | 场景更新与同步 WebGL 提交的墙钟耗时；不包含 begin/end 统计，含少量阶段计时和计数开销 |
| `stages` | collection、sceneUpdate、labelPrepare、composer、labelOverlay、uiSync、tail；查看器为 viewerUpdate、viewerRender、tail |
| `probeBeginMs / probeEndMs` | 逐帧探针开销估计，包含 begin 阶段的 GPU 结果轮询 |
| `gpuMs / gpuStatus` | 异步 GPU 查询结果及状态；无效/不支持/关闭时为 null，不填 0 |
| `gpuPending` | 本次 begin 开始时尚未回收的 GPU 查询数量 |
| `gpuQueryLatencyMs` | 从查询提交到观察到结果可用的时间，受轮询频率影响，不是 GPU 队列时间或 GPU 执行时间 |
| `counters` | 阵列零件实例/批次数、主体/档案架/证据板是否启用、各类资料动画数量、相机移动、准备队列、后处理开关等 |
| `submissions` | 各阶段的实际 draw calls / triangles 增量；各项合计等于该帧总数，不是逐 pass GPU 时间 |

阶段之和等于 `cpuMs`；composer 包含已有后处理及深度保存等 passes。此阶段计时只拆分 CPU 墙钟时间，不冒充逐 pass GPU 时间。CPU/GPU 执行可重叠，不能相加。v1 兼容字段 `summary.fps` 仍是 RAF 时间戳差的倒数；新版面板使用实际回调间隔，并显示“回调/秒”，两者都不是屏幕实际呈现 FPS。

## 帧外诊断

| 通道 | 记录内容 | 上限 |
| --- | --- | --- |
| `longTasks` | 页面主线程至少 50 ms 的任务 | 4,000 |
| `diagnostics.longAnimationFrames` | 长动画帧、render/style-layout 起点、阻塞时长、脚本类别与强制布局时间 | 2,000，每项最多 16 个脚本 |
| `diagnostics.interactions` | Event Timing 的事件类别、输入等待、处理耗时、总时长 | 2,000 |
| `diagnostics.resources` | 请求类别、允许名单内的静态资产名、时序、传输字节、响应状态（浏览器允许时） | 2,000 |
| `diagnostics.layoutShifts` | 每秒偏移次数/总分/最大分、最大事件的 UI 区域类别，按是否紧邻输入分别分桶；不是 CLS | 1,000 桶 |
| `diagnostics.heartbeat` | 每秒心跳延误、焦点/可见性、窗口/DPR、字体加载状态、JS 堆、场景状态 | 240 |
| `diagnostics.backgroundWork` | 档案准备同步段与含 Promise 等待的完整生命周期，成功/失败 | 4,000 |
| `diagnostics.overhead` | 面板、心跳、每种 PerformanceObserver 独立的秒桶：次数、总耗时、最高耗时、最慢事件时刻 | 2,000 桶 |
| `diagnostics.uiWork` | snapshot-update、mergeSources、renderStatus、阅读 DOM、结果列表、报告等同步更新，按种类按秒汇总 | 6,000 桶 |
| `diagnostics.slowWork` | 超过或等于 8 ms 的 UI 更新/监控工作，额外保留准确起点和持续时间 | 2,000 |
| `diagnostics.loads` | 模型获取/解析、字体、场景准备、查看器装配、搜索/读取 API 的开始/结束/失败/取消 | 2,000 |
| `events` | 输入类别、自动扫描、导航、位置/阅读状态、前后台/焦点、窗口变化、上下文丢失、错误、手动卡顿标记 | 4,000 |

LoAF 能补充“多个不足 50 ms 的任务合在一起延误渲染”这类情况，但并不提供操作系统或所有跨域脚本的完整调用栈。[Chrome LoAF 文档](https://developer.chrome.com/docs/web-platform/long-animation-frames)

Event Timing 请求 16 ms 阈值，耗时由浏览器取整；不会产生每次输入的完整事件记录，也不是单次录制的标准 INP。轮询的 JS 堆只是 Chromium 估值，可能共享或取整，不能单独用于判定内存泄漏。资源时序可能受跨域限制，0 字节不代表没有加载。[PerformanceObserver 文档](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceObserver/observe)

`capabilities` 区分接口不支持、观察器安装失败和成功启用；启用不代表这次一定发生相应事件。没有相应事件不等于没有问题。监听器和心跳在采集结束后移除；页面长任务在后台也保留，并结合可见性事件判断。观察器只接受本轮开始到停止之间起始的项目，可能不包含跨越开始边界或停止后才交付的事件。异步准备在停止后完成会标明 `finishedAfterCapture`，不会混入下一轮测试。

`dropped` 是本采集器达到容量上限后丢弃的条数，不保证浏览器内部没有丢失事件。对单个 LoAF，`scriptsOmitted` 表示超出 16 条的脚本数。数据有界，避免诊断本身无限占用内存。

## 实际渲染负载

心跳中的 `renderers.scene.buffers` 分开记录最终输出画布、composer 主场景、文字遮挡深度、阴影目标的尺寸字段。渲染目标字段可能有小数，并非读取 GL 附件后的整数实测。最终画布的 2 倍文字分辨率不能被误读为全部场景以 4 倍像素渲染。透射记录配置比例；Three.js 私有透射目标没有可靠公共入口，`transmissionTarget` 为 null，不估算成实测值。帧数据同时保留所有 passes 的 draw calls/三角形数及几何、纹理、程序的数量。

场景快照只读取计数、实例批次和缓冲字段，避免每秒调用原来包含矩阵更新、遍历和内容信息的完整 `stats()`。它还记录准备队列、正在回位/移动的模型、自动扫描、相机位置状态及当前视图的实际质量配置。

GPU 使用 [EXT_disjoint_timer_query_webgl2](https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/)，每个上下文最多 12 个查询，复用且只在结果可用后读取。不调用 finish、flush、readPixels 来等待计时。主场景和模型查看器均覆盖；浏览器合成、其他程序与帧外离屏上传不在此 GPU 区间内。

这里没有整机 CPU/GPU 利用率、整卡显存、确切 GC 或浏览器 compositor trace。若新版日志仍出现“回调长空档，但页面/渲染工作都无法解释”，下一步需同宿主的 DevTools/Chromium trace，不应据此直接断言显卡不足。

## 数据与采集开销

不导出正文、问题、标题、来源 ID、输入文字、DOM 节点、完整 URL、错误消息或堆栈。脚本保留资源类别和数字位置；脚本与资源还可保留允许名单内的静态资产名；URL 比较开关限制在已知值。记录存于本地内存，由用户下载，无自动上传。

面板每秒更新一次，收起时跳过表格/曲线统计。逐帧、心跳和 observer 的开销有记录，但计时函数自身、分配/GC 和 GPU 驱动扰动不能被完全剥离。阶段插桩不增加渲染遍次，不调整性能档位。

## 验证和删除接点

专项测试：

```powershell
node --test test/rhine-performance.test.js test/deferred-preparation.test.js
.\node_modules\.bin\tsc.cmd -p tsconfig.rhine.json
.\node_modules\.bin\vite.cmd build --config vite.rhine.config.ts
```

真实浏览器验证脚本：`docs/verification/rhine-performance-panel/browser-probe.mjs`。可设置 `PRTS_PLAYWRIGHT_MODULE`、`PRTS_BROWSER_EXECUTABLE`、`PRTS_RHINE_PREVIEW_URL`、`PRTS_RHINE_PERF_OUTPUT`；Windows 使用正常 GPU 时设置 `PRTS_RHINE_TEST_HARDWARE=1`。默认软件渲染，仅用于功能验证；高成本软件渲染可能在完整流程前触发 120 秒采集时限。脚本会用此工作区的构建覆盖测试页的 JS/CSS，防止旧预览服务导致错误验证。不会修改用户已有浏览器页面。它包含人为阻塞、测试资料与可见性模拟，不应作为日常性能基线。

历史 v2 证据保存在 `work/performance-monitor-v2/`，本轮 v3 证据在 `work/performance-monitor-v3/`。专项测试覆盖实际回调/RAF 错位、分段求和、暂停/一次性绘制、查询异步/上限/失效/GPU 关闭、重启隔离、日志容量与去敏、后台队列监测失败隔离。

以后移除临时监控时，删除 `temporary-performance.ts`、`temporary-performance-observers.ts`、`temporary-performance-panel.ts`、`temporary-performance.css`，并只移除 scene/workbench/model-viewer 中的探针接点、original/scene 的 checkpoint/performanceState、DeferredPreparation 的可选 monitorTask。不要回退这些整份文件，里面有其他既有改动；重新构建皮肤包。

## v3 的开销控制与时间轴关联

实时面板每秒只读取最近 2 秒、最多 512 帧，计算 6 个显示指标；不再遍历全部历史或统计全部阶段。表格行和单元格只创建一次，文字变化时才更新；停止且 GPU 查询排空后停止刷新。完整的 24,000 帧容量及精确累计分位数保留在 JSON 导出路径。

`overhead`、`layoutShifts`、`uiWork` 的 `at` 是秒桶起点。`firstAt/lastAt/count/total/max/worstAt/worst` 分别记录真实首尾时间、次数、累计量、最大值及最大事件；`entries` 是观察器处理的原始条目数。耗时单位为 ms；布局偏移为无单位分值。超过或等于 8 ms 的 UI/监控事件还写入 `slowWork`，可精确匹配一次卡顿。不同 observer 类型及面板/心跳独立分桶，避免早期高频回调占满后半程容量。容量仍有界；实际超限会在 `dropped` 明示。

查看某次 `callbackIntervalMs` 尖峰时：

1. 用帧 `at` 与前帧结束点确定空档，核对 longTasks / LoAF / slowWork。
2. 用 `submissions` 看当时是主场景后处理、文字叠加还是查看器提交；`counters` 给出每帧的内容类别和数量。
3. 心跳 `renderers.scene.content.array` 给出实例批次、LOD、剔除和阴影保留量；`passes` 使用稳定名称，不再依赖压缩后的类名。查看器列出已启用部件。这里是场景提交/可见性配置，不是逐像素可见物体名单。
4. 用 `loads` 与 `uiWork` 检查同期资源加载、原生 IPC 资料请求、资料合并、报告或列表更新。嵌套跨度会重叠，不能把父子耗时相加。

`loads.id` 是页面内匿名递增编号，不是资料 ID。`at` 为本轮可观察到的开始，`endAt` 为完成时刻，`durationMs` 包含完整操作寿命。开始采集前已经在执行的请求以 `startedBeforeCapture/elapsedBeforeCaptureMs` 标明；尚未结束时 status 为 pending，停止后结束另标 `finishedAfterCapture`。跨轮采集的在途请求会在新轮中重新登记，不混入已经结束的旧工作。`initialLoading` 提供采样起点的在途请求和最近 64 次已完成的已知加载；不追溯页面全部历史。

模型的获取/解析与场景准备、装配/首帧准备分开记录；缓存模板再次装配时不会虚构一次 GLB 网络加载。静态资产名仅允许本项目模型、脚本、图片和 MiSans 字体，不输出任意 URL、查询参数、正文或输入。API 的完成状态表示响应结束，不等于后续 DOM/渲染已完成；DOM 更新有自己的跨度。

## 回归验证

`node --test test/rhine-performance.test.js test/deferred-preparation.test.js` 覆盖异步 GPU、跨轮采集、24,000 帧下的固定窗口读取、120 秒高频诊断与加载完成/失败/取消。真实浏览器检查位于 `docs/verification/rhine-performance-panel/browser-probe.mjs`；设置 `PRTS_RHINE_PERF_SOAK=1` 额外运行 120 秒面板展开采集。结果写入 `work/performance-monitor-v3/`，包含 JSON、浏览器检查结果及截图。浏览器操作测试会主动注入一次 85 ms 长任务；独立两分钟 idle 日志没有这次注入，不能混用两份数据判断自然卡顿。

## v3.1：宿主通知与 UI 更新

面板标题为 `性能诊断 / v3.1`，导出 schema 仍是 `rhine-render-capture/v3`。以 `metadata.diagnosticRevision === "host-ui-1"` 确认本轮改动已载入。

宿主 store 的普通通知合并到下一次 RAF；后台 RAF 暂停时使用 100 ms 定时器兜底。每次投递前比较界面实际使用的状态，忽略同一天内、仅修改会话更新时间的变化。标题、列表顺序、跨天日期、运行状态、模型可用性和错误仍参与比较。显式设置操作与刷新操作的开始、完成、失败保持同步投递。

宿主通知只刷新 Agent/宿主控件，不再连带刷新调查状态、工具活动和档案选择。档案选择根据可见内容跳过重复绘制，刻度按钮按资料身份复用，避免流式输出反复替换节点或丢失焦点。

开始/结束快照 `metadata`、`endMetadata` 以及心跳的 `workbench.state` 均包含以下计数。它们从对应控制器/界面创建时累计，**不是本次录制的计数**；分析本轮总量时取结束减开始，分析分段时取相邻心跳的差值。

| 字段 | 含义 |
| --- | --- |
| `hostBridge.notifications` | 收到的底层 store 通知次数 |
| `hostBridge.sources` | sessions / workspaces / session / models 四类通知计数 |
| `hostBridge.coalesced` | 已有待处理任务时合并掉的通知数 |
| `hostBridge.flushes` | 实际执行的状态比较次数，含显式操作的同步比较 |
| `hostBridge.stateReads` | 状态投影次数，含初始化、订阅和外部读取 |
| `hostBridge.emitted` / `deduplicated` | 显示状态发生变化的投递次数 / 状态未变而跳过的次数 |
| `hostBridge.pending` | 取样时是否还有合并任务等待执行 |
| `uiUpdates.status` | 完整调查状态更新次数 |
| `uiUpdates.host` | Agent 控件更新入口次数；调查快照和宿主通知都可触发 |
| `uiUpdates.selectionSkipped` | 档案可见内容未变而跳过绘制的次数 |
| `uiUpdates.ticksCreated` | 实际新建档案刻度按钮数 |

没有宿主桥接的纯预览页中 `hostBridge` 为 null。这些字段只保留计数，不导出会话名、资料 ID 或模型名称。

`diagnostics.uiWork` 新增 `host-notify`、`host-state-project`、`agent-controls`、`host-controls`、`tool-activity` 和 `archive-selection` 的秒桶。父子区间有重叠：`host-notify` 包括投影、比较和监听器投递；`agent-controls` 包括 `host-controls`；工具活动更新可能包括档案选择更新。**不能将父子耗时相加**。超过阈值的区间仍进入 `slowWork`。

回归命令：

```powershell
node --test test/rhine-host-notifications.test.js test/rhine-client.test.js test/rhine-tool-activity.test.js test/rhine-performance.test.js test/deferred-preparation.test.js test/rhine-model-pool.test.js
node docs/verification/rhine-performance-panel/browser-probe.mjs
node docs/verification/rhine-performance-panel/host-notifications-probe.mjs
```

最后一个脚本使用 `work/rhine-host-ui-20260917/` 中保存的修改前构建，对照 2,000 次显示内容未变的通知，并验证真实状态变化、流式答案、焦点、档案选择和销毁。它是针对重复通知的合成回归，不代表真实 Agent 工作负载的整体提速比例。结果和限制见该目录的 README。

## v3.2：答案更新与上游快照诊断

v3.2 的面板标题为 `性能诊断 / v3.2`，`metadata.diagnosticRevision` 为 `snapshot-ui-1`。schema 仍是 `rhine-render-capture/v3`；包含上一节的宿主去重字段。

每次 workbench 快照更新先比较内容。累计资料改变才执行资料合并；状态、工具、引用、阅读范围或答案有无改变时刷新状态界面。纯答案正文和记录正文更新继续送达打开的过程记录/报告。比较保留上次的值签名，覆盖原地修改、同长度改名、顺序、资料版本和会话切换，不依赖对象引用或数组长度。读取焦点的资料合并结果在资料输入变化前复用。

初始/结束 metadata、心跳 `workbench.state` 新增：

| 字段 | 含义 |
| --- | --- |
| `uiUpdates.sourceMerges` | 实际资料合并入口次数，包括手动收藏等本地更新 |
| `uiUpdates.sourceMergeSkipped` | 调查快照的累计资料未变而跳过合并的次数 |
| `uiUpdates.statusSkipped` | 状态显示未变而只更新打开的阅读面板的次数 |
| `snapshotBridge.counts` | 当前 React 控制器的上游快照各阶段累计执行次数；未接入时 snapshotBridge 为 null |

上述计数从对应对象创建时累计，分析本轮时取 endMetadata 减 metadata。React 控制器的计数可能早于打开皮肤开始累积；耗时只在当前采集启用时记录，关闭界面解除测量回调。上游日志不导出正文、问题、资料 ID 或调用参数。

`uiWork` 新增以下按秒聚合的同步耗时，>=8 ms 的跨度同时进入 `slowWork`：

| kind | 测量内容 |
| --- | --- |
| `snapshot-classify` | workbench 对资料和状态内容的比较 |
| `host-snapshot-selector` | useChat 选择器，包括构建与序列化 |
| `host-snapshot-build` | 从宿主节点构建调查快照 |
| `host-snapshot-serialize` | 快照 JSON 序列化 |
| `host-snapshot-derive` | React useMemo 派生，包括解析、资料合并及生命周期合成 |
| `host-snapshot-parse` | 已序列化快照的 JSON 解析；无序列化输入时包含空快照构建 |
| `host-snapshot-merge` | 与上一份累计资料合并 |

父子跨度不可相加：selector 包含 build/serialize；derive 包含 parse/merge；snapshot-update 包含 snapshot-classify 和实际发生的 UI 工作。这些测点仍不覆盖宿主进程、React 提交、浏览器全部合成或 Agent 后端网络请求，不能把剩余空档直接当作 GC 或某一函数耗时。

回归：`test/rhine-snapshot-updates.test.js`、`test/rhine-snapshot-diagnostics.test.js`。浏览器对照为 `docs/verification/rhine-performance-panel/snapshot-updates-probe.mjs`，使用环境配置的 Chrome、同样的 222 份合成资料与 500 次纯答案更新，保留 v3.1 构建作为基线；同时验证打开的记录面板、引用变化、工具错误、报告完成和原地会话重置。结果在 `work/rhine-snapshot-ui-20260917/`，不能用作真实 Agent 提速百分比。

宿主通知回归脚本支持 `PRTS_RHINE_HOST_OUTPUT` 指定结果目录，避免覆盖上一轮证据。完整浏览器流程继续使用 `PRTS_RHINE_PERF_OUTPUT`。


## v3.3：上游快照缓存

v3.3 的面板标题为 `性能诊断 / v3.3`，`metadata.diagnosticRevision` 为 `snapshot-cache-1`；schema 仍为 `rhine-render-capture/v3`。画质与档位不变。

新增 `host-snapshot-input`，记录输入内容核对的次数和耗时。`host-snapshot-selector` 包含 input，以及缓存失效时的 build/serialize；父子耗时不能相加。

- 输入没变时，build/serialize 均跳过。内容相等的新对象也可复用；原地修改、同长度文本修改仍触发更新。
- 输入变化时，复用未变化的工具/记录投影、累计资料、引用索引及历史引用结果。仅序列化改变的顶层字段。
- React 优先直接读取已经构建的快照。`host-snapshot-parse` 只统计旧签名回退/空输入，不再随每次答案更新执行。
- `host-snapshot-merge` 只在资料输入或会话改变时执行；`host-snapshot-derive` 仍负责正文和生命周期更新。
- metadata/endMetadata/心跳的 `snapshotBridge.cache` 包含 `input/tool/material/citation/serialize/sourceMerge` 各自的 `Hits` 与 `Misses`。它们是固定分类的累计整数，不包含正文、资料身份或宿主对象。分析采集区间时仍取结束减开始。
- `input` 一次计数对应一次 selector；`tool/material/citation` 对应缓存项目访问，包含子步骤，不等于工具调用次数；`serialize` 对应顶层字段，`sourceMerge` 对应 React 派生中的资料合并决定。
- 每个会话控制器有自己的缓存。投影缓存只保留当前可见历史实际使用的槽，移出历史的项在下一次构建时释放；不保存所有历次答案。

复测重点：静置/纯通知期间 `inputHits` 是否增加而 build 接近零；答案期间工具与资料 `Misses` 是否保持稳定，以及 input/build/derive 耗时是否下降。仍须保留切档 GPU 峰值与未归因长任务的检查，不把合成快照加速比例当作真实帧率提升。


## v3.4：完整部件列表与阴影提交分离

当前面板为 `性能诊断 / v3.4`，`metadata.diagnosticRevision` 为 `occlusion-submit-1`。保留 v3.3 的宿主缓存计数；schema 与性能档位不变。

阵列的上部螺丝、索引片、烘焙内构及基板也参与部件画外/保守遮挡判断。透明盖板仍不充当遮挡物。基板实例缓冲以主相机可见实例为前缀，剩余有效实例只在阴影绘制时使用；完整阴影列表不因主相机剔除而缩小。

逐帧 counters 新增：

| 字段 | 含义 |
| --- | --- |
| arrayCameraTrianglesPerPass | 当前阵列的主相机几何库存，单通道口径；不包含选中完整模型、归位模型、档案架、地面等 |
| arrayShadowTrianglesPerPass | 阵列全部有效投影基板的单通道几何库存；是否实际启用阴影同时查看 shadowEnabled |
| arrayShadowOnlyTrianglesPerPass | 保留在阴影列表、已从主相机列表省去的基板三角形，单通道口径 |

阵列隐藏时这三个逐帧字段均为 0。心跳 content.array 和 stats.arrayVisibility 包含对应的不带 array 前缀的字段，描述提交列表库存。batches 中投影批次的 count 现在表示主相机实例数，shadowCount 表示阴影实例数；shadowSlots 仍保留全部有效投影槽数。occlusion.parts 增加 trianglesPerInstance、submittedTrianglesPerPass，区分少量大部件与大量小部件。

这些库存不能直接相加当作整帧三角形：颜色/透射等通道可能重复提交同一批几何，阴影也可能有多个光源。整帧实际提交仍以 frames.triangles 和 submissions 为准。性能收益应比较同视角、同姿态和相同画质的实际 CPU/GPU 耗时。


## v3.5：光源视锥与不透明实体背面剔除

当前面板为 `性能诊断 / v3.5`，diagnosticRevision 为 `shadow-frustum-1`。画质配置和 schema 不变。

阵列基板的主相机和阴影矩阵分别预上传。阴影列表按投影光源视锥的并集筛选；只有在所有光源视锥外的基板才省去阴影提交，主相机外但光源内的投影物仍保留。阴影回调仅切换已经上传的矩阵绑定和实例数，随后恢复相机绑定；不额外增加绘制批次。相机列表和阴影列表不再有包含关系，不能用两者数量之差计算 shadowOnly。

逐帧新增 `arrayShadowCulledTrianglesPerPass`，表示相比全部有效阵列投影实例，光源视锥判断省去的单通道三角形库存。阵列隐藏时为 0。心跳 content.array 有对应的 `shadowCulledTrianglesPerPass`。`shadowSlots`、batches.shadowCount 和 `shadowTrianglesPerPass` 从 v3.5 起表示实际保留的阴影列表；`shadowOnlyTrianglesPerPass` 只计入阴影列表有而相机列表无的实例。是否实际绘制阴影仍结合 shadowEnabled，整帧实测仍看 frames.triangles。

心跳 content.backfaceCulling 和 stats.backfaceCulling 列出 full/array 启用背面剔除的表面类别。仅白名单且通过封闭性、绕序、法线方向检查的不透明实体启用；透明盖板、开放刻字/光学边缘及阵列螺丝 LOD 保留原设置。保留原 shadowSide，不随颜色材质的 side 改变投影方向。背面剔除不会减少 renderer.info 按索引数量计得的 triangles，需检查 GPU 时间。

输入复用曾做过隔离试验，正常场景的动画输入持续变化，750 帧无命中，因此本版不包含该缓存，也不导出 visibilityCache。证据与原因保留在 work/rhine-shadow-cull-20260918，不以静态单元测试命中率推断实时收益。

专项验证增加 test/opaque-backfaces.test.js；同姿态与原生 GPU 对照入口为 docs/verification/rhine-performance-panel/shadow-culling-probe.mjs 和 shadow-culling-timing-probe.mjs。结果在 work/rhine-shadow-cull-20260918。固定 RAF 的像素检查不能当作实际帧率测试。


## v3.6：程序预热与多方向档案内构

当前面板为 `性能诊断 / v3.6`，`diagnosticRevision=prewarm-views-1`，schema 和性能档位不变。

- `metadata/endMetadata.programPreparation` 与心跳 `renderers.scene.programPreparation` 按 `shelf-bake/shelf/workspace` 记录 `status/materials/programs/durationMs/compileMs/reflectionMs`。`durationMs` 是任务寿命，包含异步等待；`compileMs` 为复制与同步提交编译阶段；`reflectionMs` 只累计程序首次反射查询的同步区间，不能将它们当 GPU 绘制耗时。`programs` 为该准备任务引用的去重程序数，不是新增程序数。
- `status` 区分 `compiling/ready/unsupported/cancelled/failed`。`ready` 表示支持并行编译、完成链接检查及 Three.js 的首次 uniforms/attributes 反射；不支持 KHR 扩展时记录 `unsupported`，不声称已消除首次使用等待。
- `loads`/`initialLoading` 增加 `shader-preparation`（family）和 `shelf-view-bake`（view）跨度。后台准备队列仍分别记录同步部分和完整寿命。Shader 编译结果轮询有界、可取消；不调用 finish/flush/readPixels 等待着色器。内构烘焙沿用已有半浮点读取路径，每个方向单独排队。
- 初始/结束快照与心跳包含 `shelfInterior.views/viewCounts/totalTextureBytes/reasons`。`totalTextureBytes` 是共享烘焙纹理连同 mip 的估计，不是整卡显存；四方向共约 39.1 MiB，较原单方向增加约 27.0 MiB。
- 逐帧 counters 新增 `shelfGeometryFiles/shelfTextureFiles/shelfMotionFiles/shelfAngleFiles/shelfPreparedViews`。前四项描述挂载且 group.visible 的对象表示库存；不等于进入主相机、真实绘制或像素可见数量。实际提交仍看 calls/triangles/submissions。
- 静置档案按相对视角和原 2.5/3 像素滞回阈值选择表示；相机移动本身不再强制整架完整内构。选中/抽出/移动、误差越界和背面仍用完整几何。进入主视角阈值后优先回到原始方向，保持静置主视角一致。
- 三个附加方向在后台分别准备，支持页面销毁和 WebGL 上下文恢复；未完成的方向继续使用完整几何。恢复时补排缺失方向，不重复分配已有纹理。

实现的程序缓存适配基于项目锁定的 Three.js 0.183.2：使用其 program 对象进行完成后的 uniforms/attributes 反射。升级 Three.js 时应复测通道变体、资源释放和上下文恢复。

本轮验证与局限见 `work/rhine-prewarm-20260918/README.md`。冷启动的首次转场与热缓存下持续耗时分别测试；固定姿态截图不能当 FPS 基准。


## v3.7：GPU 通道、上传与视角回退诊断

面板版本 v3.7，metadata.diagnosticRevision=`render-detail-1`，JSON schema 继续使用 `rhine-render-capture/v3`，旧字段保持。

默认勾选「详细诊断（抽样）」：每 30 帧采一帧，切档、场景切换、详情开关、证据板全屏、自动切档及手工标记卡顿之后连续采 6 帧，标签内容更新也触发后续 6 帧采样；每次录制最多 1200 个详细帧。达到上限后继续普通记录，`dropped.detailFrames` 统计未采集的详细帧请求。没有暂停动画、改变画质或减少真实绘制。

### GPU 与实际绘制

- `frames[].gpuMode=whole` 保留原来的整帧查询；`segments` 在同一帧用顺序、互不重叠的查询替换整帧查询，`gpuMs` 是所有有效段的和。任何一段不支持、忙、失联或失效，整帧 GPU 数字保持 null，并保留各段状态。
- `gpuStages` 包含 update、scene-color、label-depth-copy、smaa、output、label-overlay；启用 SSAO/景深时会有对应段。查看器为 viewer-scene、viewer-smaa、viewer-output。实际禁用的通道不创建段。
- scene-color 内仍包含阴影和透射工作，尚未分出两个独立 GPU 查询；`drawFamilies.phase=shadow` 能单独统计阴影绘制的 calls/triangles。查询区间不能等同于独占 GPU 执行时间，也无法据此排除驱动同步或外部调度影响。
- `passWork` 是抽样通道的同步 CPU 时长与真实 calls/triangles，嵌套在已有 composer 阶段内，不能再次相加。`drawFamilies` 按 array/hero/shelf/moving/rack/board/other、受控部件名称、材质类别与通道汇总实际提交，不记录源文档身份。
- 每个详细帧最多保留 96 个绘制组，额外组写入 `counters.detailDrawGroupsDropped`。这不是像素遮挡判定；只统计真正进入 WebGL 提交路径的物体。
- `summary.gpuModes` 区分两种采样数量，`summary.gpuStages` 仅汇总有效段。比较旧日志或基准时应区分 whole 与 segments；分段查询会改变查询边界与驱动调度，不是与旧整帧计时完全等价的无扰动测量。

### 标签修改、上传与缓冲更新

- `diagnostics.resourceUpdates` 记录 `texture-dirty`（标签内容更新并标记 needsUpdate）与 `texture-upload-complete`（Three 已执行上传分支并回调 onUpdate）。通过本次采集内的匿名 texture 编号和 version 对应；后者记录所属帧和通道。
- dirty 包含 hero-label/moving-label/shelf-label、画布宽高、RGBA8 基础存储估算、是否生成 mipmap、改绘 CPU 时间。**不记录像素、标题、sourceId、地址或输入**。多次 dirty 可合并成一次上传，上传次数不等于 dirty 次数；过滤/各向异性等设置也可能改变 version。
- upload-complete 代表上传命令已提交到驱动路径，不代表 GPU 完成。真正的 GPU 区间看 gpuStages；不能把 onUpdate 的时间戳当成 GPU 完成时间。
- `frames[].glWork` 按当前区间与 GL 方法汇总调用次数、同步 CPU 时间、源字节/像素、缓冲分配字节。纹理上传与 mipmap 方法覆盖全部录制帧；bufferData/bufferSubData 只在详细帧记录。非详细帧的纹理操作归入 whole-frame，尚不能按通道拆解。
- 录制期间、帧外发生的纹理上传在 resourceUpdates 中记录为 gl-upload-outside-frame。动态内容上传不是新的资产下载，不能只从 resources/loads 判断是否发生。
- sourceBytes/sourcePixels 是传入对象的数据量或尺寸，不是测得的总线流量；allocationBytes 是申请存储量，不是上传量。纹理转换、压缩、mipmap、驱动副本等可能产生额外成本。
- resourceUpdates 上限 4000，texture onUpdate 关联最多 256 个纹理，多余项有 dropped 计数。纹理 dispose 时立即释放关联；停止、重开、销毁时恢复原 GL、pass、renderer 和 texture 回调，不长期保留诊断包装。

### 实际相机与背景几何回退

原 `movingCamera` 只表示跨场景 cameraTravel，不能代表详情相机已经静止。新增逐帧 `cameraActuallyMoving`、cameraTranslation（世界单位）、cameraRotationRadians、cameraFovDelta、cameraDetailBlend、cameraDetailTarget。首次有效样本作为位姿基线；下一帧起比较实际相机变换。暂停期间的位移不应解释成一个帧内速度。

心跳及首尾 metadata 的 `camera` 保留位置、四元数、FOV、详情混合值与 lift。`shelfInterior` 的详细快照增加：

- files：当前挂载且 group.visible 的每份档案的表示、回退原因、选用视角、预计像素误差、相机深度、相机在档案局部空间中的方向斜率；列表序号仅是该快照的顺序，不是文档 ID。
- directions：共享捕获方向；enterBelowPixels / leaveAbovePixels 保留原 2.5/3px 阈值。
- angleErrorMaxPixels / backFacing，以及逐帧 shelfAngleErrorMaxPixels / shelfBackFacing。

这些是表示选择与场景库存，仍可能包含视锥外对象；实际提交量以 drawFamilies、submissions 和 calls/triangles 为准。errorPixels=-1 表示无有限的正面视差估计。

### 开销与兼容

GPU 查询仍只读 AVAILABLE 后的结果，不调用 finish/flush/readPixels 进行测时，不嵌套 TIME_ELAPSED 查询。普通模式最多 12 个在途查询；详细模式最多 96 个。查询忙或不支持如实记录状态。

新增 `detailProbeMs` 估算分段边界与绘制/上传归类的记账开销，已纳入面板「逐帧采集开销」。它同时包含在 scene CPU 墙钟区间内，不能把它再加到 cpuMs；也无法完整测出 JIT、分配、GC、原生查询等间接扰动。关闭「详细诊断」可以保留旧整帧 GPU 计时进行对照；再关闭 GPU 计时可另测查询影响。

详细帧、通道汇总和资源事件会增加导出体积，采用抽样、容量上限和不采集正文控制成本。正常停止后所有包装应撤回，待完成查询只异步回读。


## v3.8：共享标签与详情正面代理（label-front-1）

保留固定性能配置、标签 1536×714 像素与原有采样质量。标签内容不可变，选中、归位、活动和档案架的材料引用同一内容纹理；改标题时换引用，不修改其他对象正在使用的图。缓存按内容与字体就绪状态区分，最多保留 6 张无引用的空闲纹理，活跃/池化对象持有的纹理不会被淘汰。当前列前后各两份标签通过原有延后队列准备，快速导航会替换过时的待准备任务；冷缓存、准备未结束时仍允许正常按需绘制。不是保证每个首次选择都零上传。

增加一个 (-0.30, 0.23, 1) 详情正面共享内构视角，总计 5 个。继续使用 2.5px 进入/3px 退出边界；运动、选中与不适用视角保持完整几何。这个视角覆盖详情驻留，转场中段仍可能回退。

新诊断字段：

- 心跳和场景 stats 的 `labelCache`：textures/active/idle/references/idleLimit、hits/misses/evictions、rgba8BaseBytes。字节是基础 RGBA8 像素估计，未含 mipmap、浏览器 Canvas 副本和驱动开销；active 也包括池化对象引用。
- resourceUpdates 的 `label-cache`：family、hit 和缓存计数，既包含正常绑定，也包含邻档准备查找；不记录内容键、标题或 sourceId。纹理 dirty 额外记实际 anisotropy/minFilter/magFilter。
- backgroundWork 的 `label-prefetch`：预取的同步 CPU 区间；其上传命令如果位于渲染回调之外，会在既有 gl-upload-outside-frame 中出现。异步 GPU 完成不由这个 CPU 区间表示。
- `interactionSummary` 将所有 Event Timing 按秒和事件类别聚合，保留数量、最大值和最慢样本。原 interactions 通道只保留 interactionId>0 或 duration≥48ms 的明细，避免 hover 等无交互编号的低延迟记录占满容量。汇总 duration 相加不是主线程占用量，也不能与明细相加。
- UI 工作的最慢样本及 slowWork 增加 spanId/parentId，标识同步父子关系，不能将嵌套耗时重复相加。重新开始录制会重置关联状态。
- 详细诊断开启时，≥8ms 的 UI 工作及 longtask 写入 `rhine:<类别>` User Timing measure，随后清理浏览器条目，方便与 DevTools Performance / CDP trace 对齐。JSON 仍不包含 JS/GC 调用栈，空的 long-animation-frame scripts 不能靠这些标记补出；需要同时录浏览器 trace。

性能比较必须包含预取的回调外工作、冷/热缓存以及整个开关详情过程；不能只观察切档首帧或详情稳定端点后宣称所有卡顿消失。


## v3.9 / report-label-1

- 标签预加载维持最多 6 张闲置纹理。候选按同列 ±1、相邻列记忆位置、同列 ±2 排序，重复/空列去重；候选优先于刚释放的旧标签保留。使用中纹理仍不受闲置 LRU 淘汰。
- `archive-navigation.detail` 新增 `method`（step/source/scene-pick/slot）、fromLane/fromRow 与 targetLane/targetRow，step 另有 axis/direction，scene-pick 有 rowDelta。数值为当前目录位置，不包含文档标题或 ID。
- `label-prefetch-state` 用 plan/slot 关联 queued、started、cancelled、failed；`label-prefetch-submitted` 表示 renderer.initTexture 返回，不表示 GPU 已执行完。lookup 的 use 区分 bind/prefetch/share，cacheEntry 为场景生命周期内的匿名整数。
- `label-cache` 新增 prepared、candidate、fontStatus，以及未命中时的 missReason（not-resident/evicted）与 previousEntry。只保留最近 32 次淘汰的内部关联；未查到历史不能证明从未存在。`label-cache-evict` 给出 cacheEntry 和容量原因。
- texture-dirty 与 texture-upload-complete 可携带 cacheEntry。录制中命中已有缓存也会安装 upload 观察钩子，所以重建 GPU 上下文的重新上传不要求先产生 texture-dirty。字体状态仍参与缓存键。prepared 只表示当前上下文提交过预加载，恢复时失效并重新排队。
- 心跳 labelCache 新增 candidates/protectedIdle；idleLimit 仍为 6。lookup 快照发生在绑定/trim 之前，单条事件可能暂时显示 idle=7，应以心跳或淘汰后的统计判断常驻上限。
- 报告完整打开区间为 report-open，内部 report-show/report-focus 覆盖面板显示与焦点引起的布局；不能只用 renderReport 的下降代表整个点击任务。其他报告分项：report-scroll-read/write、report-header、report-markdown、report-body-patch、report-toc、report-references、report-position-read/write。准备隐藏报告包含在 capture 中，不算已阅读。renderReport 父区间包含同步子区间，不能再次累加；延后布局区间独立发生于 RAF。
- 完成的正文可在隐藏面板预先准备；打开时优先复用。报告 DOM 读写分批，滚动位置按 RAF 合并，目录坐标考虑舞台缩放，暂停、会话切换和销毁取消相应任务。
- drawFamilies.part 单独保留 Case_Engraving、Case_Engraving_Highlight 和 Printed_Label；其余未知名称仍归 other。此版本没有修改雕刻几何或内部代理视角，面数变化不能归因于新的几何剔除。


## v3.10 / pointer-reader-1

- 标签候选仍最多 6 项，闲置缓存仍最多 6 张。鼠标悬停和指针按下的实际 cell 通过同一个目标映射供预加载与点击使用；按下再确认可覆盖相机缓动和触屏。预加载任务仍在 RAF 之后的独立任务提交，按目标去重与取消，不增加逐帧拾取。
- `label-prefetch-state` 和对应 lookup/submitted 新增 `intent`（row/lane/pointer/activity）；queued 的 lane/row/offset 表示实际预测目标。没有足够提前量的快速点击或目标再次变化仍可按需加载，不能据此保证所有导航零上传。
- 自动活动提前准备已知目标，启动时复核纹理准备状态；未就绪时暂缓启动，500 ms 后允许常规路径兜底，避免准备失败阻止活动。`label-prefetch-fallback` 的 intent=activity、reason=deadline 表示这一兜底。候选替换不会淘汰有活动引用的纹理。
- `label-cache.prepared` 在本版本表示纹理已通过显式 initTexture 或天然渲染提交；onUpdate 与捕获钩子串联，上下文恢复时一起失效。仍不表示 GPU 已完成执行。此语义比 v3.9 仅表示显式预加载更完整。
- `archive-pointer-pick` 记录原有悬停/释放拾取同步 CPU；`archive-pointer-press` 记录新增按下确认。可在真实 Trace 的 User Timing 中关联达到慢阈值的调用，不包含任何资料内容。
- `reader-open` 是调用打开入口至首个异步等待前的同步段，不包含 API 等待；`reader-focus` 单列入场焦点工作。`reader-dom` 仍有 lines/append 元数据，下分 reader-build、reader-annotations、reader-body-patch。范围未变化时复用标注按钮、仅标注新增行；更新已读范围仍作用于全部现存行并保留节点和选区。
- 初次命中行定位由 reader-position-read / reader-position-write 单列，在后续 RAF 读取几何并按可视缩放换算。关闭、切换来源/会话、销毁或用户滚轮/按键/按下取消定位；暂时隐藏后在恢复时继续。父子同步段不可重复相加。
- backgroundWork 的 `reader-present` 从响应后的正文构建开始，至首次定位提交（无需定位时为构建结束）结束，是异步历时，包含等候帧/暂停时间，不能当 CPU 耗时；取消时 succeeded=false 不等于读取失败。比较阅读器总成本时应同时检查原有同步段、分离出的定位段以及浏览器 Layout/Recalc，不能只对比变短的 reader-dom。
