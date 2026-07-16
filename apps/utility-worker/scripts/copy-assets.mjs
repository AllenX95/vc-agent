import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

mkdirSync(resolve("dist"), { recursive: true });
copyFileSync(resolve("src/parser.py"), resolve("dist/parser.py"));
