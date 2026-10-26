// DAP JSON-RPC client. Implements Content-Length framing over stdio and TCP,
// request/response correlation, event dispatch, capability negotiation, and
// graceful shutdown. Mirrors the transport layer of OMP's dap/client.ts.

import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import * as path from "node:path";
import { DAP_PORT_ARG, type DapResolvedAdapter } from "./config.ts";

export interface DapCapabilities {
  supportsConfigurationDoneRequest?: boolean;
  supportsFunctionBreakpoints?: boolean;
  supportsConditionalBreakpoints?: boolean;
  supportsHitConditionalBreakpoints?: boolean;
  supportsEvaluateForHovers?: boolean;
  supportsStepBack?: boolean;
  supportsSetVariable?: boolean;
  supportsRestartFrame?: boolean;
  supportsGotoTargetsRequest?: boolean;
  supportsStepInTargetsRequest?: boolean;
  supportsTerminateRequest?: boolean;
  supportsTerminateDebuggee?: boolean;
  supportsDelayedStackTraceLoading?: boolean;
  supportsLoadedSourcesRequest?: boolean;
  supportsLogPoints?: boolean;
  supportsTerminateThreadsRequest?: boolean;
  supportsStartDebuggingRequest?: boolean;
  supportsReadMemoryRequest?: boolean;
  supportsWriteMemoryRequest?: boolean;
  supportsDisassembleRequest?: boolean;
  supportsModulesRequest?: boolean;
  supportsValueFormattingOptions?: boolean;
  supportsExceptionInfoRequest?: boolean;
  supportTerminateDebuggee?: boolean;
  supportsBreakpointLocationsRequest?: boolean;
  supportsClipboardContext?: boolean;
  supportsSteppingGranularity?: boolean;
  supportsInstructionBreakpoints?: boolean;
  supportsDataBreakpoints?: boolean;
  exceptionBreakpointFilters?: Array<{ filter: string; label: string; default?: boolean }>;
  additionalModuleColumns?: unknown;
  supportedChecksumAlgorithms?: unknown;
}

export interface DapResponse {
  command: string;
  success: boolean;
  message?: string;
  body?: any;
}
export interface DapEvent {
  event: string;
  body?: any;
}
export type EventHandler = (event: DapEvent) => void;

interface Pending {
  command: string;
  resolve: (r: DapResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class DapClient {
  private seq = 0;
  private pending = new Map<number, Pending>();
  private buffer = Buffer.alloc(0);
  private transport: { writable: { write: (b: Buffer) => void }; close: () => void };
  private closed = false;
  private eventHandlers: EventHandler[] = [];
  readonly proc?: ChildProcess;
  readonly capabilities: DapCapabilities = {};
  private stderrTail = "";

  private constructor(
    transport: DapClient["transport"],
    proc?: ChildProcess,
  ) {
    this.transport = transport;
    this.proc = proc;
  }

  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.push(handler);
    return () => {
      this.eventHandlers = this.eventHandlers.filter((h) => h !== handler);
    };
  }

  getStderrTail(): string {
    return this.stderrTail;
  }

  static async connect(adapter: DapResolvedAdapter, cwd: string): Promise<DapClient> {
    if (adapter.connectMode === "tcp") {
      return connectTcp(adapter, cwd);
    }
    if (adapter.connectMode === "socket") {
      // dlv-style: pick a free port, append --listen 127.0.0.1:<port>, connect TCP.
      return connectDlvSocket(adapter, cwd);
    }
    return connectStdio(adapter, cwd);
  }

  private feed(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf-8");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        // Skip a malformed header block.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const len = parseInt(m[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + len) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + len).toString("utf-8");
      this.buffer = this.buffer.subarray(bodyStart + len);
      try {
        const msg = JSON.parse(body);
        this.dispatch(msg);
      } catch {
        /* ignore malformed */
      }
    }
  }

