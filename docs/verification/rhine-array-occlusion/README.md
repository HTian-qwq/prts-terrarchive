# 阵列动态部件剔除验证

2026-09-12。实现与结果说明见 [rhine-array-occlusion.md](../../rhine-array-occlusion.md)。基线是本轮开始时的插件版本，已包含阵列内构贴图、螺丝 LOD、架上静止贴图，不是 RhineLabUI 原版。

- `baseline/`、`after/`：10 个状态的实际截图、原始 renderer 统计、完整阵列矩阵及镜头、300 个运动状态记录。原始记录中的 `/tmp/` 截图路径保留运行时来源，同名截图已归档。
- `baseline-rhine.js`：本轮之前的生产包，SHA-256 `8cce641b006cd4851e2a34ec64964675c76d92db2adea5fea2055d649c404876`。
- `sources.json`：12 份资料的只读本地预览输入，只在独立浏览器 context 中替换预览 fixture，不写会话数据。
- `browser-probe.mjs`：验证脚本，只将 fixture 和基线包位置改为归档路径；交互与断言逻辑和原始运行相同。
- `comparison.json`、`compare.py`：截图 RGB 比较与前后提交量。页脚时钟单独排除，中央 ROI 不能代替整页；两类指标均记录。
- `cpu.json`、`cpu-probe.mjs`、`cpu-layouts.json`、`baseline-array-visibility.ts`：局部 CPU 微基准与输入。布局来自网格优化中间版本记录的同一实际姿态，保留该包哈希；算法用最终源码，恢复低模滞回状态。盒体代理只复现真实包围盒，不用于计算 GPU 三角形数。

浏览器使用 Chromium + SwiftShader、DPR 1、50 ms 虚拟 RAF。每种状态推进 72 个中间状态时跳过 GL draw，随后真实绘制 3 帧。前两个视角使用 reduced motion 固定姿态，之后恢复正常运动，检查聚焦末项、抽出、归位、复原、竖屏、返回阵列、连续滚动与跨列。运动期间的模型完整性逐帧检查，但没有真实绘制并截图全部中间帧。计时不能用于推断真实显卡帧率。

在插件目录、4177 预览已运行且保留当前生产包时可重放（浏览器及 Playwright 路径使用本机现有安装）：

```sh
.node22/bin/node docs/verification/rhine-array-occlusion/browser-probe.mjs baseline
.node22/bin/node docs/verification/rhine-array-occlusion/browser-probe.mjs after
.node22/bin/node docs/verification/rhine-array-occlusion/cpu-probe.mjs
python3 docs/verification/rhine-array-occlusion/compare.py
```

浏览器重放默认写 `/tmp/rhine-array-occlusion-replay-{baseline,after}`，避免覆盖归档。可设置 `PRTS_RHINE_PREVIEW_URL`、`PRTS_RHINE_LOD_OUTPUT`；CPU 重放默认写 `/tmp/rhine-occlusion-cpu-replay.json`，可设置 `PRTS_RHINE_CPU_OUTPUT`。`compare.py` 比较已归档截图，依赖 Pillow 和 NumPy。

最终浏览器加载包：1,024,028 字节，SHA-256 `7df7dc2b02d3c0b9837a51cce4652c7d5908a975f1064668ff5cdc665a3844e5`。模型主体、画质参数和材质本轮没有改变。
