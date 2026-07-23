import importlib.metadata
import json
import os
import re
import sys
import time
from pathlib import Path


OVIS_PROMPT = """Extract all readable content from the image in natural human reading order and output the result as a single Markdown document. For charts or images, represent them using an HTML image tag: <img src=\"images/bbox_{left}_{top}_{right}_{bottom}.jpg\" />, where left, top, right, bottom are bounding box coordinates scaled to [0, 1000). Format formulas as LaTeX. Format tables as HTML: <table>...</table>. Transcribe all other text as standard Markdown. Preserve the original text without translation or paraphrasing."""


class Runtime:
    def __init__(self):
        self.paddle = {}
        self.ovis = {}

    def recover(self, command):
        started = time.perf_counter()
        stage = command["stage"]
        image = render_page(command["absolutePath"], command["pageNumber"])
        device = resolve_device(stage, command.get("device", "auto"))
        if stage == "paddle":
            result = self._paddle(image, device, Path(command["runtimeRoot"]))
        elif stage == "ovis":
            result = self._ovis(image, device, Path(command["runtimeRoot"]))
        else:
            raise ValueError(f"Unsupported OCR stage: {stage}")
        result["durationMs"] = max(0, round((time.perf_counter() - started) * 1000))
        result["device"] = device
        return result

    def _paddle(self, image, device, runtime_root):
        os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(runtime_root / "models" / "paddle"))
        import numpy as np
        from paddleocr import PaddleOCR

        paddle_device = "gpu:0" if device == "cuda" else "cpu"
        if paddle_device not in self.paddle:
            self.paddle[paddle_device] = PaddleOCR(
                device=paddle_device,
                engine="paddle_dynamic",
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                text_detection_model_name="PP-OCRv6_tiny_det",
                text_recognition_model_name="PP-OCRv6_tiny_rec",
            )
        output = list(self.paddle[paddle_device].predict(np.asarray(image)))
        payloads = [result_payload(item) for item in output]
        texts, scores, boxes = [], [], []
        for payload in payloads:
            texts.extend(str(value).strip() for value in payload.get("rec_texts", []) if str(value).strip())
            scores.extend(float(value) for value in payload.get("rec_scores", []) if value is not None)
            boxes.extend(payload.get("rec_boxes", []) or [])
        confidence = sum(scores) / len(scores) if scores else 0.0
        text = "\n".join(texts)
        return {
            "text": text,
            "confidence": max(0.0, min(1.0, confidence)),
            "structurallyInsufficient": paddle_structure_insufficient(boxes, texts),
            "adapterId": "paddleocr-local",
            "adapterVersion": package_version("paddleocr"),
            "runtimeRevision": f"paddle-{package_version('paddlepaddle-gpu', package_version('paddlepaddle', 'unknown'))}",
            "warnings": [],
        }

    def _ovis(self, image, device, runtime_root):
        import torch
        from transformers import AutoProcessor

        model_path = runtime_root / "models" / "ovisocr2"
        if not model_path.exists():
            raise FileNotFoundError(f"OvisOCR2 model snapshot is missing: {model_path}")
        if device not in self.ovis:
            try:
                from transformers import AutoModelForMultimodalLM as AutoModel
            except ImportError:
                from transformers import AutoModelForImageTextToText as AutoModel
            processor = AutoProcessor.from_pretrained(model_path, local_files_only=True)
            dtype = torch.bfloat16 if device == "cuda" else torch.float32
            model = AutoModel.from_pretrained(model_path, local_files_only=True, dtype=dtype)
            target = "cuda:0" if device == "cuda" else "cpu"
            model.to(target)
            model.eval()
            self.ovis[device] = (processor, model, target)
        processor, model, target = self.ovis[device]
        messages = [{"role": "user", "content": [{"type": "image", "image": image}, {"type": "text", "text": OVIS_PROMPT}]}]
        inputs = processor.apply_chat_template(messages, add_generation_prompt=True, tokenize=True, return_dict=True, return_tensors="pt", enable_thinking=False)
        inputs = {key: value.to(target) if hasattr(value, "to") else value for key, value in inputs.items()}
        # Bound local inference so malformed/repetitive pages cannot monopolize
        # the worker. A token-limit result is marked insufficient below, which
        # lets the pipeline retain its earlier PaddleOCR candidate.
        default_max_tokens = 2048
        max_new_tokens = max(64, min(16384, int(os.environ.get("VC_AGENT_OVIS_MAX_NEW_TOKENS", default_max_tokens))))
        with torch.inference_mode():
            outputs = model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                do_sample=False,
                eos_token_id=processor.tokenizer.eos_token_id,
                pad_token_id=processor.tokenizer.pad_token_id,
            )
        input_length = inputs["input_ids"].shape[-1]
        text = processor.decode(outputs[0][input_length:], skip_special_tokens=True).strip()
        text = clean_truncated_repeats(text)
        warnings = validate_markdown(text)
        if outputs.shape[-1] - input_length >= max_new_tokens:
            warnings.append("OVIS_TOKEN_LIMIT")
        return {
            "text": text,
            "confidence": 1.0 if text else 0.0,
            "structurallyInsufficient": bool(warnings) or not text,
            "adapterId": "ovisocr2-local",
            "adapterVersion": model_revision(model_path),
            "runtimeRevision": f"transformers-{package_version('transformers')}-torch-{package_version('torch')}",
            "warnings": warnings,
        }


