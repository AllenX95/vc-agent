# Output contract

The downloader creates `<output-dir>/<safe-arxiv-id>/` and writes `metadata.json` last.

| Field | Meaning |
| --- | --- |
| `source = html` | Official `arxiv.org/html/<id>` was available and yielded readable text. |
| `source = ar5iv_html` | The user opted into ar5iv after official HTML was unavailable. |
| `source = pdf` | HTML was unavailable; the original PDF was downloaded and retained. |
| `files.html` | Raw HTML artifact. |
| `files.pdf` | Original PDF artifact; this is the proof that the PDF was retained. |
| `files.markdown` | Best-effort readable text derived from HTML or local `pdftotext`. |
| `attempts` | Endpoint status, transport (`urllib` or `curl`), and availability decisions, in request order. |
| `warnings` | Non-fatal issues such as missing `pdftotext` or unavailable HTML. |
| `contentHash` | SHA-256 of the retained raw HTML or PDF bytes. |

An HTTP failure is not the same as an unavailable HTML conversion. Preserve the `attempts` records when reporting a failure so the user can distinguish a 404 conversion gap from a network or rate-limit problem.
