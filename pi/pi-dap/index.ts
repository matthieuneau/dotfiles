// pi-dap: declarative DAP debugger support for Pi, modeled on OMP's
// "03 · Drives a real debugger" subsystem (dap/defaults.json + dap/config.ts
// + the 28-op `debug` tool). Loads adapter config from the OMP precedence
// chain and registers a single `debug` tool the model can drive.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDebugTool } from "./debug-tool.ts";

export default function (pi: ExtensionAPI) {
  registerDebugTool(pi);

  // Tear down any live DAP session when the session ends so we never leak
  // adapter processes across /new, /resume, /reload, or quit.
  pi.on("session_shutdown", async () => {
    try {
      const { dapSessionManager } = await import("./session.ts");
      const active = dapSessionManager.getActive();
      if (active) await active.terminate().catch(() => {});
    } catch {
      /* ignore */
    }
  });
}
