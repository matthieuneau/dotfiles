// DAP session manager: one active session at a time, with a breakpoint cache,
// stopped-location cache, thread/stack/frame cache, and captured output.
// Mirrors the state surface of OMP's dap/session.ts.

import { DapClient } from "./client.ts";
import type { DapResolvedAdapter } from "./config.ts";

export interface Breakpoint {
  id?: number;
  verified: boolean;
  line?: number;
  column?: number;
  message?: string;
  source?: { path?: string; name?: string };
}
export interface Frame {
  id: number;
  name: string;
  source?: { path?: string; name?: string };
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  moduleId?: number;
  presentationHint?: string;
}
export interface Scope {
  name: string;
  variablesReference: number;
  expensive: boolean;
  source?: { path?: string; name?: string };
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}
export interface Variable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  evaluateName?: string;
  memoryReference?: string;
  presentationHint?: any;
}
export interface Thread {
  id: number;
  name: string;
}
export interface SessionSummary {
  id: string;
  adapter: string;
  status: "running" | "stopped" | "terminated" | "exited";
  program?: string;
  stoppedReason?: string;
  stoppedThread?: number;
  stoppedFrame?: Frame;
}

let sessionIdCounter = 0;

export class DapSession {
  id: string;
  adapter: DapResolvedAdapter;
  client: DapClient;
  program?: string;
  cwd: string;
  status: "running" | "stopped" | "terminated" | "exited" = "running";
  threadList: Thread[] = [];
  frames: Frame[] = [];
  stoppedFrame: Frame | null = null;
  stoppedThread: number | null = null;
  stoppedReason: string | null = null;
  breakpoints = new Map<string, Breakpoint[]>(); // file path -> breakpoints
  output: string[] = [];
  private detach: () => void;

  constructor(adapter: DapResolvedAdapter, client: DapClient, cwd: string, program?: string) {
    this.id = `dap-${++sessionIdCounter}`;
    this.adapter = adapter;
    this.client = client;
    this.cwd = cwd;
    this.program = program;
    this.detach = client.onEvent((ev) => this.handleEvent(ev));
  }

  private handleEvent(ev: { event: string; body?: any }) {
    switch (ev.event) {
      case "output": {
        const b = ev.body ?? {};
        const line = b.output ?? "";
        const prefix = b.category ? `[${b.category}] ` : "";
        this.output.push(`${prefix}${line}`);
        if (this.output.length > 4000) this.output = this.output.slice(-4000);
        break;
      }
      case "stopped": {
        this.status = "stopped";
        this.stoppedReason = ev.body?.reason ?? "unknown";
        this.stoppedThread = ev.body?.threadId ?? this.stoppedThread;
        this.frames = [];
        this.stoppedFrame = null;
        break;
      }
      case "continued": {
        this.status = "running";
        this.frames = [];
        this.stoppedFrame = null;
        break;
      }
      case "terminated":
        this.status = "terminated";
        break;
      case "exited":
        this.status = "exited";
        break;
      case "thread":
        // Thread updates are picked up lazily via threads() calls.
        break;
    }
  }

  summary(): SessionSummary {
    return {
      id: this.id,
      adapter: this.adapter.name,
      status: this.status,
      program: this.program,
      stoppedReason: this.stoppedReason ?? undefined,
      stoppedThread: this.stoppedThread ?? undefined,
      stoppedFrame: this.stoppedFrame ?? undefined,
    };
  }

  async terminate(): Promise<void> {
    try {
      await this.client.request("terminate", { restart: false }, 5000).catch(() => {});
    } catch {
      /* ignore */
    }
    await this.client.disconnect(true);
    this.detach();
    this.status = "terminated";
  }

  async threads(): Promise<Thread[]> {
    const resp = await this.client.request("threads", {});
    this.threadList = resp.body?.threads ?? [];
    return this.threadList;
  }

  async stackTrace(threadId: number, levels = 20): Promise<Frame[]> {
    const resp = await this.client.request("stackTrace", { threadId, levels, startFrame: 0 });
    this.frames = (resp.body?.stackFrames ?? []).map((f: any) => ({
      id: f.id,
      name: f.name,
      source: f.source,
      line: f.line,
      column: f.column,
      endLine: f.endLine,
      endColumn: f.endColumn,
      moduleId: f.moduleId,
      presentationHint: f.presentationHint,
    }));
    if (this.frames.length > 0) this.stoppedFrame = this.frames[0];
    return this.frames;
  }

  async scopes(frameId: number): Promise<Scope[]> {
    const resp = await this.client.request("scopes", { frameId });
    return (resp.body?.scopes ?? []).map((s: any) => ({
      name: s.name,
      variablesReference: s.variablesReference,
      expensive: s.expensive,
      source: s.source,
      line: s.line,
      column: s.column,
      endLine: s.endLine,
      endColumn: s.endColumn,
    }));
  }

