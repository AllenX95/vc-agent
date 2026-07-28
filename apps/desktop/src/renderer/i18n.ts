import { useEffect, useState } from "react";

export type UiLanguage = "en" | "zh-CN";

const STORAGE_KEY = "vc-agent.ui-language";

const zhCN: Record<string, string> = {
  "Unscoped Threads": "独立任务",
  "Projects": "项目",
  "Archived": "已归档",
  "Settings": "设置",
  "Search": "搜索",
  "New thread": "新建任务",
  "Open project": "打开项目",
  "Restore thread": "恢复任务",
  "No threads": "暂无任务",
  "No projects": "暂无项目",
  "No active thread": "尚未选择任务",
  "Create or select a thread from the navigation.": "请从左侧导航新建或选择一个任务。",
  "Conversation": "对话",
  "Project Thread": "项目任务",
  "Unscoped Thread": "独立任务",
  "No profile": "未选择模型配置",
  "Archive thread": "归档任务",
  "Delete thread": "删除任务",
  "Delete thread history": "删除任务历史",
  "Ready for a new conversation": "可以开始新的对话",
  "Memory candidate captured": "已捕获记忆候选",
  "Review": "审阅",
  "Dismiss": "忽略",
  "Approve": "批准",
  "Deny": "拒绝",
  "Cancel": "取消",
  "Send": "发送",
  "Stop": "停止",
  "Working": "处理中",
  "Retry": "重试",
  "Continue": "继续",
  "Interrupted": "已中断",
  "The previous request will not resume automatically.": "上一次请求不会自动继续。",
  "Choose output location": "选择输出位置",
  "Adjust profile": "调整模型配置",
  "Execution Queue": "执行队列",
  "Unsent draft": "未发送草稿",
  "Waiting for this task": "等待当前任务",
  "Waiting for capacity": "等待执行资源",
  "Up": "上移",
  "No output location": "未设置输出位置",
  "Project scoped": "项目范围",
  "Full access": "完全访问",
  "Compact thread": "压缩任务上下文",
  "Queue follow-up": "加入后续消息",
  "Overview": "概览",
  "Outputs": "输出",
  "Context": "上下文",
  "Memory": "记忆",
  "Project state": "项目状态",
  "Project state views": "项目状态视图",
  "Unscoped task": "独立任务",
  "This task has no Project State.": "此任务不包含项目状态。",
  "Host ready": "主程序就绪",
  "Recovery": "恢复模式",
  "No generated outputs": "暂无生成的输出",
  "Project Context": "项目上下文",
  "Project Memory": "项目记忆",
  "Save Context": "保存上下文",
  "Save Memory": "保存记忆",
  "Loading Project Context...": "正在加载项目上下文…",
  "Loading Project Memory...": "正在加载项目记忆…",
  "Material metadata only. Content loads on demand.": "仅显示材料元数据，内容将在需要时加载。",
  "No supported materials": "暂无支持的材料",
  "Refresh parse": "刷新解析",
  "Parse": "解析",
  "Cancel Parse": "取消解析",
  "Confirm Project Memory": "确认项目记忆",
  "This appends a user-confirmed judgment, not source evidence.": "这将追加一条用户确认的判断，而不是来源证据。",
  "Title": "标题",
  "Tags": "标签",
  "Judgment": "判断",
  "Confirm append": "确认追加",
  "Project Identity Collision": "项目标识冲突",
  "Moved Project": "项目已移动",
  "Project Copy": "项目副本",
  "Material changed": "材料已变更",
  "Create New Parse Version": "创建新的解析版本",
  "Replace Previous Parse": "替换上一解析版本",
  "Change Provider for this conversation?": "要更换本次对话的模型服务商吗？",
  "Continuing retains the visible Thread trajectory. Starting a new Thread retains no conversation context.": "继续当前任务会保留可见对话轨迹；新建任务则不会保留对话上下文。",
  "Continue current thread": "继续当前任务",
  "Start new thread": "新建任务",
  "Delete thread history?": "删除任务历史？",
  "Delete this thread?": "删除此任务？",
  "This removes the Thread from the project, together with its retained conversation, physical context, queued work, unapproved candidates, and Dream source text. Confirmed Memory and Outputs remain.": "这将从项目中删除整个任务，同时清理其对话、物理上下文、排队工作、未确认候选记忆和 Dream 源文本；已确认的记忆与输出会保留。",
  "This removes the retained conversation and physical context. Unapproved candidate and Dream source text from this task will also be removed. Confirmed Memory and Outputs remain.": "这将删除保留的对话与物理上下文，同时移除本任务中未批准的候选记忆和 Dream 源文本；已确认的记忆与输出会保留。",
  "Delete history": "删除历史",
  "Start Investment Reflection": "开始投资复盘",
  "Optional focus": "可选关注点",
  "Independent Evidence Profile": "独立证据模型配置",
  "Not assigned": "未分配",
  "Start Reflection": "开始复盘",
  "Start Dream": "开始 Dream",
  "Dream Model Profile": "Dream 模型配置",
  "Create Dream Batch": "创建 Dream 批次",
  "This creates one frozen cross-project review batch. It does not authorize any Memory write.": "这会创建一个冻结的跨项目审阅批次，但不会授权写入任何记忆。",
  "Confirm Long-term Memory change": "确认长期记忆变更",
  "This is a separate confirmation after the Judgment Record. Review the lineage and file diffs before committing.": "这是判断记录后的独立确认步骤。提交前请检查来源链路和文件差异。",
  "Discard": "放弃",
  "Confirm Memory change": "确认记忆变更",
  "General": "常规",
  "Application": "应用",
  "Application version": "应用版本",
  "State schema": "状态架构",
  "Storage mode": "存储模式",
  "Migration status": "迁移状态",
  "Access Mode": "访问模式",
  "Standard": "标准",
  "Full Access": "完全访问",
  "Environment Doctor": "环境诊断",
  "Local state": "本地状态",
  "Location": "位置",
  "Recovery export": "恢复导出",
  "Export raw state": "导出原始状态",
  "Personal Cognition Backup": "个人认知备份",
  "Portable, checksummed cognition only. Projects, workflow state, trajectories, and credentials are excluded.": "仅备份可移植且经过校验的认知数据；项目、工作流状态、对话轨迹和凭据均不包含在内。",
  "Create backup": "创建备份",
  "Restore backup": "恢复备份",
  "Model Profiles": "模型配置",
  "Credentials are protected by Windows and stored only by reference.": "凭据由 Windows 保护，应用仅保存其引用。",
  "New profile": "新建配置",
  "No model profiles": "暂无模型配置",
  "Name": "名称",
  "Provider": "服务商",
  "Model": "模型",
  "API key": "API 密钥",
  "Reasoning": "推理强度",
  "Low": "低",
  "Medium": "中",
  "High": "高",
  "Save profile": "保存配置",
  "Configure profiles": "配置模型",
  "Task Model Assignments": "任务模型分配",
  "Workflow defaults; launch-time selection remains available.": "这里设置工作流默认值，启动时仍可另行选择。",
  "Ordinary conversation": "常规对话",
  "Web research": "网络研究",
  "Document generation": "文档生成",
  "Independent evidence": "独立证据",
  "Memory-aware reflection": "记忆辅助复盘",
  "Extension audit": "扩展审计",
  "Visual material analysis": "视觉材料分析",
  "Default Sub-Agent": "默认子代理",
  "Sub-Agent researcher": "子代理研究员",
  "Sub-Agent critic": "子代理审阅员",
  "Sub-Agent synthesizer": "子代理综合员",
  "Sub-Agent writer": "子代理撰稿员",
  "Sub-Agent custom": "自定义子代理",
  "Integrations": "集成",
  "Every integration is lazy, Host-authorized, restart-safe, and explicit about unavailable dependencies.": "所有集成都按需加载、由主程序授权、支持安全重启，并明确展示不可用的依赖。",
  "Loading Integration state...": "正在加载集成状态…",
  "Refresh status": "刷新状态",
  "Runtime": "运行状态",
  "Skills Directory": "技能目录",
  "Complete packages are copied into an app-owned directory and remain disabled until explicit activation.": "完整技能包会复制到应用管理的目录，并在明确启用前保持停用。",
  "Packages": "技能包",
  "No imported Skill packages": "暂无导入的技能包",
  "Import Skill": "导入技能",
  "Inspect": "检查",
  "Disable": "停用",
  "Active": "已启用",
  "Disabled": "已停用",
  "Sub-Agent Delegation": "子代理委派",
  "Select a parent Thread before authorizing delegation.": "授权委派前请先选择父任务。",
  "Select an Active Model Profile before authorizing delegation.": "授权委派前请先选择已启用的模型配置。",
  "Authorize current-task delegation": "授权当前任务委派",
  "No explicit Sub-Agent runs.": "暂无显式子代理运行记录。",
  "Role": "角色",
  "Researcher": "研究员",
  "Critic": "审阅员",
  "Synthesizer": "综合员",
  "Writer": "撰稿员",
  "Bounded objective": "限定目标",
  "Recent workflow states": "近期工作流状态",
  "No integration jobs have run.": "暂无集成任务运行记录。",
  "Minimal VC System Prompt": "最小化 VC 系统提示词",
  "Edits apply at the next Prompt Load Boundary.": "修改将在下一次提示词加载边界生效。",
  "Prompt": "提示词",
  "Change note": "变更说明",
  "Restore default": "恢复默认",
  "Save revision": "保存版本",
  "Activate": "启用",
  "Memory Evolution": "记忆演化",
  "Long-term Memory": "长期记忆",
  "Loading Long-term Memory...": "正在加载长期记忆…",
  "Active memory": "有效记忆",
  "Current entries": "当前条目",
  "explicit only": "仅显式调用",
  "unresolved views": "未解决观点",
  "Open change summary": "打开变更摘要",
  "Create explicit draft": "创建显式草稿",
  "Action": "操作",
  "Add": "新增",
  "Reinforce": "强化",
  "Narrow": "收窄",
  "Revise": "修订",
  "Contradict": "提出冲突",
  "Merge / Condense": "合并 / 精简",
  "Entry ID": "条目 ID",
  "Applies to": "适用范围",
  "Maturity": "成熟度",
  "Recall": "召回策略",
  "User confirmed": "用户确认",
  "Evidence backed": "证据支持",
  "Retrospectively supported": "回溯支持",
  "Automatic": "自动",
  "Explicit only": "仅显式调用",
  "Limitations": "局限",
  "Learning": "学习内容",
  "Rationale": "理由",
  "Resolution signal": "解决信号",
  "Reference": "引用",
  "Preview final patch": "预览最终补丁",
  "Condensation Archive": "精简归档",
  "Cognitive Evolution History is permanent and excluded from this policy.": "认知演化历史永久保留，不受此策略影响。",
  "Retention": "保留期限",
  "Automatic cleanup": "自动清理",
  "Permanent": "永久",
  "Keep": "保留",
  "Re-archive": "重新归档",
  "Delete": "删除",
  "Dream": "Dream",
  "Loading Dream state...": "正在加载 Dream 状态…",
  "Eligible exchanges": "符合条件的对话",
  "Captured candidates": "已捕获候选",
  "Carryover": "待延续项",
  "New batch": "新建批次",
  "Frozen batch": "冻结批次",
  "Extract": "提取",
  "Skip": "跳过",
  "Global Dream Synthesis": "全局 Dream 综合",
  "Approve all": "全部批准",
  "Reject all": "全部拒绝",
  "Prepare Markdown Patch Preview": "准备 Markdown 补丁预览",
  "Final Markdown Patch Preview": "最终 Markdown 补丁预览",
  "Confirm Memory Commit": "确认提交记忆",
  "Latest completed Dream": "最近完成的 Dream",
  "Learning telemetry": "学习遥测",
  "Execution capacity": "执行容量",
  "Queued / drafts": "排队 / 草稿",
  "Average queue delay": "平均排队延迟",
  "Longest running": "最长运行时间",
  "Execution failures": "执行失败",
  "Provider requests": "服务商请求",
  "Agent workers": "代理进程",
  "Pi sessions": "Pi 会话",
  "Sources": "来源",
  "Evidence references": "证据引用",
  "Independent Assessment": "独立评估",
  "Judgment Record": "判断记录",
  "Long-term Learning Proposal": "长期学习提案",
  "Prepare outcomes": "准备结果",
  "Confirm Judgment Record": "确认判断记录",
  "Preview Memory Patch": "预览记忆补丁",
  "Discard Reflection": "放弃复盘",
  "Status": "状态",
  "Focus:": "关注点：",
  "Read-only Recovery": "只读恢复模式",
  "Local state is available for inspection, but changes and agent execution are disabled.": "本地状态可供检查，但修改和代理执行已被禁用。",
  "Language": "语言",
  "English": "English",
  "Chinese": "中文"
};

