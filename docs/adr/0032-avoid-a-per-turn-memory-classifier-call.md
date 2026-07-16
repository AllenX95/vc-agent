# Avoid A Per-Turn Memory Classifier Call

Accepted: the first usable version does not make a separate model request after every conversation turn to classify Short-term Memory Candidates. Explicit memory intent may be captured deterministically, and the model already producing the current response may emit a bounded structured candidate signal as part of that same turn.

This preserves the token and latency advantage expected from the Minimal Default Harness. The trade-off is lower recall from live capture, which is acceptable because candidate hints are reviewable and Dream has a bounded trajectory-recovery pass for missed strong signals. Inline Candidate Capture never promotes durable Memory by itself.