  async variables(variablesReference: number): Promise<Variable[]> {
    const resp = await this.client.request("variables", { variablesReference });
    return (resp.body?.variables ?? []).map((v: any) => ({
      name: v.name,
      value: v.value,
      type: v.type,
      variablesReference: v.variablesReference,
      evaluateName: v.evaluateName,
      memoryReference: v.memoryReference,
      presentationHint: v.presentationHint,
    }));
  }

  async setBreakpoints(path: string, lines: number[], conditions?: Record<number, string>): Promise<Breakpoint[]> {
    const source = { path };
    const bps = lines.map((line) => ({
      line,
      ...(conditions?.[line] ? { condition: conditions[line] } : {}),
    }));
    const resp = await this.client.request("setBreakpoints", {
      source,
      breakpoints: bps,
      lines, // legacy
      sourceModified: false,
    });
    const set = (resp.body?.breakpoints ?? []).map((b: any) => ({
      id: b.id,
      verified: b.verified,
      line: b.line,
      column: b.column,
      message: b.message,
      source: b.source,
    }));
    this.breakpoints.set(path, set);
    return set;
  }

  async clearBreakpoints(path: string): Promise<void> {
    await this.client.request("setBreakpoints", { source: { path }, breakpoints: [], lines: [] });
    this.breakpoints.delete(path);
  }

  async continue(threadId: number): Promise<void> {
    await this.client.request("continue", { threadId });
    this.status = "running";
    this.frames = [];
    this.stoppedFrame = null;
  }

  async step(threadId: number, granularity: "next" | "stepIn" | "stepOut" | "stepBack"): Promise<void> {
    const cmd = granularity === "next" ? "next" : granularity === "stepIn" ? "stepIn" : granularity === "stepOut" ? "stepOut" : "stepBack";
    await this.client.request(cmd, { threadId });
    this.status = "running";
    this.frames = [];
    this.stoppedFrame = null;
  }

  async pause(threadId: number): Promise<void> {
    await this.client.request("pause", { threadId });
  }

  async evaluate(expression: string, frameId?: number, context: string = "repl"): Promise<string> {
    const resp = await this.client.request("evaluate", {
      expression,
      frameId,
      context,
    });
    return resp.body?.result ?? "";
  }

  async customRequest(command: string, args?: any): Promise<any> {
    const resp = await this.client.request(command, args);
    return resp.body;
  }

  getOutput(): string {
    return this.output.join("");
  }
}

export class DapSessionManager {
  private active: DapSession | null = null;

  getActive(): DapSession | null {
    return this.active;
  }

  requireActive(): DapSession {
    if (!this.active) throw new Error("No active debug session. Launch or attach first.");
    return this.active;
  }

  async launch(adapter: DapResolvedAdapter, client: DapClient, cwd: string, program: string, args: string[], overrides?: Record<string, unknown>): Promise<DapSession> {
    if (this.active && (this.active.status === "running" || this.active.status === "stopped")) {
      throw new Error(`Debug session ${this.active.id} is still active. Terminate it before launching another.`);
    }
    await client.initialize("pi-dap", adapter.name, cwd);
    // launchDefaults < adapter-specific overrides < explicit program/args/cwd.
    const launchArgs: Record<string, unknown> = {
      ...adapter.launchDefaults,
      ...(overrides ?? {}),
      program,
      args,
      cwd,
    };
    // debugpy (and some other adapters) only emit the `launch` response AFTER
    // `configurationDone` is received. Awaiting launch first therefore deadlocks.
    // Send configurationDone in parallel, then await the launch response.
    const launchP = client.request("launch", launchArgs);
    if (client.capabilities.supportsConfigurationDoneRequest) {
      await client.request("configurationDone", {}).catch(() => {});
    }
    await launchP;
    const session = new DapSession(adapter, client, cwd, program);
    this.active = session;
    return session;
  }

  async attach(adapter: DapResolvedAdapter, client: DapClient, cwd: string, attachArgs: Record<string, unknown>): Promise<DapSession> {
    if (this.active && (this.active.status === "running" || this.active.status === "stopped")) {
      throw new Error(`Debug session ${this.active.id} is still active. Terminate it before attaching another.`);
    }
    await client.initialize("pi-dap", adapter.name, cwd);
    // Same configurationDone-gating as launch (see launch() above).
    const attachP = client.request("attach", { ...adapter.attachDefaults, ...attachArgs });
    if (client.capabilities.supportsConfigurationDoneRequest) {
      await client.request("configurationDone", {}).catch(() => {});
    }
    await attachP;
    const session = new DapSession(adapter, client, cwd);
    this.active = session;
    return session;
  }

  async terminate(): Promise<string> {
    const s = this.active;
    if (!s) return "No debug session to terminate.";
    await s.terminate();
    this.active = null;
    return `Terminated ${s.id}.`;
  }

  sessions(): SessionSummary[] {
    return this.active ? [this.active.summary()] : [];
  }
}

export const dapSessionManager = new DapSessionManager();
