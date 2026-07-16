# Run One Turn Per Thread With Bounded Cross-Thread Concurrency

Accepted: one Thread has at most one Active Turn, while different Threads, including Threads in the same Project, may execute concurrently under a bounded installation-wide concurrency limit. Switching views or minimizing the application does not stop work. Prompts that cannot start immediately enter a visible Execution Queue, and a message sent to a Thread with an Active Turn becomes an editable and cancellable Queued Follow-up rather than implicitly steering the running objective.

Stop creates an Interrupted Turn and does not submit queued work. Closing the application terminates Active Turns, and queued work survives only as drafts that are not automatically submitted after restart. Dream and Investment Reflection share the same bounded execution capacity; dependency-ordered stages within one run remain ordered.

Concurrent tasks may share Project State but never model context. Same-target writes are handled by Host collision policy rather than implicit model merging: Standard Access confirms the conflicting write, Full Access executes without a prompt, and both expose the overwrite or failure. This provides Codex-like multitasking without a post-exit daemon or an unbounded background job system, at the cost of explicit queue and collision state in the GUI.
