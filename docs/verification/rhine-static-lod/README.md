# 静止贴图与 LOD 验证

`baseline/` 是本轮修改前固定性能画质的插件，`after/` 是最终构建。两组的来源、镜头、虚拟时间和尺寸一致；不是与 RhineLabUI 原版比较。`comparison.json` 汇总提交量、像素差异和检查结果。各组 `stats.json` 包含完整渲染统计、资源数量和运动轨迹。

`rack-front.png` 是浏览器原生截图裁切，没有缩放、锐化或修改颜色。其他 PNG 为整页截图。`baseline-rhine.js` 保留基线构建；最终生产脚本在 `lib/rhine/rhine.js`，哈希记录于统计文件。CSS 本轮未改，SHA256 为 `80d98c438c2b655c0f5ec1bdc8cbece750b31b97d55dd0f456856e012ea30b23`。

本机已有 4177 只读预览时，从插件根目录可复现：

```sh
node docs/verification/rhine-static-lod/rhine-lod-quality.mjs baseline
node docs/verification/rhine-static-lod/rhine-lod-quality.mjs after
```

脚本使用本机已安装的 Playwright/Chromium；可通过 `PRTS_RHINE_PREVIEW_URL` 和 `PRTS_RHINE_LOD_OUTPUT` 改预览地址、输出目录。资料 fixture 仅注入隔离浏览器页面，读取使用预览现有只读 API，不修改会话或资料库。

为使 SwiftShader 对照可完成，中间 72 个状态帧跳过 GL 绘制，随后每个状态实际绘制三帧并截图。聚焦、抽出和归位仍执行正常动画状态更新；因此轨迹验证表示切换时机，端点验证实际图像，不用于声称所有中间帧的硬件流畅度或 FPS。初始化烘焙实际绘制并读回。

初版阴影偏暗的诊断图保留在本次工作机器的 `/tmp/rhine-lod-quality-shadow0/`，正式证据仅收入最终版本。
