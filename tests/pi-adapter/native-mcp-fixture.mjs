import { appendFileSync } from "node:fs";

const startedPath = process.argv[2];
const closedPath = process.argv[3];
const callsPath = process.argv[4];

if (startedPath !== undefined) appendFileSync(startedPath, "started\n", "utf8");

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
      process.stderr.write(`native MCP fixture protocol error: ${String(error)}\n`);
    }
  }
});
process.stdin.resume();
const markClosed = () => {
  if (closedPath !== undefined) appendFileSync(closedPath, "closed\n", "utf8");
};
process.stdin.on("end", markClosed);
process.stdin.on("close", markClosed);
process.on("SIGTERM", () => {
  markClosed();
  process.exit(0);
});

function handle(message) {
  if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return;
  if (message.id === undefined) return;
  switch (message.method) {
    case "initialize":
      respond(message.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "vc-agent-native-mcp-fixture", version: "1.0.0" }
      });
      return;
    case "tools/list":
      respond(message.id, { tools: [
        {
          name: "fixture.search",
          description: "Bounded fixture read",
          inputSchema: { type: "object", properties: { query: { type: "string" } }, additionalProperties: false }
        }
      ] });
      return;
    case "resources/list":
      respond(message.id, { resources: [] });
      return;
    case "tools/call": {
      if (callsPath !== undefined) appendFileSync(callsPath, `${String(message.params?.name)}\n`, "utf8");
      respond(message.id, {
        content: [{ type: "text", text: JSON.stringify({ server: "vc-agent-native-mcp-fixture", tool: message.params?.name, arguments: message.params?.arguments ?? {} }) }],
        isError: false
      });
      return;
    }
    case "ping":
      respond(message.id, {});
      return;
    default:
      respondError(message.id, -32601, `Unsupported native MCP fixture method: ${String(message.method)}`);
  }
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}
