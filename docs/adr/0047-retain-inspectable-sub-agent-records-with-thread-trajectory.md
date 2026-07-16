# Retain Inspectable Sub-Agent Records With Thread Trajectory

Accepted: each Sub-Agent Task has a locally retained, collapsed-by-default structured record containing its delegated objective and instructions, role, Model Profile, input references, messages, nested tool events, Attempts, usage, errors, and bounded result. The User may expand it for audit, while the primary Agent receives only a bounded handoff and stable references. Retries create separate Attempts rather than overwriting prior failures or results.

Records exclude hidden Chain of Thought, credentials, authorization headers, and unredacted raw Provider payloads. They remain ineligible for Dream, Inline Candidate Capture, and Memory Recall regardless of local retention; only content presented in the parent conversation and meaningfully adopted, corrected, or confirmed by the User may enter the memory path.

Sub-Agent Task Records follow the parent Thread's trajectory lifecycle. Parent deletion removes detailed child records and child-only excerpts while preserving generated Outputs and minimal `source unavailable` provenance. The User may also delete one child record, leaving a minimal `details deleted` placeholder and parent conversation intact. This favors local auditability and model comparison without polluting primary context or retaining hidden private copies after trajectory deletion.
