# 临时渲染性能面板

刷新 4177 预览或 DSH 中的莱茵界面，右下角打开「性能测试 · 临时」，选择 30 / 60 / 120 秒并开始。收起面板仍采样；停止后等待 GPU 回读完成即可导出 JSON。无需控制台，无数据上传。开始新测试会替换上一份内存记录，请先导出需要保留的记录。

推荐分别保存三次记录：阵列静止与滚动、检索时资料出现与抽出、档案架翻页与 360° 查看器。先预热再开始可比较持续压力；测首次出现的卡顿时，在操作前开始即可，采样不会自动剔除长帧。

- 帧间隔：真实 RAF 时间戳差，保留长帧，显示平均、P95、最高值以及超过 33.34 / 50 ms 的次数。最近 2 秒 FPS 为有效间隔总时长对应的回调频率，不是屏幕呈现 FPS。首次回调、不同渲染器和后台/未激活边界不制造跨越暂停的长帧。测试总时长为墙钟时间，暂停不会延长自动停止时限。
- CPU：从场景更新到同步 WebGL 提交完成的墙钟耗时，包含 LOD/遮挡更新、模型运动和界面跟随回调；不是 CPU 占用率。异步任务和渲染回调之外的工作不计入这一栏。
- GPU：整个场景更新中提交的 GL 命令，含阴影、透射、SMAA 等所有渲染遍次。360° 查看器的独立 WebGL 上下文也接入。CPU/GPU 可重叠，不能相加。浏览器合成、其他程序的 GPU 工作及帧回调之外的离屏准备/上传不属于此 GPU 计时范围。
- 页面长任务：PerformanceObserver 记录页面主线程至少 50 ms 的任务，补充观察异步模型准备、DOM 更新等帧外阻塞；它可能与 CPU 帧样本重叠。并不直接把每次长任务归因为模型创建。
- 绘制次数/三角形：每个场景帧所有渲染遍次的提交量，不是去重后的模型面数。几何、纹理、着色程序均为资源数量，不是显存字节；浏览器无法在此面板提供整卡占用率。

GPU 使用 [Khronos 的 EXT_disjoint_timer_query_webgl2 接口](https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/)；仅在查询可用后读取纳秒结果。不使用 `finish`、`flush` 或 `readPixels` 等待完成，每个上下文最多 12 个查询并复用。没有扩展/有效计时位数时显示不支持；遇到 disjoint、上下文丢失、队列满或回读超时，明确记录状态，缺失值不会填成 0。停止后最多等 5 秒，不把旧测试的回读放进新测试。

导出含逐帧数据、按场景状态的统计、长任务时间点、资料数量更新事件、分辨率变化、画质、优化比较开关及渲染器信息，不包含正文、问题、标题或来源 ID。软件渲染器会标注；GPU 型号是否可见受浏览器限制。应在同一设备、窗口大小、画质及类似工作负载下比较。混合场景的累计均值请结合 `byState` 和逐帧数据阅读。

面板每秒更新两次，最多 24,000 个帧样本和 120 秒；关闭且停止后没有面板计时器，采样关闭时不创建 GPU 查询。测量本身仍有开销，收起面板可减少表格与曲线刷新。

测试包含 GPU 异步结果、查询复用/上限、无效计时、外部查询冲突、暂停边界、丢帧保留、重启隔离和资源清理；浏览器脚本在 `docs/verification/rhine-performance-panel/browser-probe.mjs`，使用真实 RAF 与完整 GL 绘制。服务器 SwiftShader 数据仅用于功能验证，不代表用户显卡速度。

测试结束后的删除位置：

1. 删除 `ui/rhine/temporary-performance.ts`、`temporary-performance-panel.ts`、`temporary-performance.css`。
2. 去掉 `workbench.ts` 中 `performancePanel` 的创建、传递和生命周期调用，查看器更新的第二个时间戳参数；去掉 `types.ts` 的 `performanceProbe` 选项。
3. 去掉 `scene.ts` 中 `performanceProbe` / `unregisterPerformance` 接点以及包围原有帧体的测量 `try/finally`。去掉 `original/model-viewer.ts` 同名接点，并把 `updateFrame` 内容恢复到 `update`。
4. 删除临时测试/文档或按需保留证据，运行 `npm run build:rhine`。不要回退上述整份文件，里面还有用户之前的 LOD 与外观改动。

接点以 `TEMPORARY RHINE PROFILER` 标注。此次也修复了 360° 查看器从后台返回后没有恢复 RAF 的问题；该 `viewerVisibility` 处理可保留，与测量模块没有依赖。
