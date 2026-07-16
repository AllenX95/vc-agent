# Integrate Pi Through SDK In Project Workers

Accepted: the desktop app integrates Pi through SDK/runtime APIs inside Project Agent Workers. It does not wrap the Pi CLI and does not require a user-managed local Pi runtime daemon for MVP.

Pi integration follows Lazy Agent Activation. Application launch, Project opening, Thread creation, history inspection, and settings do not start a worker or Pi session. The Host activates at most one worker per Project, or an isolated on-demand Unscoped boundary, only when the User submits model-backed work after an effective Model Profile resolves. Missing Profile configuration produces a local retryable Thread error without starting Pi, creating a default Profile, or prompting during idle use.

This gives the GUI structured control over sessions, streaming events, tool calls, permissions, outputs, and local file editing. Any SDK-provided write tools must be disabled, wrapped, or routed through Desktop Host policy so they cannot bypass edited-copy generation, original-file replacement confirmation, provider upload authorization, or artifact provenance.

Pi SDK native capabilities are used for session/runtime lifecycle, streaming events, model/auth settings, resource loading, skills formatting/loading, extension hooks, tool registration, active tool control, commands, package resources, and multimodal `ImageContent` transport. VC Desktop registers Host-owned capabilities for project outputs, Canonical Parse, material disclosure, Project Context Recall, memory/Dream, authorization, provenance, and dependency diagnostics. It reuses compatible document Skills for Office work, one selected Pi Extension for MCP connectivity, Pi's Skill loader and package mechanics, and one Configured OCR Capability rather than reimplementing those ecosystems.

Pi is also selected because its thin, directly controlled runtime permits a Minimal Default Harness: a small stable VC prompt, bounded context assembly, and only task-relevant active capabilities instead of inheriting a large coding-agent prompt and tool surface. Pi SDK does not intrinsically reduce provider token billing; the reduction depends on VC Desktop keeping its Host instructions, active tools, recalled state, Skills, and material disclosure bounded.

The stable prompt is not optional: every ordinary model context receives the Minimal VC System Prompt so the product remains a VC-vertical Agent. Token discipline comes from keeping that prompt concise and moving task workflows, Skills, optional capabilities, Project State, Memory, and material content into bounded on-demand layers.

Read-only SDK tools may be used only when Desktop path policy and truncation are enforced. SDK `bash`, `edit`, and `write` are disabled by default for normal VC workflows because they bypass the product-specific edited-copy, confirmation, and artifact-tracking semantics unless explicitly wrapped.
