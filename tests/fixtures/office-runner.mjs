import { readFileSync, writeFileSync } from "node:fs";

// Test-only runner for the explicit stdin-manifest contract. It creates a
// structurally valid OOXML ZIP so the real worker path cannot regress back to
// accepting plain text fixtures. It is never used by the production adapter.
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  void run();
});

async function run() {
  const manifest = JSON.parse(input);
  const delayIndex = process.argv.indexOf("--delay-ms");
  const delayMs = delayIndex >= 0 ? Number(process.argv[delayIndex + 1] ?? 0) : 0;
  if (Number.isFinite(delayMs) && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  const source = manifest.kind === "edit" && manifest.inputPaths?.[0] ? readFileSync(manifest.inputPaths[0]) : undefined;
  const marker = source === undefined ? "created" : "edited";
  writeFileSync(manifest.outputPath, zip({
    "[Content_Types].xml": "<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"xml\" ContentType=\"application/xml\"/></Types>",
    "word/document.xml": `<document><body><p>${marker}</p></body></document>`,
    "docProps/core.xml": `<coreProperties><subject>${manifest.format}</subject></coreProperties>`
  }));
  if (manifest.previewPath) writeFileSync(manifest.previewPath, "%PDF-1.7\nfixture preview\n");
}

function zip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(value, "utf8");
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(nameBytes.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, nameBytes);
    offset += header.length + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
