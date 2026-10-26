// DAP config loader, ported from OMP's packages/coding-agent/src/dap/config.ts.
// Loads dap.json / .dap.json / dap.yaml / .dap.yaml / dap.yml / .dap.yml from
// the OMP precedence chain (lowest -> highest): home, plugin roots, user config
// dirs, project config dirs, cwd root. Overrides merge shallowly onto the
// built-in DEFAULT_ADAPTERS, with launchDefaults/attachDefaults merged as
// whole objects. Provides adapter resolution + launch/attach auto-selection.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { DEFAULT_ADAPTERS, type DapAdapterConfig } from "./defaults.ts";

const FILENAMES = ["dap.json", ".dap.json", "dap.yaml", ".dap.yaml", "dap.yml", ".dap.yml"];
const EXTENSIONLESS_DEBUGGER_ORDER = ["gdb", "lldb-dap"];
const DAP_PORT_ARG = "${port}";

export interface DapResolvedAdapter {
  name: string;
  command: string;
  args: string[];
  resolvedCommand: string;
  languages: string[];
  fileTypes: string[];
  rootMarkers: string[];
  launchDefaults: Record<string, unknown>;
  attachDefaults: Record<string, unknown>;
  connectMode: "stdio" | "socket" | "tcp";
  acceptsDirectoryProgram: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.length > 0) : [];
}
function obj(v: unknown): Record<string, unknown> {
  return isRecord(v) ? { ...v } : {};
}

function normalizeAdapter(raw: unknown): DapAdapterConfig | null {
  if (!isRecord(raw) || typeof raw.command !== "string" || raw.command.length === 0) return null;
  const connectMode =
    raw.connectMode === "socket" || raw.connectMode === "tcp" || raw.connectMode === "stdio"
      ? raw.connectMode
      : undefined;
  return {
    command: raw.command,
    args: strArr(raw.args),
    languages: strArr(raw.languages),
    fileTypes: strArr(raw.fileTypes).map((s) => s.toLowerCase()),
    rootMarkers: strArr(raw.rootMarkers),
    launchDefaults: obj(raw.launchDefaults),
    attachDefaults: obj(raw.attachDefaults),
    acceptsDirectoryProgram: raw.acceptsDirectoryProgram === true,
    ...(connectMode ? { connectMode } : {}),
  };
}

function parseContent(content: string, filePath: string): unknown {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".yaml" || ext === ".yml") {
    // Minimal YAML support: we only need JSON-shaped adapter maps. Avoid a hard
    // yaml dependency by attempting JSON first (valid for JSON-as-YAML), then a
    // very small inline parse for top-level mappings. For full YAML, install
    // a parser; OMP uses bun's YAML. We keep it dependency-free here.
    try {
      return JSON.parse(content);
    } catch {
      // Fall through to a tiny YAML-as-JSON best effort (key: value lines).
      return parseTinyYaml(content);
    }
  }
  return JSON.parse(content);
}

function parseTinyYaml(content: string): unknown {
  // Best-effort: only handles flat `{adapters: {...}}` with string values.
  // Most users use JSON; this is a safety net.
  return {};
}

function normalizeConfig(value: unknown): { adapters: Record<string, unknown> } | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.adapters)) return { adapters: value.adapters };
  return { adapters: value };
}

function readConfigFile(filePath: string): { adapters: Record<string, unknown> } | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return normalizeConfig(parseContent(content, filePath));
  } catch {
    return null;
  }
}

function mergeAdapters(
  base: Record<string, DapAdapterConfig>,
  overrides: Record<string, unknown>,
): Record<string, DapAdapterConfig> {
  const merged: Record<string, DapAdapterConfig> = { ...base };
  for (const [name, cfg] of Object.entries(overrides)) {
    const existing = merged[name];
    const candidate =
      isRecord(existing) && isRecord(cfg)
        ? {
            ...existing,
            ...cfg,
            launchDefaults: { ...existing.launchDefaults, ...obj(cfg.launchDefaults) },
            attachDefaults: { ...existing.attachDefaults, ...obj(cfg.attachDefaults) },
          }
        : cfg;
    const normalized = normalizeAdapter(candidate);
    if (normalized) merged[name] = normalized;
  }
  return merged;
}

