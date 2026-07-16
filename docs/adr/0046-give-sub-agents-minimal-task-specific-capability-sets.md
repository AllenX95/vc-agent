# Give Sub-Agents Minimal Task-Specific Capability Sets

Accepted: every Sub-Agent Task receives a visible, task-specific Sub-Agent Capability Set rather than inheriting the primary Agent's complete tool surface. Research, analysis, and critic roles default to read-only capabilities. The primary Agent may create an explicitly write-capable child when the current User task requires artifact generation, and that child may produce a provenance-tracked Output directly without redundant regeneration by the primary Agent.

Child filesystem and external side effects follow the same Access Mode as primary actions. Sub-Agent Run authorization does not expand the task objective, data scope, Provider authorization, or destination scope. Concurrent child writes use Host collision and atomic-finalization policy, and their nested tool activity and affected paths remain visible.

No child capability set may include direct Project Memory, Long-term Memory, Dream state, Judgment Record, Cognitive Evolution History, Investment Reflection launch/resume, Dream launch/resume, or Thread Scope Elevation tools, even under Full Access. This preserves the Cognitive Review Gate while allowing useful delegated execution and reduces tool-schema tokens and accidental side effects compared with cloning the primary Agent's capabilities.
