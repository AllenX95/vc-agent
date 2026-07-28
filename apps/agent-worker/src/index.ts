import { createPiSession } from "@vc-agent/pi-adapter";
import { startAgentWorker } from "./worker-runtime.js";

startAgentWorker({
  createSession: ({ config, command, onEvent }) =>
    createPiSession({ ...config, profile: command.profile }, onEvent)
});
