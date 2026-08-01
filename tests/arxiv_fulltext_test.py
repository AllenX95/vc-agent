import importlib.util
import json
import sys
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


SCRIPT = Path(__file__).parents[1] / "skills" / "academic-research" / "arxiv-fulltext-reader" / "scripts" / "arxiv_fulltext.txt"
LOADER = SourceFileLoader("arxiv_fulltext_under_test", str(SCRIPT))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def options(root: str, identifier: str, *, allow_ar5iv: bool = False) -> SimpleNamespace:
    return SimpleNamespace(
        identifier=identifier,
        output_dir=root,
        allow_ar5iv=allow_ar5iv,
        force=False,
        timeout=1.0,
        delay_seconds=0.0,
    )


class ArxivFulltextDownloaderTests(unittest.TestCase):
    def test_normalizes_supported_urls_and_rejects_other_hosts(self) -> None:
        self.assertEqual(MODULE.normalize_identifier("https://arxiv.org/pdf/2401.12345v2.pdf"), "2401.12345v2")
        self.assertEqual(MODULE.normalize_identifier("hep-th/9901001"), "hep-th/9901001")
        with self.assertRaises(ValueError):
            MODULE.normalize_identifier("https://example.com/paper.pdf")

    def test_uses_official_html_and_preserves_raw_html(self) -> None:
        html = ("<html><body><article><h1>A paper</h1><p>" + "Readable paper text. " * 30 + "</p></article></body></html>").encode()

        def fake_fetch(url: str, timeout: float, max_bytes: int) -> MODULE.FetchResult:
            return MODULE.FetchResult(url, 200, "text/html", html)

        with tempfile.TemporaryDirectory() as root, patch.object(MODULE, "fetch", side_effect=fake_fetch):
            result = MODULE.download(options(root, "https://arxiv.org/abs/2401.12345"))
            directory = Path(result["directory"])
            self.assertEqual(result["source"], "html")
            self.assertEqual(set(result["files"]), {"html", "markdown"})
            self.assertTrue((directory / "paper.html").read_bytes() == html)
            self.assertIn("Readable paper text", (directory / "paper.md").read_text(encoding="utf-8"))
            self.assertEqual(json.loads((directory / "metadata.json").read_text(encoding="utf-8"))["source"], "html")

    def test_falls_back_to_pdf_and_retains_original_bytes(self) -> None:
        pdf = b"%PDF-1.7\n" + (b"0" * 4096)

        def fake_fetch(url: str, timeout: float, max_bytes: int) -> MODULE.FetchResult:
            if "/html/" in url:
                return MODULE.FetchResult(url, 404, "text/html", b"", "HTTP Error 404")
            return MODULE.FetchResult(url, 200, "application/pdf", pdf)

        with tempfile.TemporaryDirectory() as root, patch.object(MODULE, "fetch", side_effect=fake_fetch):
            result = MODULE.download(options(root, "2401.12345"))
            directory = Path(result["directory"])
            self.assertEqual(result["source"], "pdf")
            self.assertIn("pdf", result["files"])
            self.assertEqual((directory / "paper.pdf").read_bytes(), pdf)
            self.assertEqual(result["attempts"][0]["status"], 404)
            self.assertEqual(result["attempts"][1]["source"], "pdf")

    def test_can_use_ar5iv_only_when_requested(self) -> None:
        html = ("<html><body><article><p>" + "Alternate HTML text. " * 30 + "</p></article></body></html>").encode()

        def fake_fetch(url: str, timeout: float, max_bytes: int) -> MODULE.FetchResult:
            if "ar5iv" in url:
                return MODULE.FetchResult(url, 200, "text/html", html)
            return MODULE.FetchResult(url, 404, "text/html", b"", "HTTP Error 404")

        with tempfile.TemporaryDirectory() as root, patch.object(MODULE, "fetch", side_effect=fake_fetch):
            result = MODULE.download(options(root, "2401.12345", allow_ar5iv=True))
            self.assertEqual(result["source"], "ar5iv_html")
            self.assertNotIn("pdf", result["files"])

    def test_completed_cache_avoids_a_second_network_request(self) -> None:
        html = ("<html><body><article><p>" + "Cached text. " * 30 + "</p></article></body></html>").encode()

        def fake_fetch(url: str, timeout: float, max_bytes: int) -> MODULE.FetchResult:
            return MODULE.FetchResult(url, 200, "text/html", html)

        with tempfile.TemporaryDirectory() as root, patch.object(MODULE, "fetch", side_effect=fake_fetch) as mocked:
            first = MODULE.download(options(root, "2401.12345"))
            second = MODULE.download(options(root, "2401.12345"))
            self.assertFalse(first.get("cacheHit", False))
            self.assertTrue(second["cacheHit"])
            self.assertEqual(mocked.call_count, 1)


if __name__ == "__main__":
    unittest.main()
