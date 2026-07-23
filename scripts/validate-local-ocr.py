import argparse
import gc
import importlib.metadata
import importlib.util
import json
import os
import sys
import time
from pathlib import Path


OVIS_REVISION = "65c619d374b55d4152e85150fc1b003700bc1f0c"


def load_runtime(path):
    spec = importlib.util.spec_from_file_location("vc_agent_ocr_runtime", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def create_validation_pdf(path):
    import pymupdf

    document = pymupdf.open()
    page = document.new_page(width=595, height=842)
    page.insert_text((72, 90), "VC Agent OCR Validation", fontsize=22)
    page.insert_text((72, 130), "Revenue 2025  120", fontsize=14)
    page.insert_text((72, 160), "Revenue 2026  165", fontsize=14)
    page.draw_rect((65, 108, 300, 180), width=1)
    page.draw_line((65, 140), (300, 140), width=1)
    page.draw_line((210, 108), (210, 180), width=1)
    document.save(path)
    document.close()


def version(name):
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return "unavailable"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-root", required=True)
    parser.add_argument("--worker-script", required=True)
    parser.add_argument("--stage", choices=["paddle", "ovis"], required=True)
    parser.add_argument("--devices", nargs="+", choices=["cpu", "cuda"], required=True)
    args = parser.parse_args()
    root = Path(args.runtime_root).resolve()
    validation_root = root / "validation"
    validation_root.mkdir(parents=True, exist_ok=True)
    pdf_path = validation_root / "ocr-validation.pdf"
    create_validation_pdf(pdf_path)
    os.environ["PADDLE_PDX_CACHE_HOME"] = str(root / "models" / "paddle")
    os.environ["HF_HOME"] = str(root / "models" / "huggingface-cache")
    module = load_runtime(Path(args.worker_script).resolve())
    results = []
    for device in args.devices:
        runtime = module.Runtime()
        outputs = []
        for iteration in range(2):
            started = time.perf_counter()
            output = runtime.recover({"stage": args.stage, "absolutePath": str(pdf_path), "pageNumber": 1, "device": device, "runtimeRoot": str(root)})
            if not output["text"].strip():
                raise RuntimeError(f"{args.stage}/{device} returned empty text")
            outputs.append(output["text"])
            results.append({"stage": args.stage, "device": device, "iteration": iteration + 1, "durationMs": round((time.perf_counter() - started) * 1000), "textChars": len(output["text"]), "confidence": output["confidence"], "adapterVersion": output["adapterVersion"], "runtimeRevision": output["runtimeRevision"], "warnings": output["warnings"]})
        if outputs[0] != outputs[1]:
            raise RuntimeError(f"{args.stage}/{device} deterministic repeat mismatch")
        del runtime
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            pass
    report = {"schemaVersion": 1, "validatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "devices": args.devices, "results": results}
    report_path = validation_root / f"validation-{args.stage}.json"
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"report": str(report_path), "stage": args.stage, "devices": args.devices, "version": version("paddleocr") if args.stage == "paddle" else OVIS_REVISION}, indent=2))


if __name__ == "__main__":
    sys.exit(main())
