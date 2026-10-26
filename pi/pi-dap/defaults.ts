// Built-in DAP adapter definitions, ported from OMP's
// packages/coding-agent/src/dap/defaults.json so the same out-of-the-box
// set (gdb, lldb-dap, codelldb, debugpy, dlv, js-debug-adapter, netcoredbg,
// kotlin-debug-adapter, rdbg, php-debug-adapter, bash-debug-adapter,
// dart-debug-adapter, flutter-debug-adapter, elixir-ls-debugger) is available.

export interface DapAdapterConfig {
  command: string;
  args: string[];
  languages: string[];
  fileTypes: string[];
  rootMarkers: string[];
  launchDefaults: Record<string, unknown>;
  attachDefaults: Record<string, unknown>;
  acceptsDirectoryProgram: boolean;
  connectMode?: "stdio" | "socket" | "tcp";
}

type RawAdapter = {
  command: string;
  args?: string[];
  connectMode?: "socket" | "tcp";
  languages?: string[];
  fileTypes?: string[];
  rootMarkers?: string[];
  acceptsDirectoryProgram?: boolean;
  launchDefaults?: Record<string, unknown>;
  attachDefaults?: Record<string, unknown>;
};

const RAW: Record<string, RawAdapter> = {
  gdb: {
    command: "gdb",
    args: ["-i", "dap"],
    languages: ["c", "cpp", "rust"],
    fileTypes: [".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx", ".rs"],
    rootMarkers: ["Makefile", "CMakeLists.txt", "Cargo.toml", "compile_commands.json"],
    launchDefaults: { request: "launch", stopOnEntry: true, stopAtBeginningOfMainSubprogram: true },
    attachDefaults: { request: "attach" },
  },
  "lldb-dap": {
    command: "lldb-dap",
    args: [],
    languages: ["c", "cpp", "objc", "swift", "rust", "zig"],
    fileTypes: [".c", ".cc", ".cpp", ".cxx", ".m", ".mm", ".swift", ".rs", ".zig"],
    rootMarkers: ["Package.swift", "Cargo.toml", "Makefile", "CMakeLists.txt", "build.zig"],
    launchDefaults: { request: "launch", stopOnEntry: true },
    attachDefaults: { request: "attach" },
  },
  codelldb: {
    command: "codelldb",
    args: ["--port", "${port}"],
    connectMode: "tcp",
    languages: ["c", "cpp", "rust", "zig"],
    fileTypes: [".c", ".cc", ".cpp", ".cxx", ".rs", ".zig"],
    rootMarkers: ["Cargo.toml", "CMakeLists.txt", "Makefile", "compile_commands.json", "build.zig"],
    launchDefaults: { request: "launch", stopOnEntry: true },
    attachDefaults: { request: "attach" },
  },
  debugpy: {
    command: "python",
    args: ["-m", "debugpy.adapter"],
    languages: ["python"],
    fileTypes: [".py"],
    rootMarkers: ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile"],
    launchDefaults: { request: "launch", justMyCode: false, stopOnEntry: true },
    attachDefaults: { request: "attach", justMyCode: false },
  },
  dlv: {
    command: "dlv",
    args: ["dap"],
    connectMode: "socket",
    languages: ["go"],
    fileTypes: [".go"],
    rootMarkers: ["go.mod", "go.sum", "go.work"],
    acceptsDirectoryProgram: true,
    launchDefaults: { request: "launch", mode: "debug", stopOnEntry: true },
    attachDefaults: { request: "attach", mode: "local" },
  },
  "js-debug-adapter": {
    command: "js-debug-adapter",
    args: [],
    languages: ["javascript", "typescript"],
    fileTypes: [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"],
    rootMarkers: ["package.json", "tsconfig.json", "jsconfig.json"],
    launchDefaults: { request: "launch", type: "pwa-node", stopOnEntry: true },
    attachDefaults: { request: "attach", type: "pwa-node" },
  },
  netcoredbg: {
    command: "netcoredbg",
    args: ["--interpreter=vscode"],
    languages: ["csharp", "fsharp"],
    fileTypes: [".cs", ".csx", ".fs", ".fsx"],
    rootMarkers: ["*.sln", "*.csproj", "*.fsproj", "global.json"],
    launchDefaults: { request: "launch", stopAtEntry: true },
    attachDefaults: { request: "attach" },
  },
  "kotlin-debug-adapter": {
    command: "kotlin-debug-adapter",
    args: [],
    languages: ["kotlin"],
    fileTypes: [".kt", ".kts"],
    rootMarkers: ["build.gradle", "build.gradle.kts", "pom.xml", "settings.gradle", "settings.gradle.kts"],
    launchDefaults: { request: "launch", mainClass: "", projectRoot: "" },
    attachDefaults: { request: "attach" },
  },
  rdbg: {
    command: "rdbg",
    args: ["--open", "--command", "--"],
    languages: ["ruby"],
    fileTypes: [".rb", ".rake", ".gemspec"],
    rootMarkers: ["Gemfile", "Rakefile", ".ruby-version"],
    launchDefaults: { request: "launch", type: "rdbg" },
    attachDefaults: { request: "attach", type: "rdbg" },
  },
  "php-debug-adapter": {
    command: "php-debug-adapter",
    args: [],
    languages: ["php"],
    fileTypes: [".php", ".phtml"],
    rootMarkers: ["composer.json", "composer.lock"],
    launchDefaults: { request: "launch", stopOnEntry: true },
    attachDefaults: { request: "attach" },
  },
  "bash-debug-adapter": {
    command: "bash-debug-adapter",
    args: [],
    languages: ["bash", "shell"],
    fileTypes: [".sh", ".bash"],
    rootMarkers: [".git"],
    launchDefaults: { request: "launch", type: "bashdb", pathBashdb: "bashdb", pathBash: "bash" },
    attachDefaults: { request: "attach" },
  },
  "dart-debug-adapter": {
    command: "dart",
    args: ["debug_adapter"],
    languages: ["dart"],
    fileTypes: [".dart"],
    rootMarkers: ["pubspec.yaml", "pubspec.lock"],
    launchDefaults: { request: "launch", stopOnEntry: true },
    attachDefaults: { request: "attach" },
  },
  "flutter-debug-adapter": {
    command: "dart",
    args: ["debug_adapter", "--flutter-sdk-path", ""],
    languages: ["dart"],
    fileTypes: [".dart"],
    rootMarkers: ["pubspec.yaml", "android", "ios", "lib/main.dart"],
    launchDefaults: { request: "launch" },
    attachDefaults: { request: "attach" },
  },
  "elixir-ls-debugger": {
    command: "elixir-ls-debugger",
    args: [],
    languages: ["elixir"],
    fileTypes: [".ex", ".exs", ".heex", ".eex"],
    rootMarkers: ["mix.exs", "mix.lock"],
    launchDefaults: { request: "launch", type: "mix_task", task: "run", stopOnEntry: true },
    attachDefaults: { request: "attach" },
  },
};

function normalize(raw: RawAdapter): DapAdapterConfig | null {
  if (!raw || typeof raw.command !== "string" || raw.command.length === 0) return null;
  return {
    command: raw.command,
    args: Array.isArray(raw.args) ? raw.args.filter((a) => typeof a === "string" && a.length > 0) : [],
    languages: Array.isArray(raw.languages) ? raw.languages.filter((s) => typeof s === "string") : [],
    fileTypes: (Array.isArray(raw.fileTypes) ? raw.fileTypes : []).map((s) => s.toLowerCase()),
    rootMarkers: Array.isArray(raw.rootMarkers) ? raw.rootMarkers.filter((s) => typeof s === "string") : [],
    launchDefaults: raw.launchDefaults && typeof raw.launchDefaults === "object" ? { ...raw.launchDefaults } : {},
    attachDefaults: raw.attachDefaults && typeof raw.attachDefaults === "object" ? { ...raw.attachDefaults } : {},
    acceptsDirectoryProgram: raw.acceptsDirectoryProgram === true,
    connectMode: raw.connectMode,
  };
}

export const DEFAULT_ADAPTERS: Record<string, DapAdapterConfig> = Object.fromEntries(
  Object.entries(RAW)
    .map(([name, raw]) => [name, normalize(raw)] as const)
    .filter(([, cfg]) => cfg !== null) as [string, DapAdapterConfig][],
);
