# Restore Approved Public File Download

Status: Accepted

Date: 2026-08-02

## Decision

vc-agent exposes Host-owned capabilities for approved local retention. `file_download` handles one unauthenticated HTTP(S) file at a time, `arxiv.fulltext` runs the reviewed HTML-first ArXiv workflow in the isolated Utility Worker, and `workspace.write_batch` writes a bounded batch of text files. All three write only beneath the current Thread's authorized Output Location, use bounded/atomic finalization paths, record the result as an Artifact, and leave the existing Project `system` and `parsed` namespaces reserved for Host-managed state.

The capability is task-activated only when the User's request contains download/save-to-disk intent. In Standard Access, the Gateway always returns a scoped G3 Action Proposal before either the network request or the local write. Full Access retains its existing behavior and may execute without a tool-level prompt. Existing text Output creation follows the same Standard Access confirmation rule; text editing continues to use the bounded diff flow.

The capabilities accept only public HTTPS sources or an ArXiv ID/URL, never embedded credentials. The ArXiv downloader is a fixed Host-owned Utility Worker job with a bundled reviewed script; neither the Agent Worker nor `project.command` can invoke an arbitrary shell or Python script. The write-batch capability accepts only bounded model-supplied text content and relative paths, and none of these capabilities expands the authorized filesystem scope. `project.command` remains strictly read-only.

## Consequences

- Raw public PDFs and other files can be retained locally without enabling arbitrary Python or shell execution.
- Complete ArXiv bundles can be retained through the Host-owned HTML-first workflow, with PDF fallback and metadata/warning provenance.
- Explicit multi-file text saves can be approved as one bounded folder operation rather than as unrelated individual writes.
- The User sees and approves the source URL, destination, replacement behavior, and bounded write effect before side effects occur.
- The packaged academic Skill now points complete ArXiv requests to `arxiv.fulltext`; if that capability is unavailable, the model offers the raw `file_download` path instead of telling the User to run a terminal command.
- Downloaded files are registered through the same Artifact and Project Output provenance path as generated Outputs.