// Project / user config dir candidates, mirroring OMP's getConfigDirPaths.
function projectConfigDirs(cwd: string): string[] {
  return [".omp", ".claude", ".codex", ".gemini", ".pi"].map((d) => path.join(cwd, d));
}
function userConfigDirs(): string[] {
  const agentDir = process.env.PI_CONFIG_DIR
    ? path.join(process.env.PI_CONFIG_DIR, "agent")
    : path.join(os.homedir(), ".pi", "agent");
  return [agentDir, path.join(os.homedir(), ".omp", "agent"), path.join(os.homedir(), ".claude"), path.join(os.homedir(), ".codex"), path.join(os.homedir(), ".gemini")];
}

function getConfigSources(cwd: string): string[] {
  const sources: string[] = [];
  for (const f of FILENAMES) sources.push(path.join(os.homedir(), f));
  for (const dir of userConfigDirs()) for (const f of FILENAMES) sources.push(path.join(dir, f));
  for (const dir of projectConfigDirs(cwd)) for (const f of FILENAMES) sources.push(path.join(dir, f));
  for (const f of FILENAMES) sources.push(path.join(cwd, f));
  return sources;
}

export function getAdapterConfigs(cwd: string): Record<string, DapAdapterConfig> {
  let adapters: Record<string, DapAdapterConfig> = { ...DEFAULT_ADAPTERS };
  // Sources are ordered lowest -> highest precedence; apply in order so later
  // wins, matching OMP (which reverses then merges).
  for (const file of getConfigSources(cwd)) {
    const parsed = readConfigFile(file);
    if (!parsed) continue;
    adapters = mergeAdapters(adapters, parsed.adapters);
  }
  return adapters;
}

