export type AcademicWorkflowPrototypeId =
  | "paper-technical-diligence"
  | "founder-academic-diligence"
  | "technical-claim-verification"
  | "novelty-and-prior-art-map"
  | "research-to-company-map";

export interface AcademicWorkflowPrototype {
  readonly id: AcademicWorkflowPrototypeId;
  readonly version: 1;
  readonly instructions: string;
}

const EVIDENCE_RULES = `Shared academic evidence rules:
- Use academic_research before making source-dependent factual claims.
- Delegate generic public-page, GitHub README/repository-content, and non-domain URL retrieval to the Extension-owned web_fetch tool (activate it through capability_request when absent). Keep academic_research for source-specific identifiers, normalization, evidence typing, graph semantics, and partial-failure reporting.
- Distinguish indexed metadata, preprints, paper/README/Card author claims, inference, and VC judgment.
- arXiv is a preprint source and does not prove peer review or conference acceptance.
- Stars, downloads, and citations do not prove customers, adoption, revenue, or technical quality.
- A missing search result does not prove non-existence.
- Cite Evidence IDs or source URLs for verifiable facts and state unavailable evidence explicitly.
- Allowed claim states: 已验证, 基本支持, 部分支持, 证据冲突, 无法验证, 已被反证.`;

const INSTRUCTIONS: Record<AcademicWorkflowPrototypeId, string> = {
  "paper-technical-diligence": `${EVIDENCE_RULES}

Workflow prototype: paper technical diligence.
Resolve the seed work; inspect metadata and bounded problem/method/experiment/limitation sections; inspect references/citations needed for novelty; link GitHub/Hugging Face artifacts. Output: 核心结论, 问题与方法, 创新增量, 实验是否支撑, 代码/模型/数据/Demo, 局限与 Scaling, 产业化价值, 对创业项目的意义, 未验证事项, Evidence references. Do not calculate an overall score.`,
  "founder-academic-diligence": `${EVIDENCE_RULES}

Workflow prototype: founder academic diligence.
Search author candidates and use at least two identity signals such as affiliations, coauthors, topics, works, or linked organizations. Retain ambiguity instead of forcing a match. Output: 身份确认, 代表成果, 贡献角色, 研究连续性, 独立研究能力, 工程信号, 合作网络, 创业方向匹配, 优势, 风险与证据缺口. Do not infer personality, leadership, management, ethics, or commercial ability.`,
  "technical-claim-verification": `${EVIDENCE_RULES}

Workflow prototype: technical claim verification.
Copy the original claim, decompose it into atomic claims, record a query plan, seek supporting and limiting/counterevidence, and produce a Claim Matrix with status, evidence, limitations, and judgment. End with whether the publicity wording should be narrowed, the current four-source coverage, and additional evidence needed.`,
  "novelty-and-prior-art-map": `${EVIDENCE_RULES}

Workflow prototype: academic novelty and prior-work map, not legal patent prior art.
Define the seed and technical modules; search older terminology and alternative routes; inspect references, citations, related and concurrent works; classify foundational, direct predecessor, concurrent, follow-up, alternative, implementation, or reproduction. Every graph edge needs Evidence IDs and confidence. Output originality, replicability, and substitution risk.`,
  "research-to-company-map": `${EVIDENCE_RULES}

Workflow prototype: research-to-company mapping.
Trace paper → author candidates → institution/lab → GitHub/Hugging Face user or organization → assets → organization/commercial-domain signals. Separate strong, medium, and weak links. Use only 候选商业化组织, 疑似产业化主体, or 可能存在关联. Do not claim confirmed employment, company registration, financing, IP ownership, or deployment.`
};

export function academicWorkflowPrototype(text: string): AcademicWorkflowPrototype | undefined {
  const normalized = text.toLowerCase();
  let id: AcademicWorkflowPrototypeId | undefined;
  if (/(论文.{0,12}公司|研究.{0,12}公司|产业化主体|商业化组织|research.to.company)/iu.test(normalized)) id = "research-to-company-map";
  else if (/(原创性|前序工作|技术谱系|prior work|prior-art|novelty map|替代路线)/iu.test(normalized)) id = "novelty-and-prior-art-map";
  else if (/(宣称|宣传|claim|全球首个|世界首个|sota|行业领先|技术验证|核验)/iu.test(normalized)) id = "technical-claim-verification";
  else if (/(创始人|创始团队|核心作者|学术能力|科研能力|founder academic|author diligence)/iu.test(normalized)) id = "founder-academic-diligence";
  else if (/(论文技术尽调|解读.{0,8}论文|评价.{0,8}论文|paper diligence|technical diligence|产业化价值)/iu.test(normalized)) id = "paper-technical-diligence";
  return id === undefined ? undefined : { id, version: 1, instructions: INSTRUCTIONS[id] };
}
