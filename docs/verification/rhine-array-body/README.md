# 阵列主体优化验证

本轮基线已含前一轮部件遮挡剔除、内构贴图、架上贴图及螺丝低模。实施说明和统计见 [rhine-array-body.md](../../rhine-array-body.md)。

- `baseline/`：前一轮归档中的相同 10 个视角，生产包哈希 `7df7dc2b02d3c0b9837a51cce4652c7d5908a975f1064668ff5cdc665a3844e5`；对应 `baseline-rhine.js`。
- `after/`：最终生产包的同样 10 个视角、阵列矩阵、相机、绘制统计及 300 个运动状态。原始记录保留运行时 `/tmp/` 路径，同名截图已归档。
- `body-only/`：只做主体分区时的两张实际截图，用于单独核对几何分区的画面影响。它不包含后续细字贴图和螺丝外圈改动。
- `comparison.json`、`compare.py`：最终方案与基线的相同姿态对照。除页脚时钟区域外保留全部像素差异，包括细字及螺丝细节的变化；不以平均差异很小宣称每个像素都一致。
- `cpu.json`、`cpu-probe.mjs`、`cpu-layouts.json`：静态局部 CPU 基准，包含视锥、LOD、遮挡和矩阵压缩，无 GL 绘制。布局采自移除重复角点计算前的同一几何版本，保留其来源哈希；测量调用最终算法，旧算法由两个 `baseline-array-*.ts` 文件提供。
- `proof-equivalence.mjs`、`proof-equivalence.json`：旧角点投影证明与最终平面支撑证明在 10 个场景、54,530 组部件／槽位上的等价检查。包含当前未提交的组合，不能把此计数当作实际渲染部件数。
- `browser-probe.mjs`、`sources.json`：浏览器验证及相同的只读 12 份资料 fixture。仅在独立浏览器 context 中替换预览输入，不写真实会话。

浏览器使用 Chromium + SwiftShader、1920×1080、DPR 1，另测 900×1200。采用 50 ms 虚拟 RAF，推进中间状态时跳过 draw，每个检查端点真实绘制三帧。初始阵列和架上固定姿态使用 reduced motion，之后恢复正常运动并检查抽出／归位仍使用完整实体、停止后恢复架上贴图、全过程复用模型。不是硬件 GPU 帧率测试，也没有截图验证全部动画中间帧。

插件目录中可重放，浏览器及 Playwright 使用脚本所列本机安装路径，需有 4177 预览：

```sh
.node22/bin/node docs/verification/rhine-array-body/browser-probe.mjs baseline
.node22/bin/node docs/verification/rhine-array-body/browser-probe.mjs after
.node22/bin/node docs/verification/rhine-array-body/cpu-probe.mjs
.node22/bin/node docs/verification/rhine-array-body/proof-equivalence.mjs
python3 docs/verification/rhine-array-body/compare.py
```

浏览器重放默认写 `/tmp/rhine-array-body-replay-{baseline,after}`，可用 `PRTS_RHINE_PREVIEW_URL`、`PRTS_RHINE_LOD_OUTPUT` 覆盖；CPU 重放默认写 `/tmp/rhine-body-cpu-replay.json`，可用 `PRTS_RHINE_CPU_OUTPUT` 覆盖。Python 比较依赖 Pillow 和 NumPy，默认比较已归档图像。