def render_page(absolute_path, page_number):
    import pymupdf
    from PIL import Image

    with pymupdf.open(absolute_path) as document:
        if page_number < 1 or page_number > document.page_count:
            raise ValueError(f"Page {page_number} is outside the document")
        pixmap = document[page_number - 1].get_pixmap(matrix=pymupdf.Matrix(2.0, 2.0), alpha=False)
        return Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)


def resolve_device(stage, requested):
    if stage == "paddle":
        import paddle
        cuda_available = paddle.is_compiled_with_cuda() and paddle.device.cuda.device_count() > 0
    else:
        import torch
        cuda_available = torch.cuda.is_available()
    if requested == "cuda" and not cuda_available:
        raise RuntimeError(f"{stage} CUDA execution was requested but is unavailable")
    return "cuda" if requested == "cuda" or requested == "auto" and cuda_available else "cpu"


def result_payload(result):
    payload = getattr(result, "json", result)
    if callable(payload):
        payload = payload()
    if isinstance(payload, str):
        payload = json.loads(payload)
    if isinstance(payload, dict) and isinstance(payload.get("res"), dict):
        return json_safe(payload["res"])
    if isinstance(payload, dict):
        return json_safe(payload)
    return {}


def json_safe(value):
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    if hasattr(value, "tolist"):
        return value.tolist()
    return value


def paddle_structure_insufficient(boxes, texts):
    if not texts:
        return True
    normalized = []
    for box in boxes:
        if isinstance(box, (list, tuple)) and len(box) >= 4:
            normalized.append(tuple(float(value) for value in box[:4]))
    if len(normalized) < 6:
        return False
    row_counts = []
    for box in sorted(normalized, key=lambda item: item[1]):
        center = (box[1] + box[3]) / 2
        for row in row_counts:
            if abs(row[0] - center) <= max(8.0, (box[3] - box[1]) * 0.6):
                row[1] += 1
                break
        else:
            row_counts.append([center, 1])
    table_like_rows = sum(1 for _, count in row_counts if count >= 3)
    formula_markers = sum(1 for text in texts if re.search(r"[=∑∫√±×÷]|\b(?:sin|cos|log)\b", text))
    return table_like_rows >= 3 or formula_markers >= 2


def validate_markdown(text):
    warnings = []
    if not text:
        return ["OVIS_EMPTY_OUTPUT"]
    if text.count("<table") != text.count("</table>"):
        warnings.append("OVIS_TABLE_UNBALANCED")
    if text.count("$$") % 2 != 0:
        warnings.append("OVIS_FORMULA_UNBALANCED")
    if len(text) >= 16000 and clean_truncated_repeats(text) != text:
        warnings.append("OVIS_TRUNCATED_REPEAT")
    return warnings


def clean_truncated_repeats(text, min_text_len=8000, max_period=200, min_repeat_chars=100, min_repeat_times=5):
    n = len(text)
    if n < min_text_len:
        return text
    for unit_len in range(1, min(max_period, n - 1) + 1):
        if text[n - 1] != text[n - 1 - unit_len]:
            continue
        match_len, index = 1, n - 2
        while index >= unit_len and text[index] == text[index - unit_len]:
            match_len += 1
            index -= 1
        total_len = match_len + unit_len
        repeat_times, tail_len = divmod(total_len, unit_len)
        if repeat_times >= min_repeat_times and total_len >= min_repeat_chars:
            return text[: n - total_len + unit_len] + text[n - tail_len:]
    return text


def package_version(name, fallback="unknown"):
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return fallback


def model_revision(model_path):
    marker = model_path / "vc-agent-revision.txt"
    return marker.read_text(encoding="utf-8").strip() if marker.exists() else "ATH-MaaS/OvisOCR2"


def serve():
    runtime = Runtime()
    for line in sys.stdin:
        try:
            command = json.loads(line)
            response = {"requestId": command["requestId"], "ok": True, "result": runtime.recover(command)}
        except Exception as error:
            response = {"requestId": command.get("requestId", "unknown") if "command" in locals() else "unknown", "ok": False, "error": {"type": type(error).__name__, "message": str(error)[:2000]}}
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    os.environ.setdefault("PYTHONUTF8", "1")
    serve()
