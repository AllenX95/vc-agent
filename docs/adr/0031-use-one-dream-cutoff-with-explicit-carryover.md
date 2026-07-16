# Use One Dream Cutoff With Explicit Carryover

Accepted: each Dream Batch uses one shared Dream Cutoff equal to the completion time of the latest eligible user-facing Thread session included in that batch. The product does not maintain independent time watermarks for each Project or Unscoped Thread.

The cutoff is calculated and frozen when the Dream Batch is created. Sessions and candidates completed after that instant belong to the next batch and do not make current extraction results stale. This keeps the run a stable snapshot rather than a moving target.

This gives each Dream a comprehensible global review boundary and avoids fragmented per-scope scheduling state. The trade-off is that Partial Dream Coverage, Keep Pending, failures, and interrupted work cannot be represented by advancing some scope watermarks and withholding others. Any unresolved input at or before an advanced cutoff is therefore retained as explicit Dream Carryover and included in a later Dream until it receives a final disposition. A discarded or never-completed Dream does not advance the committed cutoff.
