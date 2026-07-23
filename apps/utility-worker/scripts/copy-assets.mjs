import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

mkdirSync(resolve("dist"), { recursive: true });
copyFileSync(resolve("src/parser.py"), resolve("dist/parser.py"));
copyFileSync(resolve("src/ocr_runtime.py"), resolve("dist/ocr_runtime.py"));
