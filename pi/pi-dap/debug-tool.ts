// The `debug` tool: a single tool with an `action` dispatch, mirroring OMP's
// 28 DAP ops. Read-only actions surface text; mutating actions drive the
// active session. Capability-gated actions throw if the adapter lacks support.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  selectAttachAdapter,
  selectLaunchAdapter,
  resolveLaunchOverrides,
  type LaunchProgramKind,
  type LaunchAdapterSelection,
  type DapResolvedAdapter,
} from "./config.ts";
import { DapClient } from "./client.ts";
import { dapSessionManager, type DapSession, type Frame } from "./session.ts";

const ACTIONS = [
  "launch", "attach",
  "set_breakpoint", "remove_breakpoint",
  "set_instruction_breakpoint", "remove_instruction_breakpoint",
  "data_breakpoint_info", "set_data_breakpoint", "remove_data_breakpoint",
  "continue", "step_over", "step_in", "step_out", "pause",
  "evaluate", "stack_trace", "threads", "scopes", "variables",
  "disassemble", "read_memory", "write_memory",
  "modules", "loaded_sources", "custom_request",
  "output", "terminate", "sessions",
] as const;
type Action = (typeof ACTIONS)[number];

export function registerDebugTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "debug",
    label: "Debug",
    description:
      "Drive one DAP debug session: launch/attach a program, set breakpoints, step, inspect stack/scopes/variables, evaluate expressions, read memory, and capture output. Mirrors OMP's 28 DAP ops.",
    parameters: Type.Object({
      action: Type.String({ description: `One of: ${ACTIONS.join(", ")}` }),
      program: Type.Optional(Type.String({ description: "Launch target path (required for launch). Resolved relative to cwd." })),
      args: Type.Optional(Type.Array(Type.String(), { description: "Program argv for launch." })),
      adapter: Type.Optional(Type.String({ description: "Explicit adapter id; otherwise auto-selected." })),
      cwd: Type.Optional(Type.String({ description: "Working directory for launch/attach. Defaults to session cwd." })),
      file: Type.Optional(Type.String({ description: "Source file for set/remove_breakpoint." })),
      line: Type.Optional(Type.Number({ description: "Source line for set/remove_breakpoint; also instruction offset for instruction breakpoints / read_memory." })),
      column: Type.Optional(Type.Number({ description: "Source column for set/remove_breakpoint." })),
      function: Type.Optional(Type.String({ description: "Function name for set/remove_breakpoint (function breakpoints)." })),
      condition: Type.Optional(Type.String({ description: "Conditional expression for breakpoints." })),
      hit_condition: Type.Optional(Type.String({ description: "Hit-count condition for breakpoints." })),
      thread_id: Type.Optional(Type.Number({ description: "Thread selector for continue/step/pause/stack_trace. Defaults to stopped thread, then first thread." })),
      expression: Type.Optional(Type.String({ description: "Expression for evaluate (required)." })),
      context: Type.Optional(Type.String({ description: "Evaluate context. Defaults to 'repl'." })),
      frame_id: Type.Optional(Type.Number({ description: "Frame selector for evaluate/scopes. Defaults to current stopped frame." })),
      scope_id: Type.Optional(Type.Number({ description: "Variables reference (fallback for variables)." })),
      variable_ref: Type.Optional(Type.Number({ description: "Variables reference for variables (preferred)." })),
      pid: Type.Optional(Type.Number({ description: "Local process id for attach." })),
      port: Type.Optional(Type.Number({ description: "Remote attach port." })),
      host: Type.Optional(Type.String({ description: "Remote attach host." })),
      levels: Type.Optional(Type.Number({ description: "Max stack frames for stack_trace." })),
      memory_reference: Type.Optional(Type.String({ description: "Address for disassemble/read_memory/write_memory." })),
      instruction_count: Type.Optional(Type.Number({ description: "Instruction count for disassemble (required)." })),
      count: Type.Optional(Type.Number({ description: "Byte count for read_memory (required); module count for modules." })),
      data: Type.Optional(Type.String({ description: "Data for write_memory (required)." })),
      instruction_reference: Type.Optional(Type.String({ description: "Instruction reference for instruction breakpoints." })),
      access_mode: Type.Optional(Type.String({ description: "Data breakpoint access mode: read|write|readWrite." })),
      name: Type.Optional(Type.String({ description: "Data breakpoint info target name (required)." })),
      command: Type.Optional(Type.String({ description: "DAP command for custom_request (required)." })),
      arguments: Type.Optional(Type.Any({ description: "Arguments for custom_request." })),
      timeout: Type.Optional(Type.Number({ description: "Per-request seconds (default 30)." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const action = String(params.action ?? "") as Action;
      if (!ACTIONS.includes(action)) {
        throw new Error(`Unknown debug action: ${action}. Valid: ${ACTIONS.join(", ")}`);
      }
      const cwd = (params.cwd as string) || ctx.cwd;

      const requireField = (name: string, value: unknown) => {
        if (value === undefined || value === null || value === "")
          throw new Error(`${action} requires ${name}`);
      };

      switch (action) {
        case "launch": {
          requireField("program", params.program);
          const program = params.program as string;
          const programPath = resolveProgram(cwd, program);
          const kind = classifyProgram(programPath);
          const sel = selectLaunchAdapter(program, cwd, params.adapter as string | undefined, kind);
          const adapter = requireAdapter(sel);
          if (kind === "directory" && !adapter.acceptsDirectoryProgram)
            throw new Error(`launch program resolves to a directory: ${programPath} and adapter ${adapter.name} does not set acceptsDirectoryProgram`);
          const client = await DapClient.connect(adapter, cwd);
          attachSignalDisconnect(client, signal);
          const overrides = resolveLaunchOverrides(adapter, program, kind);
          const session = await dapSessionManager.launch(
            adapter,
            client,
            cwd,
            programPath,
            (params.args as string[]) ?? [],
            overrides,
          );
          const threads = await session.threads().catch(() => []);
          return textResult(
            `Launched ${adapter.name} → ${programPath}\nSession: ${session.id}\nStatus: ${session.status}\nThreads: ${threads.map((t) => `${t.id}:${t.name}`).join(", ") || "(none yet)"}`,
          );
        }

        case "attach": {
          if (params.pid === undefined && params.port === undefined)
            throw new Error("attach requires pid or port");
          const adapter = selectAttachAdapter(cwd, params.adapter as string | undefined, params.port as number | undefined);
          if (!adapter) throw new Error("No debugger adapter available for attach.");
          const client = await DapClient.connect(adapter, cwd);
          attachSignalDisconnect(client, signal);
          const attachArgs: Record<string, unknown> = {};
          if (params.pid !== undefined) attachArgs.processId = params.pid;
          if (params.port !== undefined) attachArgs.port = params.port;
          if (params.host) attachArgs.host = params.host;
          const session = await dapSessionManager.attach(adapter, client, cwd, attachArgs);
          return textResult(
            `Attached ${adapter.name} → ${params.pid !== undefined ? `pid ${params.pid}` : `${params.host ?? "127.0.0.1"}:${params.port}`}\nSession: ${session.id}\nStatus: ${session.status}`,
          );
        }

        case "set_breakpoint": {
          const s = dapSessionManager.requireActive();
          if (params.function) {
            if (!s.client.capabilities.supportsFunctionBreakpoints)
              throw new Error("Current adapter does not support function breakpoints.");
            const resp = await s.client.request("setFunctionBreakpoints", {
              breakpoints: [
                {
                  name: params.function,
                  ...(params.condition ? { condition: params.condition } : {}),
                  ...(params.hit_condition ? { hitCondition: params.hit_condition } : {}),
                },
              ],
            });
            return textResult(formatBreakpoints(resp.body?.breakpoints ?? []));
          }
          requireField("file", params.file);
          requireField("line", params.line);
          const file = resolveProgram(cwd, params.file as string);
          const lines = [params.line as number];
          const conditions: Record<number, string> = {};
          if (params.condition) conditions[params.line as number] = params.condition as string;
          const bps = await s.setBreakpoints(file, lines, conditions);
          return textResult(formatBreakpoints(bps));
        }

        case "remove_breakpoint": {
          const s = dapSessionManager.requireActive();
          if (params.function) {
            const resp = await s.client.request("setFunctionBreakpoints", { breakpoints: [] });
            return textResult(formatBreakpoints(resp.body?.breakpoints ?? []));
          }
          requireField("file", params.file);
          const file = resolveProgram(cwd, params.file as string);
          if (params.line === undefined) {
            await s.clearBreakpoints(file);
            return textResult(`Cleared all breakpoints in ${file}`);
          }
          const existing = s.breakpoints.get(file) ?? [];
          const keep = existing.filter((b) => b.line !== params.line).map((b) => b.line!);
          if (keep.length === 0) await s.clearBreakpoints(file);
          else await s.setBreakpoints(file, keep);
          return textResult(`Removed breakpoint at ${file}:${params.line}. Remaining: ${keep.length}`);
        }

        case "set_instruction_breakpoint": {
          const s = dapSessionManager.requireActive();
          if (!s.client.capabilities.supportsInstructionBreakpoints)
            throw new Error("Current adapter does not support instruction breakpoints.");
          requireField("instruction_reference", params.instruction_reference);
          const resp = await s.client.request("setInstructionBreakpoints", {
            breakpoints: [
              {
                instructionReference: params.instruction_reference,
                offset: params.line,
                ...(params.condition ? { condition: params.condition } : {}),
                ...(params.hit_condition ? { hitCondition: params.hit_condition } : {}),
              },
            ],
          });
          return textResult(formatBreakpoints(resp.body?.breakpoints ?? []));
        }

        case "remove_instruction_breakpoint": {
          const s = dapSessionManager.requireActive();
          if (!s.client.capabilities.supportsInstructionBreakpoints)
            throw new Error("Current adapter does not support instruction breakpoints.");
          await s.client.request("setInstructionBreakpoints", { breakpoints: [] });
          return textResult("Cleared all instruction breakpoints.");
        }

        case "data_breakpoint_info": {
          const s = dapSessionManager.requireActive();
          if (!s.client.capabilities.supportsDataBreakpoints)
            throw new Error("Current adapter does not support data breakpoints.");
          requireField("name", params.name);
          const resp = await s.client.request("dataBreakpointInfo", {
            name: params.name,
            variablesReference: params.variable_ref ?? params.scope_id,
            frameId: params.frame_id,
          });
          return textResult(JSON.stringify(resp.body ?? {}, null, 2));
        }

        case "set_data_breakpoint": {
          const s = dapSessionManager.requireActive();
          if (!s.client.capabilities.supportsDataBreakpoints)
            throw new Error("Current adapter does not support data breakpoints.");
          requireField("memory_reference", params.memory_reference);
          const resp = await s.client.request("setDataBreakpoints", {
            breakpoints: [
              {
                dataId: params.memory_reference,
                accessMode: params.access_mode ?? "write",
                ...(params.condition ? { condition: params.condition } : {}),
                ...(params.hit_condition ? { hitCondition: params.hit_condition } : {}),
              },
            ],
          });
          return textResult(formatBreakpoints(resp.body?.breakpoints ?? []));
        }

        case "remove_data_breakpoint": {
          const s = dapSessionManager.requireActive();
          await s.client.request("setDataBreakpoints", { breakpoints: [] });
          return textResult("Cleared all data breakpoints.");
        }

        case "continue": {
          const s = dapSessionManager.requireActive();
          const tid = await resolveThread(s, params);
          await s.continue(tid);
          return textResult(`Continued thread ${tid}. Status: ${s.status}`);
        }

        case "step_over":
        case "step_in":
        case "step_out": {
          const s = dapSessionManager.requireActive();
          const tid = await resolveThread(s, params);
          const gran = action === "step_over" ? "next" : action === "step_in" ? "stepIn" : "stepOut";
          await s.step(tid, gran);
          return textResult(`${gran} on thread ${tid}. Status: ${s.status}`);
        }

        case "pause": {
          const s = dapSessionManager.requireActive();
          const tid = await resolveThread(s, params);
          await s.pause(tid);
          return textResult(`Paused thread ${tid}.`);
        }

        case "evaluate": {
          const s = dapSessionManager.requireActive();
          requireField("expression", params.expression);
          const frameId = (params.frame_id as number) ?? s.stoppedFrame?.id;
          const result = await s.evaluate(params.expression as string, frameId, (params.context as string) ?? "repl");
          return textResult(`=> ${result}`);
        }

        case "stack_trace": {
          const s = dapSessionManager.requireActive();
          const tid = await resolveThread(s, params);
          const frames = await s.stackTrace(tid, (params.levels as number) ?? 20);
          return textResult(formatFrames(frames));
        }

        case "threads": {
          const s = dapSessionManager.requireActive();
          const threads = await s.threads();
          return textResult(threads.map((t) => `${t.id}\t${t.name}`).join("\n") || "(no threads)");
        }

        case "scopes": {
          const s = dapSessionManager.requireActive();
          const frameId = (params.frame_id as number) ?? s.stoppedFrame?.id;
          if (frameId === undefined) throw new Error("No active stack frame. Run stack_trace first or supply frame_id.");
          const scopes = await s.scopes(frameId);
          return textResult(scopes.map((sc) => `${sc.name} (ref=${sc.variablesReference}${sc.expensive ? ", expensive" : ""})`).join("\n") || "(no scopes)");
        }

        case "variables": {
          const s = dapSessionManager.requireActive();
          const ref = params.variable_ref ?? params.scope_id;
          if (ref === undefined) throw new Error("variables requires variable_ref or scope_id");
          const vars = await s.variables(ref as number);
          return textResult(vars.map((v) => `${v.name} = ${v.value}${v.type ? ` : ${v.type}` : ""}${v.variablesReference ? ` (ref=${v.variablesReference})` : ""}`).join("\n") || "(no variables)");
        }

        case "disassemble": {
          const s = dapSessionManager.requireActive();
          if (!s.client.capabilities.supportsDisassembleRequest)
            throw new Error("Current adapter does not support disassemble.");
          requireField("instruction_count", params.instruction_count);
          const memoryReference = (params.memory_reference as string) ?? s.stoppedFrame?.source?.path;
          if (!memoryReference) throw new Error("disassemble requires memory_reference unless the current stop location has an instruction pointer reference.");
          const resp = await s.client.request("disassemble", {
            memoryReference,
            instructionCount: params.instruction_count,
            instructionOffset: params.line,
            resolveSymbols: true,
          });
          return textResult(JSON.stringify(resp.body?.instructions ?? [], null, 2));
        }

        case "read_memory": {
          const s = dapSessionManager.requireActive();
          if (!s.client.capabilities.supportsReadMemoryRequest)
            throw new Error("Current adapter does not support memory reads.");
          requireField("memory_reference", params.memory_reference);
          requireField("count", params.count);
          const resp = await s.client.request("readMemory", {
            memoryReference: params.memory_reference,
            count: params.count,
            offset: params.line,
          });
          return textResult(JSON.stringify(resp.body ?? {}, null, 2));
        }

        case "write_memory": {
          const s = dapSessionManager.requireActive();
          if (!s.client.capabilities.supportsWriteMemoryRequest)
            throw new Error("Current adapter does not support memory writes.");
          requireField("memory_reference", params.memory_reference);
          requireField("data", params.data);
          const resp = await s.client.request("writeMemory", {
            memoryReference: params.memory_reference,
            data: params.data,
            offset: params.line,
            allowPartial: false,
          });
          return textResult(`Wrote memory: ${JSON.stringify(resp.body ?? {})}`);
        }

        case "modules": {
          const s = dapSessionManager.requireActive();
          if (!s.client.capabilities.supportsModulesRequest)
            throw new Error("Current adapter does not support modules.");
          const resp = await s.client.request("modules", {
            startModule: (params.frame_id as number) ?? 0,
            moduleCount: (params.count as number) ?? 1000,
          });
          return textResult(JSON.stringify(resp.body ?? {}, null, 2));
        }

        case "loaded_sources": {
          const s = dapSessionManager.requireActive();
          if (!s.client.capabilities.supportsLoadedSourcesRequest)
            throw new Error("Current adapter does not support loadedSources.");
          const resp = await s.client.request("loadedSources", {});
          return textResult(JSON.stringify(resp.body?.sources ?? [], null, 2));
        }

        case "custom_request": {
          const s = dapSessionManager.requireActive();
          requireField("command", params.command);
          const body = await s.customRequest(params.command as string, params.arguments);
          return textResult(JSON.stringify(body ?? {}, null, 2));
        }

        case "output": {
          const s = dapSessionManager.getActive();
          if (!s) return textResult("No debug session.");
          return textResult(s.getOutput() || "(no output captured)");
        }

        case "terminate": {
          const msg = await dapSessionManager.terminate();
          return textResult(msg);
        }

        case "sessions": {
          const list = dapSessionManager.sessions();
          return textResult(list.length ? JSON.stringify(list, null, 2) : "(no sessions)");
        }

        default:
          throw new Error(`Unhandled debug action: ${action}`);
      }
    },
  });
}

function resolveProgram(cwd: string, program: string): string {
  if (path.isAbsolute(program)) return program;
  if (program.startsWith("~/")) return path.join(os.homedir(), program.slice(2));
  return path.resolve(cwd, program);
}

function classifyProgram(p: string): LaunchProgramKind {
  try {
    const stat = fs.statSync(p);
    return stat.isDirectory() ? "directory" : "file";
  } catch {
    return "missing";
  }
}

function requireAdapter(sel: LaunchAdapterSelection): DapResolvedAdapter {
  if (sel.kind === "adapter") return sel.adapter;
  if (sel.kind === "unavailable")
    throw new Error(`Debugger adapter '${sel.adapterName}' is configured but its command '${sel.command}' was not found. Install it or pick another adapter.`);
  throw new Error("No debugger adapter available for this program. Configure one in ~/.pi/agent/dap.json.");
}

async function resolveThread(s: DapSession, params: any): Promise<number> {
  if (params.thread_id !== undefined) return params.thread_id as number;
  if (s.stoppedThread !== null) return s.stoppedThread;
  const threads = await s.threads();
  if (threads.length === 0) throw new Error("Debugger reported no threads.");
  return threads[0].id;
}

function attachSignalDisconnect(client: DapClient, signal: AbortSignal | undefined) {
  if (!signal) return;
  if (signal.aborted) {
    client.disconnect(false).catch(() => {});
    return;
  }
  signal.addEventListener(
    "abort",
    () => {
      client.disconnect(false).catch(() => {});
    },
    { once: true },
  );
}

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: { tool: "debug" },
  };
}

function formatBreakpoints(bps: any[]): string {
  if (!bps.length) return "(no breakpoints)";
  return bps
    .map((b, i) => `${i}: ${b.verified ? "✓" : "⚠"} ${b.source?.path ?? ""}:${b.line ?? "?"}${b.message ? ` — ${b.message}` : ""}`)
    .join("\n");
}

function formatFrames(frames: Frame[]): string {
  if (!frames.length) return "(no frames)";
  return frames
    .map((f, i) => `${i === 0 ? "▶" : " "} ${f.name} at ${f.source?.path ?? f.source?.name ?? "?"}:${f.line}:${f.column} (frame ${f.id})`)
    .join("\n");
}