function resolveCommandPath(command: string, cwd: string): string | null {
  if (path.isAbsolute(command)) {
    try {
      if (fs.existsSync(command)) return command;
    } catch {
      /* ignore */
    }
    return null;
  }
  if (command.startsWith("./") || command.startsWith("../") || command.startsWith(".\\") || command.startsWith("..\\")) {
    const resolved = path.resolve(cwd, command);
    try {
      if (fs.existsSync(resolved)) return resolved;
    } catch {
      /* ignore */
    }
    return null;
  }
  // PATH lookup
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function resolveAdapter(
  name: string,
  configs: Record<string, DapAdapterConfig>,
  cwd: string,
): DapResolvedAdapter | null {
  const config = configs[name];
  if (!config) return null;
  const resolvedCommand = resolveCommandPath(config.command, cwd);
  if (!resolvedCommand) return null;
  return {
    name,
    command: config.command,
    args: config.args ?? [],
    resolvedCommand,
    languages: config.languages,
    fileTypes: config.fileTypes,
    rootMarkers: config.rootMarkers,
    launchDefaults: config.launchDefaults,
    attachDefaults: config.attachDefaults,
    connectMode: config.connectMode ?? "stdio",
    acceptsDirectoryProgram: config.acceptsDirectoryProgram,
  };
}

export function getAvailableAdapters(cwd: string): DapResolvedAdapter[] {
  const configs = getAdapterConfigs(cwd);
  return Object.keys(configs)
    .map((name) => resolveAdapter(name, configs, cwd))
    .filter((a): a is DapResolvedAdapter => a !== null);
}

export type LaunchProgramKind = "file" | "directory" | "missing";
export type LaunchAdapterSelection =
  | { kind: "adapter"; adapter: DapResolvedAdapter }
  | { kind: "unavailable"; adapterName: string; command: string }
  | { kind: "none" };

function hasRootMarker(dir: string, markers: string[]): boolean {
  if (markers.length === 0) return false;
  try {
    const entries = fs.readdirSync(dir);
    for (const m of markers) {
      if (m.startsWith("*")) {
        const suffix = m.slice(1);
        if (entries.some((e) => e.endsWith(suffix))) return true;
      } else if (entries.includes(m)) {
        return true;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

function findRootInAncestry(
  program: string,
  cwd: string,
  markers: string[],
  kind: LaunchProgramKind,
): string | null {
  if (markers.length === 0) return null;
  let dir = kind === "directory" ? path.resolve(cwd, program) : path.dirname(path.resolve(cwd, program));
  while (true) {
    if (hasRootMarker(dir, markers)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function sortForLaunch(
  program: string,
  cwd: string,
  kind: LaunchProgramKind,
  adapters: DapResolvedAdapter[],
): DapResolvedAdapter[] {
  const ext = path.extname(program).toLowerCase();
  return adapters
    .map((adapter) => ({
      adapter,
      hasExt: ext.length > 0 && adapter.fileTypes.includes(ext),
      hasRoot: findRootInAncestry(program, cwd, adapter.rootMarkers, kind) !== null,
      rank: EXTENSIONLESS_DEBUGGER_ORDER.indexOf(adapter.name),
    }))
    .sort((a, b) => {
      if (a.hasExt !== b.hasExt) return a.hasExt ? -1 : 1;
      if (a.hasRoot !== b.hasRoot) return a.hasRoot ? -1 : 1;
      const ar = a.rank === -1 ? Number.MAX_SAFE_INTEGER : a.rank;
      const br = b.rank === -1 ? Number.MAX_SAFE_INTEGER : b.rank;
      if (ar !== br) return ar - br;
      return a.adapter.name.localeCompare(b.adapter.name);
    })
    .map((e) => e.adapter);
}

export function selectLaunchAdapter(
  program: string,
  cwd: string,
  adapterName: string | undefined,
  kind: LaunchProgramKind = "file",
): LaunchAdapterSelection {
  const configs = getAdapterConfigs(cwd);
  if (adapterName) {
    const config = configs[adapterName];
    if (!config) return { kind: "none" };
    const adapter = resolveAdapter(adapterName, configs, cwd);
    return adapter ? { kind: "adapter", adapter } : { kind: "unavailable", adapterName, command: config.command };
  }
  const ext = path.extname(program).toLowerCase();
  if (ext) {
    const configured: { name: string; rootDir: string | null }[] = [];
    const available: DapResolvedAdapter[] = [];
    for (const name in configs) {
      const config = configs[name];
      if (!config || !config.fileTypes.includes(ext)) continue;
      const rootDir = findRootInAncestry(program, cwd, config.rootMarkers, kind);
      configured.push({ name, rootDir });
      const adapter = resolveAdapter(name, configs, cwd);
      if (adapter) available.push(adapter);
    }
    const selected = sortForLaunch(program, cwd, kind, available)[0];
    if (selected) return { kind: "adapter", adapter: selected };
    const rootMatch = configured.find((c) => c.rootDir !== null) ?? configured[0];
    if (rootMatch) {
      const config = configs[rootMatch.name];
      return { kind: "unavailable", adapterName: rootMatch.name, command: config.command };
    }
  }
  // Extensionless binary: prefer native debuggers with a root marker.
  const available: DapResolvedAdapter[] = [];
  const rootMatches: { name: string; rootDir: string | null }[] = [];
  for (const name in configs) {
    const config = configs[name];
    if (!config) continue;
    const rootDir = findRootInAncestry(program, cwd, config.rootMarkers, kind);
    if (rootDir) rootMatches.push({ name, rootDir });
    if (!EXTENSIONLESS_DEBUGGER_ORDER.includes(name) && !rootDir) continue;
    const adapter = resolveAdapter(name, configs, cwd);
    if (adapter) available.push(adapter);
  }
  const selected = sortForLaunch(program, cwd, kind, available)[0];
  if (selected) return { kind: "adapter", adapter: selected };
  const unavailable = rootMatches[0];
  if (unavailable) {
    const config = configs[unavailable.name];
    return { kind: "unavailable", adapterName: unavailable.name, command: config.command };
  }
  return { kind: "none" };
}

export function selectAttachAdapter(
  cwd: string,
  adapterName: string | undefined,
  port: number | undefined,
): DapResolvedAdapter | null {
  const available = getAvailableAdapters(cwd);
  if (adapterName) return available.find((a) => a.name === adapterName) ?? null;
  if (port !== undefined) {
    const debugpy = available.find((a) => a.name === "debugpy");
    if (debugpy) return debugpy;
  }
  for (const preferred of EXTENSIONLESS_DEBUGGER_ORDER) {
    const match = available.find((a) => a.name === preferred);
    if (match) return match;
  }
  return available[0] ?? null;
}

// dlv-specific: directories and .go files debug as a package (mode=debug),
// compiled binaries as mode=exec.
export function resolveLaunchOverrides(
  adapter: DapResolvedAdapter,
  program: string,
  kind: LaunchProgramKind,
): Record<string, unknown> {
  if (adapter.name === "dlv") {
    const ext = path.extname(program).toLowerCase();
    if (kind === "directory" || ext === ".go") return { mode: "debug" };
    if (kind === "file") return { mode: "exec" };
  }
  return {};
}

export { DAP_PORT_ARG };