  private dispatch(msg: any) {
    if (msg.type === "response") {
      const p = this.pending.get(msg.request_seq);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.request_seq);
      const response: DapResponse = { command: msg.command, success: !!msg.success, message: msg.message, body: msg.body };
      if (response.success) p.resolve(response);
      else p.reject(new Error(`${p.command} failed: ${msg.message ?? "unknown error"}`));
    } else if (msg.type === "event") {
      for (const h of this.eventHandlers) {
        try {
          h({ event: msg.event, body: msg.body });
        } catch {
          /* handler errors must not break the loop */
        }
      }
    }
  }

  request<T = any>(command: string, args?: any, timeoutMs = 30000): Promise<DapResponse & { body?: T }> {
    if (this.closed) return Promise.reject(new Error("DAP client closed"));
    const seq = ++this.seq;
    const message = JSON.stringify({ seq, type: "request", command, arguments: args });
    const payload = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(seq)) reject(new Error(`DAP request ${command} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(seq, { command, resolve: resolve as any, reject, timer });
      try {
        this.transport.writable.write(Buffer.from(payload, "utf-8"));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(seq);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  async initialize(clientName: string, adapterID: string, cwd: string): Promise<DapCapabilities> {
    const resp = await this.request("initialize", {
      clientID: clientName,
      clientName,
      adapterID,
      locale: "en-US",
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: "path",
      supportsVariableType: true,
      supportsVariablePaging: false,
      supportsRunInTerminalRequest: false,
      supportsMemoryReferences: true,
      supportsProgressReporting: false,
      supportsInvalidatedEvent: false,
    });
    Object.assign(this.capabilities as object, resp.body ?? {});
    return this.capabilities;
  }

  async disconnect(terminate: boolean): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.request("disconnect", { terminateDebuggee: terminate }, 5000).catch(() => {});
    } catch {
      /* ignore */
    }
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("DAP client disconnected"));
    }
    this.pending.clear();
    try {
      this.transport.close();
    } catch {
      /* ignore */
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

function attachStdioListeners(client: DapClient, proc: ChildProcess) {
  proc.stdout?.on("data", (chunk: Buffer) => client["feed"](chunk));
  proc.stderr?.on("data", (chunk: Buffer) => {
    client["stderrTail"] = `${client["stderrTail"]}${chunk.toString()}`.slice(-4000);
  });
  proc.on("exit", () => {
    if (!client.isClosed) client.disconnect(false).catch(() => {});
  });
}

function connectStdio(adapter: DapResolvedAdapter, cwd: string): Promise<DapClient> {
  return new Promise((resolve, reject) => {
    const proc = spawn(adapter.resolvedCommand, adapter.args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    proc.on("error", (e) => reject(e));
    const writable = {
      write: (b: Buffer) => {
        proc.stdin?.write(b);
      },
    };
    const client = new DapClient(
      {
        writable,
        close: () => {
          try {
            proc.stdin?.end();
          } catch {
            /* ignore */
          }
          try {
            proc.kill();
          } catch {
            /* ignore */
          }
        },
      },
      proc,
    );
    attachStdioListeners(client, proc);
    // Wait briefly for the process to be alive; resolve on first stdout byte or error.
    const onFirst = () => {
      clearTimeout(failTimer);
      resolve(client);
    };
    proc.stdout?.once("data", onFirst);
    proc.stderr?.once("data", onFirst);
    const failTimer = setTimeout(() => {
      // If nothing arrived but the process is alive, assume ready.
      if (!client.isClosed) resolve(client);
      else reject(new Error(`DAP adapter ${adapter.name} failed to start`));
    }, 3000);
    proc.on("error", (e) => {
      clearTimeout(failTimer);
      reject(e);
    });
  });
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("could not pick a free port"));
      }
    });
  });
}

function connectTcp(adapter: DapResolvedAdapter, cwd: string): Promise<DapClient> {
  return new Promise(async (resolve, reject) => {
    try {
      const port = await pickFreePort();
      const args = adapter.args.map((a) => a.replaceAll(DAP_PORT_ARG, String(port)));
      const proc = spawn(adapter.resolvedCommand, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });
      proc.on("error", reject);
      proc.stderr?.on("data", (chunk: Buffer) => {
        // keep a tail for diagnostics
        (proc as any).__stderrTail = `${(proc as any).__stderrTail ?? ""}${chunk.toString()}`.slice(-4000);
      });
      // Give the server a moment to listen, then connect.
      setTimeout(() => {
        const sock = net.connect(port, "127.0.0.1");
        sock.on("error", (e) => reject(e));
        sock.on("connect", () => {
          const client = new DapClient(
            {
              writable: { write: (b: Buffer) => sock.write(b) },
              close: () => {
                try {
                  sock.end();
                } catch {
                  /* ignore */
                }
                try {
                  proc.kill();
                } catch {
                  /* ignore */
                }
              },
            },
            proc,
          );
          sock.on("data", (chunk: Buffer) => client["feed"](chunk));
          sock.on("close", () => {
            if (!client.isClosed) client.disconnect(false).catch(() => {});
          });
          resolve(client);
        });
      }, 500);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

// dlv's `dap` subcommand listens on TCP. We append --listen 127.0.0.1:<port>.
function connectDlvSocket(adapter: DapResolvedAdapter, cwd: string): Promise<DapClient> {
  const tcpAdapter: DapResolvedAdapter = {
    ...adapter,
    args: [...adapter.args, "--listen", `127.0.0.1:${DAP_PORT_ARG}`],
    connectMode: "tcp",
  };
  return connectTcp(tcpAdapter, cwd);
}
