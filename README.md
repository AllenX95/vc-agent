# VC Agent

[English README](./README.en.md)

VC Agent 是一个面向单人风险投资工作的本地优先桌面 Agent。它以 Electron 为桌面容器，将 Project、Thread、项目材料、证据分析、投资反思和长期投资学习放在同一个可检查、可恢复的本地工作流中。

当前项目是 Personal Build（个人使用构建），不是多用户 SaaS，也不是通用聊天客户端。

## 产品定位

- **Project**：一个本地文件夹，对应一个投资机会、尽调任务或相关工作集合。
- **Project Thread**：属于某个 Project 的独立对话，能够按项目授权访问 Project State，但不与其他 Thread 共享模型上下文。
- **Unscoped Thread**：不属于 Project 的独立对话，不会隐式访问任何项目文件或项目状态。
- **Project State**：项目材料索引、Canonical Parse、Project Context、Project Memory、Outputs 和相关元数据。
- **Long-term Memory**：经过用户确认、去标识化后的跨项目投资学习。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| Project 与 Thread | 打开本地 Project，创建 Project / Unscoped Thread，独立维护对话上下文，并支持在会话标题栏重命名 Thread。 |
| 项目材料与证据 | 盘点项目文件，按需解析 PDF、DOCX、PPTX、XLSX 和文本，生成带来源引用的 Canonical Parse 与受控检索结果。 |
| 文件下载与输出 | 可将用户明确指定的公共 HTTP(S) 文件下载到授权 Output Location；下载和新建文本 Output 在 Standard Access 下都会先显示目标、来源和 G3 审批。 |
| 模型执行 | 基于 Pi SDK 的流式对话、Model Profile、Provider 切换、上下文预算、Thread Compaction、执行队列和可见失败状态。 |
| 投资工作流 | 支持普通 VC 对话、公共资料研究、Investment Reflection、Investment Retrospective，以及显式授权的 Sub-Agent 工作。 |
| 记忆与复盘 | Project Context、Project Memory、Long-term Memory、Memory Evolution 和 Dream 两阶段复盘；持久化写入需要单独的用户确认。 |
| 可选集成 | Skills Directory、Office 工作流、MCP、Academic Research，以及本地 Page Recovery / OCR。外部运行时均通过显式配置和 Host 边界接入。 |
| 本地可靠性 | SQLite 状态存储、Thread Trajectory、版本化迁移、恢复模式、个人认知备份和可检查的本地输出。 |

## 设计原则

1. **Local-first**：Project 内容、Outputs、解析结果、Memory 和 Thread 轨迹保存在本地；应用不依赖云端工作区同步。
2. **Host 控制边界**：Electron Main/Host 负责状态、权限、范围和生命周期；Agent Worker 只执行被明确提交的模型工作。
3. **按需激活**：应用启动、打开 Project 和创建 Thread 不会自动启动模型 Worker 或 Provider 请求。
4. **范围隔离**：Project Thread 与 Unscoped Thread 的文件、材料、Context 和 Memory 访问边界不同。
5. **显式意图与复核**：外部写入、删除、权限扩展、Reflection、Dream 和长期 Memory 变更都保留可见的用户决策点。

## 快速开始

### 环境要求

- Windows x64 是当前主要开发和打包目标。
- Node.js `>= 24`。
- pnpm `10.10.0`（仓库通过 `packageManager` 固定）。
- 使用本地解析、OCR、Office 或真实 MCP 集成时，还需要对应的外部运行时；它们不是基础安装的必需项。

### 安装依赖

在项目根目录执行：

```powershell
pnpm install
```

### 启动开发应用

以下命令会先构建 Worker 和 Desktop，再启动 Electron：

```powershell
pnpm dev
```

Windows 也可以直接运行：

```powershell
.\start-dev.cmd
```

首次使用时建议：

1. 打开 **Settings**，创建至少一个 Model Profile 并配置对应 Provider 凭据。
2. 打开一个本地 Project，或创建一个 Unscoped Thread。
3. 在 Thread 中提交问题；只有提交需要模型的工作后，Agent Worker 和模型会话才会启动。
4. 在 Project 侧查看材料、Context、Outputs，并按需启动 Reflection 或 Dream 复盘。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm build` | 构建 Agent Worker、Utility Worker 和 Desktop。 |
| `pnpm typecheck` | 运行所有工作区 TypeScript 类型检查。 |
| `pnpm test` | 运行 Vitest 单元与契约测试。 |
| `pnpm test:e2e` | 构建后运行 Playwright Electron 测试（排除 `@real` 测试）。 |
| `pnpm verify` | 运行类型检查、单元测试和 E2E 测试。 |
| `pnpm package:win` | 准备解析运行时并生成 Windows x64 NSIS 安装包。 |
| `pnpm package:win:dir` | 构建 Windows x64 目录包，便于检查打包结果。 |

真实外部依赖的兼容性验证使用独立命令，例如 `pnpm mcp:compat`、`pnpm office:compat`、`pnpm academic-research:compat` 和 `pnpm h1:packaged`。这些命令需要额外的环境变量或外部证据，不属于普通开发启动流程。

## 本地数据与隐私

默认情况下，Windows 用户数据根目录为：

```text
%LOCALAPPDATA%\vc-agent
```

常见内容包括：

```text
state.db        # SQLite 应用状态与索引
threads/        # Thread Trajectory
memory/         # Long-term Memory、Project Memory、Dream 等
skills/         # 用户导入和激活的 Skills
integrations/   # Office、MCP、Extension 等集成状态
```

可以通过 `VC_AGENT_USER_DATA_DIR` 指定其他用户数据目录。Project 文件、Context、Memory、Outputs 和解析产物保持为普通本地文件，便于检查、备份和恢复；Provider 凭据通过操作系统保护机制保存，应用状态只保存引用和非敏感元数据。

应用提供 **Standard Access** 和 **Full Access** 两种访问模式。Full Access 会减少后续工具确认，但不会跳过 Reflection、Dream、Memory 提交或 Thread 范围变更等产品级复核。保护用户数据仍需要依赖操作系统账户、设备和备份位置的安全设置。

## 项目结构

```text
apps/
  desktop/          Electron Main、Preload、Renderer
  agent-worker/     Agent Worker 运行时
  utility-worker/   解析、OCR 和本地作业运行时
packages/
  contracts/        IPC、事件、领域数据契约
  persistence/      SQLite 状态存储与迁移
  host-services/    Host 工作流、Memory、Project 和集成服务
  capabilities/     Host 注册能力
  pi-adapter/       Pi SDK / MCP 适配边界
tests/              单元、契约、架构和 Electron E2E 测试
docs/               ADR、运行时和兼容性说明
```

## 文档

- [Windows 打包说明](./docs/windows-packaging.md)
- [本地 OCR / Page Recovery](./docs/local-ocr-runtime.md)
- [本地 MCP 兼容性](./docs/local-mcp-compatibility.md)
- [架构决策记录（ADR）](./docs/adr/)
- [项目上下文与术语](./CONTEXT.md)

## 状态说明

该项目持续演进中，部分 Office、OCR、MCP、Provider 和外部 Skill 能力需要额外运行时或用户配置。涉及真实外部系统的测试会单独标记，并要求脱敏的外部证据；仓库内的 fixture 只用于开发和自动化测试，不代表真实依赖已经配置。
