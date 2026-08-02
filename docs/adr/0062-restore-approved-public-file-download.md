# Restore Approved Public File Download

Status: Accepted

Date: 2026-08-02

## Decision

vc-agent exposes a Host-owned `file_download` capability for one unauthenticated HTTP(S) file at a time. It writes only beneath the current Thread's authorized Output Location, uses an atomic finalization path, caps the response at 50 MiB, records the result as an Artifact, and leaves the existing Project `system` and `parsed` namespaces reserved for Host-managed state.

The capability is task-activated only when the User's request contains download/save-to-disk intent. In Standard Access, the Gateway always returns a scoped G3 Action Proposal before either the network request or the local write. Full Access retains its existing behavior and may execute without a tool-level prompt. Existing text Output creation follows the same Standard Access confirmation rule; text editing continues to use the bounded diff flow.

The capability accepts only HTTP(S) URLs without embedded credentials. It does not execute a downloader script, invoke a shell, browse logged-in sessions, or expand the authorized filesystem scope. `project.command` remains strictly read-only.

## Consequences

- Raw public PDFs and other files can be retained locally without enabling arbitrary Python or shell execution.
- The User sees and approves the source URL, destination, replacement behavior, and bounded write effect before side effects occur.
- HTML-first academic bundles still require the separately configured bundled downloader runtime; raw artifact retention can use `file_download` directly.
- Downloaded files are registered through the same Artifact and Project Output provenance path as generated Outputs.
