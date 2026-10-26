/**
 * worktree-status: show which git worktree the agent is actually working in.
 *
 * Sessions often start in the main repo checkout while tool calls operate on
 * sibling git worktrees via absolute paths. This extension watches tool calls,
 * detects which registered worktree the arguments touch, and publishes the
 * worktree name as the "worktree" extension status. Configure pi-powerline-footer
 * with a custom item on statusKey "worktree" to render it in the status bar.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import path from "node:path";

const STATUS_KEY = "worktree";

type WorktreeInfo = {
	/** absolute worktree path -> display name (basename) */
	byPath: Map<string, string>;
	/** longest-first path prefixes for matching */
	sortedPaths: string[];
	repoRoot: string | undefined;
};

let info: WorktreeInfo | undefined;
let lastShown: string | undefined;

function detectWorktrees(cwd: string): WorktreeInfo {
	const empty: WorktreeInfo = { byPath: new Map(), sortedPaths: [], repoRoot: undefined };
	try {
		const out = execFileSync(
			"git",
			["worktree", "list", "--porcelain"],
			{ cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
		);
		const byPath = new Map<string, string>();
		let repoRoot: string | undefined;
		for (const line of out.split("\n")) {
			if (line.startsWith("worktree ")) {
				const p = path.resolve(line.slice("worktree ".length));
				byPath.set(p, path.basename(p));
				if (repoRoot === undefined) repoRoot = p; // first entry is the main worktree
			}
		}
		// Drop the main checkout (where the session already lives); keep linked worktrees.
		if (repoRoot) byPath.delete(repoRoot);
		const sortedPaths = [...byPath.keys()].sort((a, b) => b.length - a.length);
		return { byPath, sortedPaths, repoRoot };
	} catch {
		return empty;
	}
}

function matchWorktree(haystack: string): string | undefined {
	if (!info || info.sortedPaths.length === 0) return undefined;
	for (const p of info.sortedPaths) {
		// require the path boundary so Argos-foo does not match Argos-foobar
		if (haystack.includes(p + "/")) return info.byPath.get(p);
	}
	return undefined;
}

export default function worktreeStatus(pi: ExtensionAPI) {
	const ensureInfo = (cwd: string) => {
		if (!info) info = detectWorktrees(cwd);
		return info;
	};

	pi.on("session_start", (_event, ctx) => {
		// re-detect per session (cwd may differ)
		info = undefined;
		lastShown = undefined;
		ensureInfo(ctx.cwd);
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("tool_call", (event, ctx) => {
		const worktrees = info ?? ensureInfo(ctx.cwd);
		if (worktrees.sortedPaths.length === 0) return undefined;

		let haystack: string;
		try {
			haystack = JSON.stringify(event.input ?? {});
		} catch {
			return undefined;
		}
		const name = matchWorktree(haystack);
		if (name && name !== lastShown) {
			lastShown = name;
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, name);
		}
		return undefined;
	});
}