const dynamicTranslations: Array<[RegExp, (...parts: string[]) => string]> = [
  [/^New thread in (.+)$/u, (name) => `在「${name}」中新建任务`],
  [/^Restore (.+)$/u, (name) => `恢复「${name}」`],
  [/^Accessed (.+)$/u, (date) => `访问于 ${date}`],
  [/^(\d+) items?$/u, (count) => `${count} 项`],
  [/^(\d+) days?$/u, (count) => `${count} 天`],
  [/^Expires (.+)$/u, (date) => `到期于 ${date}`],
  [/^Schema (.+)$/u, (version) => `架构 ${version}`]
];

function translate(value: string): string {
  const leading = value.match(/^\s*/u)?.[0] ?? "";
  const trailing = value.match(/\s*$/u)?.[0] ?? "";
  const core = value.slice(leading.length, value.length - trailing.length);
  const exact = zhCN[core];
  if (exact !== undefined) return `${leading}${exact}${trailing}`;
  for (const [pattern, render] of dynamicTranslations) {
    const match = core.match(pattern);
    if (match !== null) return `${leading}${render(...match.slice(1))}${trailing}`;
  }
  return value;
}

const originalText = new WeakMap<Text, string>();
const originalAttributes = new WeakMap<Element, Map<string, string>>();
const translatedValues = new Set(Object.values(zhCN));
const translatedAttributes = ["aria-label", "title", "placeholder"] as const;

