# Use Deterministic Atomic State Schema Migrations

Accepted: vc-agent data domains use explicit schema versions, while application updates remain manual in the first release. Opening a supported older schema runs a deterministic local State Schema Migration before writes are enabled. Migration may transform Host-owned structure and rebuild derived indexes, but it never calls an LLM, interprets investment meaning, manufactures provenance, or rewrites authoritative user-authored Memory and Skill content.

Each migration first creates a bounded local rollback copy of the affected files, writes and validates staged state, and activates the complete result atomically. Failure leaves the prior state active and produces a specific sanitized diagnostic; partial migrated state never becomes writable. This rollback copy protects one migration operation and is not a portable Personal Cognition Backup.

Stored state newer than the running application triggers Read-only Recovery Mode rather than guessed forward compatibility or an automatic downgrade. Inspection and supported export remain available, but normal Agent and state writes require a compatible application or an explicit restore of compatible state. This protects long-lived cognition from silent corruption and semantic drift at the cost of migration code, temporary local copies, and no writable downgrade guarantee.
