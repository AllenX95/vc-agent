import { appendFileSync } from "node:fs";

const counterPath = process.argv[2];
const callLogPath = process.argv[3];
if (counterPath !== undefined) appendFileSync(counterPath, "started\n", "utf8");

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length === 0) continue;
    try {
      handle(JSON.parse(line));
    } catch (error) {
      process.stderr.write(`fixture MCP protocol error: ${String(error)}\n`);
    }
  }
});
process.stdin.resume();
process.on("SIGTERM", () => process.exit(0));

function handle(message) {
  if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return;
  if (message.id === undefined) return;
  switch (message.method) {
    case "initialize":
      respond(message.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "vc-agent-fixture-mcp", version: "1.0.0" }
      });
      return;
    case "tools/list":
      respond(message.id, { tools: [
        {
          name: "fixture.search",
          description: "Bounded fixture read",
          inputSchema: { type: "object", properties: { query: { type: "string" } }, additionalProperties: false }
        },
        {
          name: "fixture.write",
          description: "Explicitly confirmed fixture write",
          inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false }
        }
      ] });
      return;
    case "resources/list":
      respond(message.id, { resources: [] });
      return;
    case "tools/call": {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      if (callLogPath !== undefined) appendFileSync(callLogPath, `${String(name)}\n`, "utf8");
      respond(message.id, {
        content: [{ type: "text", text: JSON.stringify({ server: "vc-agent-fixture-mcp", tool: name, arguments: args }) }],
        isError: false
      });
      return;
    }
    case "ping":
      respond(message.id, {});
      return;
    default:
      respondError(message.id, -32601, `Unsupported fixture MCP method: ${String(message.method)}`);
  }
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}
