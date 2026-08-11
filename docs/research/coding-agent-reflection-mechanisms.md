# Coding agent 的 reflection / dream / memory consolidation 机制

> 调研日期：2026-08-11
> 证据范围：仅使用产品方官方文档、官方仓库和官方发布记录。一些网络文章声称 Claude Code 内部存在名为 `autoDream` 的实现，但没有可核验的一手公开资料，因此本文不把这些说法当作事实。

## 结论先行

公开的一手机制里，最接近“dream”的不是 Claude Code，而是 **Gemini CLI Auto Memory**：它在新会话启动时异步扫描已闲置的历史会话，从重复信号中生成 memory patch 或 `SKILL.md` 草案，放入项目级 inbox，经用户逐项批准后才进入活跃记忆。它把“反思”设计成一个**离线候选生成器**，而不是一个可以直接重写长期记忆的自治代理。[Gemini CLI Auto Memory](https://geminicli.com/docs/cli/auto-memory/)

**MiMo Code 则确实把机制正式命名为 Dream。** `/dream` 由一个隐藏的独立 agent 读取本机 SQLite 原始轨迹和 memory 文件，直接合并、去重、验证并改写项目 `MEMORY.md`，也可以把明确跨项目的偏好写入 `global/MEMORY.md`。它比 Claude Code 更像周期性 consolidation，比 Gemini 更直接：没有 candidate inbox 或逐项批准。官方发布页称其“每 7 天自动触发”，但截至本文核验的源码，`dream.auto` 默认是 `false`；准确说法应是“可配置为新顶层 session 启动时检查，默认间隔 7 天”。[官方发布说明](https://mimo.mi.com/docs/en-US/news/latest/mimocode)；[配置源码](https://github.com/XiaomiMiMo/MiMo-Code/blob/a106676f7f8fa252dc8a50ac8a1fa892a4a36a0c/packages/opencode/src/config/config.ts#L357-L367)

Claude Code 当前公开的核心是另一种更轻的组合：模型在正常工作中按需写 auto memory；`MEMORY.md` 的小索引在每次会话启动和 compaction 后重新注入，topic 文件按需读取；上下文接近上限时再做 conversation compaction。官方资料并未说明有一个定时或跨会话批处理的 “Dream/AutoDream” 阶段。[Claude Code memory](https://code.claude.com/docs/en/memory)；[Claude Code context window](https://code.claude.com/docs/en/context-window)

GitHub Copilot Memory 提供了最值得借鉴的**事实可信度机制**：仓库级记忆携带代码引用，召回时对当前分支重新验证，只有验证通过才使用；长期未使用的事实或偏好在 28 天后自动删除。[GitHub Copilot Memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory)

因此，一个简洁而有效的实现不需要“梦境阶段”本身很复杂。更关键的结构是：

1. 原始轨迹保持可审计；
2. reflection 只产出候选，不直接改变行为；
3. 候选带来源、作用域、时效和预期用途；
4. 在真正召回时做相关性与有效性验证；
5. 只有很小的稳定索引常驻上下文，其余按需取用。

上面五点是本文基于各产品公开设计做出的**综合推断**，不是任何一家产品方的原文结论。

## 统一对比

| 产品 / 机制 | 触发时机 | 输入 | 产物 | 持久化 | 注入上下文 | 质量 / 安全门控 | 成本控制 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code auto memory | 正常会话中，Claude 判断某条信息对未来有用时写入；也可由用户明确要求记住 | 当前会话中的纠正、偏好、构建命令、调试或架构信息 | `MEMORY.md` 索引及可选 topic Markdown | 默认按 Git 仓库存于本机；同一 repo 的 worktree 共享，跨机器不共享 | 每次会话启动加载 `MEMORY.md` 前 200 行或 25KB；topic 文件按需读；compaction 后索引从磁盘重新注入 | 可关闭；workspace 自定义路径受 trust gate；用户可查看、编辑、删除；超过索引限制时写入成功但返回错误要求重写 | 小索引硬上限、topic 按需加载、path-scoped rules、prompt caching、自动 compaction；单独 memory 写入成本未公开 | [Memory](https://code.claude.com/docs/en/memory)，[Context window](https://code.claude.com/docs/en/context-window) |
| Claude Code conversation compaction | 上下文接近窗口上限时自动触发，或用户运行 `/compact` / 配置 `/autocompact` | 当前对话历史 | 结构化摘要，替换原对话历史 | 保留在当前 session 轨迹中；不是跨 session 长期知识库 | compaction 后重新注入根 `CLAUDE.md`、unscoped rules 和 auto memory；路径规则/嵌套指令待再次命中 | 用户可用 focus 指令指定摘要重点；它解决上下文容量，不等于长期学习 | 触发阈值可配置；摘要压缩历史；大读取可下放 subagent 隔离 | [Context window](https://code.claude.com/docs/en/context-window) |
| Gemini CLI Auto Memory（实验） | 新会话启动时后台运行；只处理闲置至少 3 小时、至少 10 条用户消息的非活跃、非 trivial、非 sub-agent session；有锁和节流 | 本机历史 transcript 索引，并按需读取疑似有长期价值的 session | unified diff memory patch、`SKILL.md` 草案、skill update patch | 候选先保存在项目级 inbox；批准后写到私有项目记忆、个人全局记忆或 user/workspace skill | 候选本身不加载；批准后的 memory 写入底层 Markdown 并立即 reload，skill 下次会话发现 | 默认“证据不强则不产物”；不能直接改活跃 memory/settings/credential/项目 `GEMINI.md`；目标 allowlist、patch parse/dry-run、原子应用；用户逐项批准；提示词要求 secret redaction | 后台不阻塞 UI、不占 interactive turns；使用 preview Gemini Flash；有 session 门槛、processed-state、锁和节流；具体账单/token 上限未公开 | [Auto Memory](https://geminicli.com/docs/cli/auto-memory/)，[Memory files](https://geminicli.com/docs/tools/memory/) |
| MiMo Code Dream | 手动 `/dream`；自动模式在新顶层 session 首轮检查，需显式开启，默认最小间隔 7 天，首次还要求项目年龄达到间隔；进程内另有 10 秒 spawn gap | 默认查看最近 7 天（历史不足则全量）的本机 SQLite 会话轨迹，加项目/全局/session memory；具体检索和采样由 Dream agent 自主查询，无确定性 turn 上限 | 直接合并、改写、删除 `MEMORY.md` 条目；项目事实进入 project memory，明确跨项目的偏好/习惯可进入 global memory；workflow 只提示交给 `/distill` | Markdown 位于本机数据目录，SQLite FTS5 建索引；不是 candidate/inbox | 主要在 checkpoint context rebuild 时预算化注入：project 10k tokens、global 6k、memory keys 500 默认上限；也可通过 memory search 按需读取 | 原始轨迹被声明为 source of truth，要求保留 session id、验证路径/符号、无法验证则标记；但直接写入且无逐项审批/patch preview；写入路径有 sandbox，`memory.disable_write` 可总停写 | 自动 Dream 复用触发它的当前会话模型，无专用便宜模型；7 天窗口和 200 行/10KB 软目标控制规模，独立调用的账单/token 上限未公开 | [README](https://github.com/XiaomiMiMo/MiMo-Code/blob/a106676f7f8fa252dc8a50ac8a1fa892a4a36a0c/README.md#L128-L143)，[Dream prompt](https://github.com/XiaomiMiMo/MiMo-Code/blob/a106676f7f8fa252dc8a50ac8a1fa892a4a36a0c/packages/opencode/src/agent/prompt/dream.txt)，[scheduler](https://github.com/XiaomiMiMo/MiMo-Code/blob/a106676f7f8fa252dc8a50ac8a1fa892a4a36a0c/packages/opencode/src/session/auto-dream.ts) |
| GitHub Copilot Memory（public preview） | 仅由开启 Memory 的用户所发起的 Copilot 活动触发；仓库事实只有具备 write access 的用户活动才能创建 | Copilot 在仓库活动中发现的代码事实，以及用户明确或隐含的偏好 | 带代码引用的 repo fact；可能带用户原话引用的 preference | repo fact 对有权访问该 repo memory 的用户可用；preference 绑定用户与当前 billing entity；跨 Copilot cloud agent、code review、CLI 复用 | 当前工作相关时检索；repo fact 在当前分支重新验证后才使用；code review 只用 repo fact，不用个人 preference | write-access gate、repo scope、用户/管理员可查看删除；召回时引用验证；未使用 28 天自动删除，成功验证使用可重置计时 | 相关召回而非常驻全文，加 28 天 TTL；官方未公开 memory 的独立 token/费用模型 | [Copilot Memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory) |
| Cursor Memories（官方旧版文档） | sidecar 模型在对话中被动观察并提取；或 agent 因用户明确要求/判断重要而调用记忆工具 | chat conversation | project-scoped、可跨 session 使用的自动规则 | 项目级；可在 Settings → Rules 管理 | 作为 rules 在未来 agent context 中使用 | sidecar 生成的候选需用户批准后保存 | sidecar 的模型与费用策略未公开 | [Cursor Memories](https://docs.cursor.com/en/context/memories) |
| Devin Desktop / 原 Windsurf Cascade Memories | 对话中模型发现值得保留的上下文时自动生成，或用户明确要求创建 | 当前对话 | workspace-scoped memory；更稳定知识建议升级为 Rule 或 `AGENTS.md` | 本机 `~/.codeium/windsurf/memories/`，不进入 repo、不同 workspace 不共享 | 当 Cascade 判断相关时检索；Rules 另有 always-on、model-decision、glob、manual 四种注入方式 | memory 可查看编辑；官方建议可靠、可共享知识不要依赖自动 memory，而写入版本化 rules/`AGENTS.md` | 官方明确自动 memory 的创建与使用不消耗 credits；Rules 可按描述、glob 或手动按需加载 | [Cascade Memories](https://docs.devin.ai/desktop/cascade/memories) |

## 逐项事实与边界

### 1. Claude Code：在线记忆维护 + 上下文压缩，不是已公开的“离线梦境”

**明确事实**

- 每个 session 从新 context window 开始。`CLAUDE.md` 是人写的持久指令，auto memory 是 Claude 自己积累的 learnings/patterns；两者都会在每次对话启动时加载，但都是上下文而非强制配置。[官方 memory 文档](https://code.claude.com/docs/en/memory)
- Auto memory 默认开启。Claude 并非每个 session 都写，而是判断信息未来是否有用；用户也可以明确要求它记住某件事。[官方 memory 文档](https://code.claude.com/docs/en/memory)
- 每个 Git repo 映射到本机 memory 目录，worktree 共享。`MEMORY.md` 是简短入口；其前 200 行或 25KB 常驻，topic 文件通过普通文件工具按需读取。写后会检查索引长度，超限时要求 Claude 重写，但写操作本身不会被回滚。[官方 memory 文档](https://code.claude.com/docs/en/memory)
- Memory 文件是普通 Markdown，用户可以检查、编辑和删除。包含 frontmatter 的文件在后续写入时会记录 ISO 8601 `modified` 时间。[官方 memory 文档](https://code.claude.com/docs/en/memory)
- Auto memory 不会自动进入普通 subagent；fork 因继承父上下文而例外。自定义 subagent 可以拥有独立的 `user`、`project` 或 `local` memory 目录，且其 system prompt 会包含该目录 `MEMORY.md` 的前 200 行或 25KB。[官方 subagent 文档](https://code.claude.com/docs/en/sub-agents)
- Conversation compaction 是另一条管线：当 context 接近上限时，历史被结构化摘要替代；根指令和 auto memory 从磁盘重新注入，按路径触发的规则则等下次命中文件时再载入。[官方 context window 文档](https://code.claude.com/docs/en/context-window)

**官方没有说明的部分**

- 官方 memory、context-window、subagent 文档及 changelog 没有描述一个名为 Dream/AutoDream 的定时跨 session consolidation job，也没有公开类似“24 小时 + N 个 session”的触发门槛。因此不能用一手资料确认网上流传的 AutoDream 具体实现。[官方 memory 文档](https://code.claude.com/docs/en/memory)；[官方 changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- 官方没有公开 auto memory 候选评分、去重算法、独立模型调用或逐项成本。可确认的门控只有模型自行判断、索引大小检查、用户审计/编辑，以及存储路径的 workspace trust。

**推断**

- Claude Code 的设计倾向于让“学习”成为普通 agent loop 内的一种低摩擦文件写入，而不是独立批处理。优点是简单和即时；风险是写入时缺少独立证据审查，且常驻索引里的错误信息可能反复影响后续 session。
- `modified` 只说明何时最后写入，不等于事实仍然有效。若业务判断有明显时效性，仅靠修改时间不足以构成 staleness gate。

### 2. Gemini CLI：最完整、最可审计的 dream-like 管线

**明确事实**

- Auto Memory 是实验功能，默认关闭。它在 session startup 启动后台任务，不阻塞 UI，也不消耗 interactive turns。[官方 Auto Memory 文档](https://geminicli.com/docs/cli/auto-memory/)
- Eligibility 是确定性的：session 至少闲置 3 小时且至少 10 条用户消息；活跃、trivial 和 sub-agent session 被忽略。锁文件防多实例并发，state 文件记录已处理版本，并有 launch 节流。[官方 Auto Memory 文档](https://geminicli.com/docs/cli/auto-memory/)
- Extraction agent 扫描本机 transcript 索引，只读取看起来含 durable memory 或重复 procedural workflow 的会话；证据不强时默认不生成任何 artifact。[官方 Auto Memory 文档](https://geminicli.com/docs/cli/auto-memory/)
- 输出不是直接写入 memory，而是 memory `.patch`、新 `SKILL.md` 或 skill update patch。它们留在项目 inbox，用户可以查看全文/diff、apply/promote/dismiss/discard。[官方 Auto Memory 文档](https://geminicli.com/docs/cli/auto-memory/)
- 后台 agent 无权直接修改 active memory、settings、credentials 或项目 `GEMINI.md`。Memory patch 必须命中 allowlist，skill patch 会 parse 和 dry-run，批准后才原子应用。[官方 Auto Memory 文档](https://geminicli.com/docs/cli/auto-memory/)
- 分析会把选中的本机 transcript 内容发送给配置模型；提取 agent 被要求清除 secrets/tokens/credentials，且不得照搬大型 tool output。候选未批准前不会注入任何 session。[官方 Auto Memory 文档](https://geminicli.com/docs/cli/auto-memory/)
- 提取默认使用 preview Gemini Flash；官方没有给出专属预算或费用上限。[官方 Auto Memory 文档](https://geminicli.com/docs/cli/auto-memory/)

**推断**

- 这是目前公开实现中“提取”和“激活”边界最干净的方案。它把不确定的 LLM 判断限制在 proposal 阶段，把真正改变未来行为的动作交给确定性的 patch validator 和人类批准。
- 最小 session 长度、闲置时间、processed-state 和锁，比按固定 cron 运行更贴近实际信号密度，也避免频繁对短对话付费。
- 主要代价是 inbox 容易堆积；若每个候选都要求人工细审，长期会产生 review fatigue。产品需要批量驳回、相似项合并和“为何值得保存”的短解释。

### 3. MiMo Code：官方 Dream 是“直接改写记忆的周期性维护 agent”

本节核验对象是小米官方仓库 [`XiaomiMiMo/MiMo-Code`](https://github.com/XiaomiMiMo/MiMo-Code)，不是 MiMo 模型本身，也不是社区封装。源码基准为 `a106676f7f8fa252dc8a50ac8a1fa892a4a36a0c`（2026-08-10）。

**明确事实**

- MiMo Code 确实有官方名为 Dream 的机制。`/dream` 绑定隐藏的 native `dream` subagent；README 将它定义为扫描近期会话、把持久知识提取进 project memory 并移除过时项。[命令注册](https://github.com/XiaomiMiMo/MiMo-Code/blob/a106676f7f8fa252dc8a50ac8a1fa892a4a36a0c/packages/opencode/src/command/index.ts#L130-L146)；[agent 定义](https://github.com/XiaomiMiMo/MiMo-Code/blob/a106676f7f8fa252dc8a50ac8a1fa892a4a36a0c/packages/opencode/src/agent/agent.ts#L374-L411)；[README](https://github.com/XiaomiMiMo/MiMo-Code/blob/a106676f7f8fa252dc8a50ac8a1fa892a4a36a0c/README.md#L343-L346)
- 手动 `/dream` 随时可运行。自动模式只在新顶层 session 的第一步检查，异步创建题为 `Auto Dream` 的独立 session，并复用触发该检查的当前 provider/model；执行是 detached、fire-and-forget。[启动接线](https://github.com/XiaomiMiMo/MiMo-Code/blob/a106676f7f8fa252dc8a50ac8a1fa892a4a36a0c/packages/opencode/src/session/prompt.ts#L3398-L3420)
- 自动 Dream **默认关闭**：只有 `dream.auto === true` 才触发；默认最小间隔为 7 天，`interval_days=0` 可令每个新 session 都触发。首次自动运行还要求最早顶层 session 已至少存在一个 interval；之后以最近题为 `Auto Dream` 的 session 创建时间判断间隔，并有进程内 10 秒 spawn gap。关闭 memory 写入也会跳过自动 Dream。[配置](https://github.com/XiaomiMiMo/MiMo-Code/blob/a106676f7f8fa252dc8a50ac8a1fa892a4a36a0c/packages/opencode/src/config/config.ts#L342-L367)；[调度实现](https://github.com/XiaomiMiMo/MiMo-Code/blob/a106676f7f8fa252dc8a50ac8a1fa892a4a36a0c/packages/opencode/src/session/auto-dream.ts#L10-L126)
- 因此，官方发布页所说“每 7 天自动触发”不能理解成开箱即开的现状；它与当前源码的 `Default: false` 存在口径差异。7 天是启用自动模式后的默认间隔。[官方发布页](https://mimo.mi.com/docs/en-US/news/latest/mimocode)；[当前配置源码](https://github.com/XiaomiMiMo/MiMo-Code/blob/a106676f7f8fa252dc8a50ac8a1fa892a4a36a0c/packages/opencode/src/config/config.ts#L357-L365)
- Dream 的两个来源是本机 `mimocode.db` 原始轨迹和 `<DATA>/memory/` 下的 Markdown。prompt 把原始轨迹定为 source of truth，默认回看最近 7 天或更短的全部历史；要求先查看 project `MEMORY.md`、当前 `notes.md`、近期 checkpoints，再通过只读 SQLite 查询验证候选。候选提升标准是明确用户陈述、清晰设计决策或跨 session 重复证据。[Dream prompt：来源与窗口](https://github.com/XiaomiMiMo/MiMo-Code/blob/a106676f7f8fa252dc8a50ac8a1fa892a4a36a0c/packages/opencode/src/agent/prompt/dream.txt#L1-L68)；[验证标准](https://github.com/XiaomiMiMo/MiMo-Code/blob/a106676f7f8fa252dc8a50ac8a1fa892a4a36a0c/packages/opencode/src/agent/prompt/dream.txt#L69-L105)
- 轨迹选择不是一个确定性的 eligibility/cursor pipeline：源码没有规定最少 turn、idle 时长、每批 session/turn 硬上限、逐条 disposition 或 processed watermark；Dream agent 自己用 SQLite 搜索并决定深入哪些 session。`last 7 days`、优先 recent/repeated、不要穷举所有文件，均是 prompt 指令而非 runtime 强制截断。[Dream prompt](https://github.com/XiaomiMiMo/MiMo-Code/blob/a106676f7f8fa252dc8a50ac8a1fa892a4a36a0c/packages/opencode/src/agent/prompt/dream.txt#L8-L68)；这是对当前源码的审阅结论。
- Dream 不生成 inbox candidate，而是直接编辑 active memory：合并重复项、更新或删除矛盾/过时项，并建议将 `MEMORY.md` 控制在 200 行、10KB。条目应带 source session id；路径和符号需再次核验，无法核验但合理的主张标 `[unverified]`。项目事实写 project `MEMORY.md`；明确跨项目的用户偏好/习惯可以写 `global/MEMORY.md`。[Dream prompt：目标与修剪](https://github.com/XiaomiMiMo/MiMo-Code/blob/a106676f7f8fa252dc8a50ac8a1fa892a4a36a0c/packages/opencode/src/agent/prompt/dream.txt#L18-L28)；[合并与验证](https://github.com/XiaomiMiMo/MiMo-Code/blob/a106676f7f8fa252dc8a50ac8a1fa892a4a36a0c/packages/opencode/src/agent/prompt/dream.txt#L106-L155)
- Skill、subagent、command 不属于 Dream 产物；重复工作流最多留一句提示，真正打包由独立 `/distill` 负责。这是一个比“所有反思都叫 memory”更清楚的产品边界。[Dream prompt](https://github.com/XiaomiMiMo/MiMo-Code/blob/a106676f7f8fa252dc8a50ac8a1fa892a4a36a0c/packages/opencode/src/agent/prompt/dream.txt#L97-L105)；[README](https://github.com/XiaomiMiMo/MiMo-Code/blob/a106676f7f8fa252dc8a50ac8a1fa892a4a36a0c/README.md#L343-L346)
- 持久化 memory 是本机 Markdown，并通过 SQLite FTS5 搜索。正常工作中的 `checkpoint-writer` 会持续维护 session `checkpoint.md`、project `MEMORY.md`、`notes.md` 和 task progress；Dream 是在这些增量产物与 raw trajectory 之上的低频二次 consolidation，不替代 checkpoint writer。[README](https://github.com/XiaomiMiMo/MiMo-Code/blob/a106676f7f8fa252dc8a50ac8a1fa892a4a36a0c/README.md#L128-L143)；[checkpoint writer 写入路径](https://github.com/XiaomiMiMo/MiMo-Code/blob/a106676f7f8fa252dc8a50ac8a1fa892a4a36a0c/packages/opencode/src/session/checkpoint.ts#L680-L724)
- 未来上下文不是简单“每次启动全文注入”。当 checkpoint rebuild 发生时，project memory 默认最多 10k tokens、global memory 6k、memory keys 索引 500，另有 checkpoint 11k、notes 6k 等独立预算；project/global 正文进入重建上下文，其余 scope-filtered key 只注入路径索引并可按需搜索。[预算配置](https://github.com/XiaomiMiMo/MiMo-Code/blob/a106676f7f8fa252dc8a50ac8a1fa892a4a36a0c/packages/opencode/src/config/config.ts#L285-L325)；[预算化读取](https://github.com/XiaomiMiMo/MiMo-Code/blob/a106676f7f8fa252dc8a50ac8a1fa892a4a36a0c/packages/opencode/src/session/checkpoint.ts#L1263-L1300)；[注入与 keys index](https://github.com/XiaomiMiMo/MiMo-Code/blob/a106676f7f8fa252dc8a50ac8a1fa892a4a36a0c/packages/opencode/src/session/checkpoint.ts#L1423-L1489)
- 没有逐项用户审批、diff preview 或提交前 stale/hash 检查。Dream 的 `write/edit/apply_patch` 已获允许，system agent 的权限询问是 non-interactive；统一写入 gate 把 Dream/Distill 限制在 memory tree 或项目 `.mimocode/`，但源码注释明确 `bash` 不受该写路径 sandbox 覆盖，只依靠 prompt discipline。用户可用 `memory.disable_write: true` 停止所有新 memory 和自动 Dream/Distill，既有 memory 不删除且仍可搜索。[权限](https://github.com/XiaomiMiMo/MiMo-Code/blob/a106676f7f8fa252dc8a50ac8a1fa892a4a36a0c/packages/opencode/src/agent/agent.ts#L374-L411)；[非交互 ask](https://github.com/XiaomiMiMo/MiMo-Code/blob/a106676f7f8fa252dc8a50ac8a1fa892a4a36a0c/packages/opencode/src/agent/config.ts#L27-L50)；[写入 sandbox](https://github.com/XiaomiMiMo/MiMo-Code/blob/a106676f7f8fa252dc8a50ac8a1fa892a4a36a0c/packages/opencode/src/tool/memory-path-guard.ts#L7-L56)；[`disable_write`](https://github.com/XiaomiMiMo/MiMo-Code/releases/tag/v0.1.11)

**官方未说明 / 当前源码未提供**

- 没有看到专门的 secret/credential redaction pass、敏感字段分类或送模前脱敏规则。Dream 会让所选 provider/model读取本机轨迹内容；具体哪些内容被模型查询取决于 agent 的 SQL/文件读取。不能据此断言它会上传“全部数据库”，也不能声称已有系统级 secret 过滤。
- 没有公开 Dream 专属 token/费用上限、失败重试策略、质量评测、召回帮助率、TTL 或自动过期政策。自动 Dream 使用当前 session 的模型，而非像 Gemini Auto Memory 那样固定一个较便宜的后台模型。[模型复用接线](https://github.com/XiaomiMiMo/MiMo-Code/blob/a106676f7f8fa252dc8a50ac8a1fa892a4a36a0c/packages/opencode/src/session/prompt.ts#L3400-L3419)
- prompt 要求在 consolidation 时验证路径/符号并删除 obsolete entry，但没有 Copilot 式“每次召回时针对当前 branch 重验 citation”的确定性机制；session id 也只是文本约定，不是结构化引用完整性约束。

**与 VC Agent 的关键差异与启示**

- 横向看，MiMo 比 Claude Code 多了正式的跨 session consolidation pass；比 Gemini CLI 少了 candidate inbox、patch validator 与人工批准；比 Copilot 少了召回时 citation revalidation 和 TTL。它最强的是低概念数与直接闭环，最弱的是 activation gate 与可证明的 freshness/coverage。
- MiMo Code 的极简来自“模型直接维护一个短文件”：无 proposal、无 review state machine、无两阶段 reflection。VC Agent 的投资判断更高风险，不宜照搬静默直写；但可以借鉴其**一个 Dream agent + 一个明确产物 + 一个硬体积预算**的表面心智，把证据隔离、stale check 和 commit gate 藏在内部。
- MiMo 的 `checkpoint-writer -> Dream -> rebuild/search` 三层职责很值得借鉴：前者只做高频增量留痕，Dream 低频去重压缩，runtime 预算化召回。VC Agent 当前 Reflection、trajectory candidate、Dream extraction 若职责重叠，可收敛为“捕获器只留 evidence pointer，Dream 只归并 candidate，Memory runtime 只召回/重验”。
- MiMo 没有 deterministic coverage，因此其“最近 7 天由 agent 自主浏览”很简洁，却不能证明没有漏掉某条轨迹。VC Agent 应保留逐 source `adopted / dismissed / carried_over` 和 cutoff invariant；UI 无需暴露这些内部状态。
- MiMo 把 workflow packaging 分给 `/distill`，说明“事实/判断记忆”和“可执行技能”最好分开。VC Agent 可对应拆成 `Memory` 与 `Playbook/Rule`，不要让一次 reflection 直接产生所有类型的长期资产。
- MiMo 的 200 行/10KB 软上限和 rebuild 分区 token budget 比无限累积更优雅。VC Agent 可增加每种 memory scope 的固定注入预算和 overflow-to-index，而不是只依赖 relevance ranking。
- MiMo 暴露的 `memory.disable_write` 是一个非常清晰的总控。VC Agent 可提供同样简单的“只读记忆模式”：暂停 candidate 生成和 commit，但保留显式 recall/inspection；同时保留比 MiMo 更强的用户审批和召回时验证。

### 4. GitHub Copilot：把门控放到“召回时验证”

**明确事实**

- Copilot Memory 保存 repository-level facts 和 user-level preferences。Repo facts 可以跨 cloud agent、code review、CLI 使用；个人偏好不会进入 code review。[官方文档](https://docs.github.com/en/copilot/concepts/agents/copilot-memory)
- Repo fact 附有指向代码的 citations。系统在该事实与当前工作相关时，对当前 branch 重新检查引用，只使用验证仍成立的 facts。[官方文档](https://docs.github.com/en/copilot/concepts/agents/copilot-memory)
- Repo fact 只有在开启 Memory 且具备 repo write access 的用户发起活动后才会创建，并严格限制在同一 repo 使用。个人 preference 只用于同一用户后续交互，并与当时的 billing entity 绑定。[官方文档](https://docs.github.com/en/copilot/concepts/agents/copilot-memory)
- 用户和 repo owner 可以审查、删除相应记忆；Business/Enterprise 管理员可以导出或删除个人偏好。未使用的 fact/preference 28 天后自动删除，成功验证并使用可能重置计时。[官方文档](https://docs.github.com/en/copilot/concepts/agents/copilot-memory)

**推断**

- 对 coding agent，最有价值的不一定是更强的离线 reflection，而是“每个事实都带可重放证据，并在当前代码状态上重新验证”。这直接解决 branch 漂移、未合并 PR 和代码演化导致的陈旧记忆。
- 28 天 TTL 是低复杂度的垃圾回收办法，但不适合所有业务事实；更通用的做法是按记忆类型定义 TTL 或 invalidation key。

### 5. Cursor 与 Devin Desktop：轻量自动提取 + 相关性召回

**明确事实**

- Cursor 的旧版官方 Memories 文档称，另一个 sidecar model 被动观察 chat 并自动提取 project-scoped memories；后台生成的 memory 需要用户批准才保存。Agent 也可通过工具在用户明确要求或判断信息重要时直接创建。[Cursor 官方旧版文档 URL](https://docs.cursor.com/en/context/memories)
- 该 Cursor URL 目前已重定向到新版 docs 首页，因此上述说明应视为**历史产品行为**，不能假设当前版本仍完全相同。
- Devin Desktop（原 Windsurf Cascade）会在会话中自动生成 workspace memory，本机保存，相关时自动检索，不跨 workspace，也不进入 repo。官方明确建议：需要可靠复用或团队共享的内容，应升级成版本控制内的 Rule 或 `AGENTS.md`，而不是依赖自动 memory。[官方文档](https://docs.devin.ai/desktop/cascade/memories)
- Devin Rules 把注入成本显式化为四种模式：always-on 全文每轮注入；model-decision 只常驻 description、正文按需读；glob 在文件命中时加载；manual 仅 `@mention` 时加载。官方称自动 memory 创建和使用不消耗 credits。[官方文档](https://docs.devin.ai/desktop/cascade/memories)

**推断**

- Cursor sidecar 的优点是主 agent 不必在每轮承担“要不要记忆”的额外分类提示；缺点是如果 sidecar 持续观察完整对话，隐藏成本和数据流更难解释。
- Devin 的关键产品洞察不是提取算法，而是明确区分“偶发事实 memory”和“可靠、共享、版本化 rule”。这能防止 memory 演化成第二套隐式系统提示。

## 对简洁设计最有价值的可迁移原则

以下均为基于上述事实的**设计建议/推断**。

### A. 将 reflection 定义为候选生成，不定义为直接学习

最小闭环可以只有四个状态：

`raw signal -> candidate -> active -> stale/superseded`

- `raw signal` 是不可变来源指针，不复制整段 transcript；
- `candidate` 可以自动生成，但不进入运行时上下文；
- `active` 必须经过明确 gate；
- `stale/superseded` 不物理抹去历史，而是停止召回。

Gemini 的 inbox/patch 说明这条边界可以既安全又易解释；Copilot 的 citations 则说明 active 之后仍需召回时验证。

### B. 不要让 reflection、compaction、rules 和 personalization 共用一种产物

- **Compaction**：只保证同一条任务轨迹能继续，生命周期跟 session 走；
- **Memory**：保存未来可能有用的事实或决策，带来源和时效；
- **Rule**：稳定行为约束，应由人或明确授权写入，最好版本化；
- **Skill**：重复多步骤程序，按需激活；
- **Personalization**：跨项目的用户偏好，必须与项目事实隔离。

Claude、Gemini、Copilot、Devin 都以不同方式体现了这些边界。把它们合成同一种“reflection outcome”会让召回、审批和失效规则变得复杂。

### C. 质量控制采用“两次门控”，不用复杂的单次总评分

建议只保留两个问题：

1. **写入门控**：是否有足够重复或明确证据，值得成为 candidate/active memory？
2. **召回门控**：它对当前任务是否相关，且来源在当前状态下是否仍成立？

Gemini 强在写入门控，Copilot 强在召回门控。比起给每条 reflection 维护多维综合分，这两个离散 gate 更易测、更易解释。

### D. 常驻上下文只放“小索引”，正文全部按需

可采用与 Claude `MEMORY.md`、Devin `model_decision` rule 类似的结构：常驻项只含 `id / one-line claim / scope / source pointer / freshness`，正文和证据按需加载。对 VC agent，长期记忆尤其不应把整段投委会讨论或材料摘要永久塞进每轮 prompt。

### E. 成本控制优先使用确定性 eligibility

在调用反思模型前先执行便宜条件：

- 距离上次处理的新增有效 turn 数；
- session 是否已结束/闲置；
- 是否存在明确纠正、重复失败、决策变更或结果反馈；
- 同一 source version 是否已处理；
- 同一 project 是否已有运行中的 consolidation lock。

Gemini 的 idle/length/state/lock 组合表明，大多数无价值运行可以在模型调用前排除。对信号稀疏的个人 VC agent，这通常比固定每日 dream 更省且更符合用户心智。

### F. 安全上让“自动降权/失效”比“自动重写真相”更容易

自动系统可以安全地：标记 stale、降低召回优先级、合并重复 candidate、建议 supersede。它不应轻易静默覆盖带来源的历史判断，尤其是投资 thesis、人物评价或跨项目学习。Copilot 的引用验证和 TTL、Gemini 的 staged patch 都支持这一方向。

## 建议用于产品评审的最小验收问题

1. 任意一条 active memory 能否在两步内看到原始证据？
2. 源代码、项目材料或用户结论变化后，它是否会在召回时失效，而不是继续污染上下文？
3. Reflection 模型失败、超时或生成空结果时，主任务是否完全不受影响？
4. 同一 transcript 是否能保证幂等处理，且多进程不会重复 consolidation？
5. 未经批准的 candidate 是否绝不进入 runtime prompt？
6. 用户能否一眼区分：事实、偏好、rule、skill、session summary？
7. 常驻 memory 索引是否有硬 token/字节预算，以及超限后的确定性行为？
8. 能否统计“被召回且有帮助 / 被召回但无效 / 从未召回”的记忆，以支持清理，而不是只统计生成数量？

## 资料清单

- Anthropic: [How Claude remembers your project](https://code.claude.com/docs/en/memory)
- Anthropic: [Explore the context window](https://code.claude.com/docs/en/context-window)
- Anthropic: [Create custom subagents](https://code.claude.com/docs/en/sub-agents)
- Anthropic: [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- Google: [Gemini CLI Auto Memory](https://geminicli.com/docs/cli/auto-memory/)
- Google: [Gemini CLI Memory files](https://geminicli.com/docs/tools/memory/)
- Google: [Gemini CLI configuration](https://geminicli.com/docs/reference/configuration/)
- Xiaomi MiMo: [MiMo Code 发布说明](https://mimo.mi.com/docs/en-US/news/latest/mimocode)
- Xiaomi MiMo: [MiMo Code 官方仓库](https://github.com/XiaomiMiMo/MiMo-Code)
- Xiaomi MiMo: [Dream agent prompt（固定源码版本）](https://github.com/XiaomiMiMo/MiMo-Code/blob/a106676f7f8fa252dc8a50ac8a1fa892a4a36a0c/packages/opencode/src/agent/prompt/dream.txt)
- Xiaomi MiMo: [Auto Dream scheduler（固定源码版本）](https://github.com/XiaomiMiMo/MiMo-Code/blob/a106676f7f8fa252dc8a50ac8a1fa892a4a36a0c/packages/opencode/src/session/auto-dream.ts)
- GitHub: [About GitHub Copilot Memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory)
- Cursor: [Memories（旧版官方 URL，当前已重定向）](https://docs.cursor.com/en/context/memories)
- Devin: [Cascade Memories](https://docs.devin.ai/desktop/cascade/memories)