function shouldSkip(node: Node): boolean {
  const parent = node.parentElement;
  return parent?.closest(".message-content, .user-message, .system-event, .web-source p, textarea, pre, code") !== null;
}

function localizeNode(node: Node, language: UiLanguage): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const textNode = node as Text;
    if (shouldSkip(textNode)) return;
    const current = textNode.nodeValue ?? "";
    const remembered = originalText.get(textNode);
    if (language === "en") {
      if (remembered !== undefined && current !== remembered) textNode.nodeValue = remembered;
      return;
    }
    if (remembered === undefined) {
      originalText.set(textNode, current);
    } else if (current !== translate(remembered) && !translatedValues.has(current.trim())) {
      originalText.set(textNode, current);
    }
    const source = originalText.get(textNode) ?? current;
    const localized = translate(source);
    if (localized !== current) textNode.nodeValue = localized;
    return;
  }

  if (!(node instanceof Element)) return;
  let attributes = originalAttributes.get(node);
  for (const attribute of translatedAttributes) {
    const current = node.getAttribute(attribute);
    if (current === null) continue;
    if (attributes === undefined) {
      attributes = new Map();
      originalAttributes.set(node, attributes);
    }
    const remembered = attributes.get(attribute);
    if (language === "en") {
      if (remembered !== undefined && current !== remembered) node.setAttribute(attribute, remembered);
      continue;
    }
    if (remembered === undefined) attributes.set(attribute, current);
    else if (current !== translate(remembered) && !translatedValues.has(current)) attributes.set(attribute, current);
    const source = attributes.get(attribute) ?? current;
    const localized = translate(source);
    if (localized !== current) node.setAttribute(attribute, localized);
  }
  for (const child of node.childNodes) localizeNode(child, language);
}

export function useUiLanguage(): [UiLanguage, () => void] {
  const [language, setLanguage] = useState<UiLanguage>(() =>
    window.localStorage.getItem(STORAGE_KEY) === "zh-CN" ? "zh-CN" : "en"
  );

  useEffect(() => {
    const root = document.getElementById("root");
    if (root === null) return;
    document.documentElement.lang = language;
    window.localStorage.setItem(STORAGE_KEY, language);
    localizeNode(root, language);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "characterData") localizeNode(record.target, language);
        for (const added of record.addedNodes) localizeNode(added, language);
        if (record.type === "attributes") localizeNode(record.target, language);
      }
    });
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...translatedAttributes] });
    return () => observer.disconnect();
  }, [language]);

  return [language, () => setLanguage((current) => current === "en" ? "zh-CN" : "en")];
}
