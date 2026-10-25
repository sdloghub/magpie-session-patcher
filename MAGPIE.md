# Magpie 插件：第一阶段

原 fork 仓库保留 Python CLI、Web UI 和提示词安装器；独立插件仓库仅分发适配层。 `magpie-session-patcher` 是独立的纯 JS 请求中间件，不需要 Python、Node 服务、API Key 或额外模型调用。

它只处理经过 Magpie 的出站请求：可替换历史助手拒绝文字、按条件移除旧推理、追加你提供的提示词。不会读取或写入客户端会话文件，不修改当前模型的流式或非流式回复，不自动重试或继续执行任务。

## 安装与启用

推荐从 GitHub 安装：

```sh
magpie plugin add github:sdloghub/magpie-session-patcher
```

在 Magpie 的 Plugins → Discover → Unofficial, on GitHub 搜索 `magpie-session-patcher`。该收录入口要求公开、非 fork 仓库与 `magpie-plugin` topic；GitHub 与 Magpie 索引存在缓存延迟。尚未发布 npm 包或提交官方社区列表。

在本目录执行（也可在 Magpie 的插件页添加这个目录的绝对路径）：

```sh
magpie plugin add .
```

**默认不处理任何请求**。在 Plugins → Installed → 本插件 → Options 保存以下设置即可启用：

```json
{
  "enabled": true,
  "replaceRefusals": true,
  "cleanReasoning": false,
  "appendPrompt": "",
  "detection": "conservative",
  "customKeywords": [],
  "agents": [],
  "models": []
}
```

或使用命令行：

```sh
magpie plugin options "$PWD" '{"enabled":true,"replaceRefusals":true,"cleanReasoning":false,"appendPrompt":""}'
```

命令在安装时的同一目录执行；本地安装使用目录的绝对路径标识插件，而不是 npm 包名。只有请求本来就在走 Magpie 网关时才生效。本插件不修改客户端的连接配置。通过本地路径添加后，保留此目录，不要移动它。

## 设置

| 选项 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `false` | 必须明确设为 `true` 才处理请求 |
| `replaceRefusals` | `true` | 替换历史助手消息中的匹配文字 |
| `replacement` | 英文过滤标记 | 可自定义替换文字；空值使用默认值 |
| `cleanReasoning` | `false` | 尝试清理可独立删除的历史推理；有依赖时保留 |
| `appendPrompt` | `""` | 追加自定义系统提示词；空值不注入 |
| `detection` | `"conservative"` | 保守模式；`"legacy"` 使用原项目强短语全文匹配、弱关键词前 150 字符匹配 |
| `customKeywords` | `[]` | 自定义全文匹配关键词，忽略大小写；会增加误报可能 |
| `agents` | `[]` | 客户端 ID 精确匹配；空数组不限客户端。身份缺失时不匹配非空列表 |
| `models` | `[]` | 进入钩子时模型名称的前缀匹配；空数组不限模型 |

无效布尔值、作用范围类型或检测模式会让整次请求直通，不会扩大处理范围。客户端与模型限制同时满足才生效。首次使用建议通过 `models` 限定到一个测试模型前缀，再根据实际请求确认客户端 ID。规则作用于路由前的模型名称，不代表 fallback 后的最终供应商。

默认替换文字是：

```text
[History filter: the previous assistant text was replaced. This is not evidence of any action or result.]
```

替换只发生在发给模型的历史里，明确说明其为过滤标记，避免伪造已经执行的工作。界面仍显示原始回复；下一次请求若再次携带原历史，会再次处理。匹配消息有多段普通文字时合并检测，并用一段替换文字替代这些文字块；图片、工具块等其他内容保留。被替换文字的旧引用标注会清空。

保守检测只匹配以明确拒绝用语开头的助手文字，可忽略开头的道歉；不把道歉本身、代码示例或普通引用中的拒绝短语作为条件。它仍是启发式规则，可能误报或漏报，不证明用户意图或授权状态。

## 协议与推理边界

| 协议 | 历史文字 | 可选旧推理处理 |
|---|---|---|
| Responses | `input` 中助手 message 的字符串、`text` / `output_text` 块 | 仅纯消息与 reasoning 历史移除 reasoning；有原生工具条目时保留 |
| Chat Completions | 助手 `messages[].content` | 有非空正文且无工具调用时删除 `reasoning` / `reasoning_content` |
| Anthropic Messages | 助手 text 块 | 无工具调用时移除 thinking / redacted_thinking；若会造成空消息则保留 |
| Gemini | `contents` 中 model 的普通 text parts | 无函数调用时移除 thought parts；若会造成空消息则保留；带签名普通文字不替换 |

不改用户输入、工具结果、工具参数、工具声明、`call_id` / 工具 ID、模型、流式设置、推理预算，以及其他未知业务字段。不请求删除当前生成的推理；Responses 的 `include`、`store` 等保持原样。

Responses 遇到 `previous_response_id`、`conversation`、`item_reference`、加密 compaction、compaction 路径或未知的加密顶层历史条目时，**整次请求直通，包括不追加提示词**，不假装已经清理不可见的服务器历史。也不解密任何记录。协议原生的显式 refusal 块暂不转换，只处理普通文本回复。

追加提示词保留原有系统／开发者指令，不安装原项目的 CTF 模板，也不覆盖内置指令。相同提示词已存在时不重复追加。请求经服务器引用恢复历史时，网关无法看到的内容不在处理范围内。

## 停用

在插件页关闭插件，或把 `enabled` 设为 `false`。停用后立即恢复原请求行为；本插件没有改写本地历史，因此没有需要恢复的会话备份。

## 验证与后续阶段

```sh
npm test
npm pack --dry-run
```

测试使用虚构请求，覆盖四种协议、误判边界、工具配对、推理依赖、未知字段、作用范围与重复处理。不产生收费模型请求。

2026-10-25 验证结果：

- Node.js 24.21.0：30 项测试通过。
- Magpie 0.1.1490：隔离配置下成功加载 `onRequest`，加载失败计数为 0。
- 实际 Magpie 网关连接本机模拟上游：Chat 非流式、Chat SSE 流式、Responses 非流式、Anthropic 非流式、Gemini 客户端非流式共五条链路通过（Gemini 客户端请求由宿主转换为上游 Chat）。上游收到的历史已处理；返回给客户端的当前拒绝回复文字保持原文。
- 未调用真实模型，未在用户日常 Magpie 配置中安装。

宿主复验脚本为 `scripts/magpie-smoke.mjs`，使用独立临时配置和模拟服务；需要本机端口权限。针对本次 Magpie 使用的 Bun 1.4.2，可复用已有运行时，避免下载：

```sh
MAGPIE_TEST_BUN=/path/to/magpie-bun node scripts/magpie-smoke.mjs
```

不传 `MAGPIE_TEST_BUN` 时由 Magpie 下载其所需运行时。脚本仅复制指定二进制，不读取账号凭据，也不修改原来的运行时。

第一阶段不包含 AI 改写、当前回复替换、自动重试、本地会话修复和管理页面。以后加入 AI 改写应使用异步请求钩子或配套服务，不能在轻量中间件里直接访问网络。

接口参考：[Magpie middleware](https://usemagpie.ai/docs/plugins#middleware)。原版 README 保存在 `docs/UPSTREAM_README.md`；来源说明见 `NOTICE`。
