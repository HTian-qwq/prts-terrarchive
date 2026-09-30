---
name: prts-composition
description: 在创造模式中组合 PRTS 检索、调查、证据板工具与任意 DSH 工具，创建或修改自定义模式。
---

# 组合 PRTS 工具

用户决定使用哪些能力。PRTS 工具不要求模式名是 `prts`，也不要求使用 PRTS 皮肤。保留用户选择的终端、文件、子 Agent、计划等工具；不要为了搭载资料检索把模式缩减成检索专用模式。所有工具继续服从宿主的工作区、权限和审批设置。

## 工具入口

已安装的 `prts-terrarchive` bundle 提供宿主资料管理和默认 PRTS 模式。以下两行可以加入任意 Agent 预设的插件列表：

```yaml
- id: prts-corpus
  name: prts-terrarchive/tools
  config:
    enabledGames: [arknights, endfield]
    cloud:
      baseUrl: https://prts.chat
      game: all
- id: prts-retrieval-skill
  name: prts-terrarchive/skill
  config:
    enabledGames: [arknights, endfield]
```

`prts-terrarchive/tools` 只加载 Agent 工具，不注册设置页或 HTTP 路由。沿用主插件的语料路径、共享设置和调查存储。包含本地的 `corpus_search`、`corpus_read`、`corpus_i18n`、`timeline_search`，云端启用时的 `cloud_search`、`cloud_inspect`，以及调查工具 `investigation_get/open/stage/update/publish`。本地语料和终末地语言附件需要用户安装；云端工具由 PRTS 资料设置控制。

`prts-terrarchive/skill` 注册 `prts-retrieval` 和 `prts-investigation` 使用指导。若基础模式没有 `@deepseek-ai/dsh-tool-skill`，补上一个 skill loader；已有时不要重复添加。网页工具是独立的 `@deepseek-ai/dsh-tool-web`，不是 PRTS 工具入口的一部分，可按用户需要组合。

同一模式内不要同时加载 `prts-terrarchive/tools` 和 `registerTools: true` 的 `prts-terrarchive`，否则会重复注册工具。宿主现有 `registerTools: false` 的管理实例应保留。

## 当前 DSH：创建或修改模式

先加载宿主的 `editing-cordis-compositions` 指导，按其 bundle 安装和验证流程操作。以用户选择的现有预设为基础，保留其完整 plugins 列表和 isolate 分组，再加入上述两行；不能只写扩展行就宣称继承了标准模式。不要在 profile 根层注册这些 Agent 工具，也不要改写 npm 包或 app.asar。

默认 PRTS 模式在启用时读取当前宿主的 standard 声明，继承其工具、条件和隔离组，再加入 PRTS 工具。要完全自定义 PRTS 模式，用一个用户 bundle 覆盖现有注册项：

```yaml
- id: prts-preset-seed
  name: prts-terrarchive/presets
  config:
    plugins:
      # 放入用户确认的完整插件列表；这是整体替换，不是追加。
```

不要新增另一个 id 为 prts 的预设；不同名称的自定义模式使用宿主原生 `@deepseek-ai/dsh-agent-preset` 声明。模式内工具启停可通过 Cordis entry 的 disabled 字段控制。

默认 PRTS 继承在插件启用或宿主重启时读取标准声明；修改 standard 后需要重启以同步默认 PRTS。显式配置 plugins 后完全由用户拥有，不会自动补回删除的工具。旧会话保留原预设版本，在新会话验证修改。

## 旧版 DSH

旧版使用 `$DSH_HOME/.agent-presets/<id>/agent.cordis.yml` 和 `preset.yml`。先按宿主旧版的预设创建流程复制所选模式，再把上面的两个插件 entry 加入组合。不要向旧版添加新版才有的插件名。默认 PRTS 会复制该宿主自己的 standard 组合；有用户改动或没有生成标记的既有文件不会被自动覆盖。

## 验证

检查预设没有加载诊断，再在新会话核对工具清单：所选基础工具仍在，PRTS 工具只出现一次，普通模式未被添加资料工具。用本地资料检索验证工具执行，用调查工具验证会话隔离；没有语料时应明确提示安装。禁用或卸载相关 bundle 后应移除对应贡献。不要为了通过检查修改宿主权限或填入凭据。
