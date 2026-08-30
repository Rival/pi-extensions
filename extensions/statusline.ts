/**
 * Claude Code–style status line for pi.
 *
 * Two-line footer replacing pi's default:
 *   L1:  🐇 model  📁 ~/dir  🌿 branch✱
 *   L2:  ███░░░░░░░ 62% 620k = 📜5k 🔧3k 💬612k  ⬆️12k 🍖45k ⬇️3k 🎯85%  💰 $0.42  ⛽93% ⏰14:22 🛢️🛢️8% 📅Mon 09:00
 *
 * Provider quota is read from daemon-written cache files:
 *   GLM (z.ai):   ~/.claude/scripts/quota-glm.sh → /tmp/glm-quota-cache.json
 *                 (5-hour + weekly pools; script self-heals stale cache)
 *   Codex (GPT):  /tmp/codex-quota-cache.json (Hyprland daemon writer only;
 *                 5-hour pool currently collapsed → weekly only)
 *
 * The provider layer is a registry: add a new entry to PROVIDERS to support
 * another provider later (deepseek, claude, …) without touching the render code.
 *
 * Toggle:  /statusline    (default: on)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { readFileSync, appendFileSync } from "node:fs";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";

// ── types ───────────────────────────────────────────────────────────────────

type Theme = {
	fg: (color: string, text: string) => string;
	bg: (color: string, text: string) => string;
	bold: (text: string) => string;
};

interface QuotaData {
	poolPct?: number; // 5-hour pool %
	poolResets?: number; // epoch seconds
	weekPct?: number; // weekly pool %
	weekResets?: number; // epoch seconds
	mcpCur?: number; // MCP current usage
	mcpTot?: number; // MCP total
	level?: string;
}

interface ProviderQuotaHandler {
	id: string;
	/** Match by model id (lowercased), e.g. "glm-5.2". */
	matches: (modelId: string) => boolean;
	/** Path to the cache file the daemon writes, for fast sync reads. */
	cacheFile?: string;
	/** Path to the script that reads cache or cold-starts a curl. Optional: some
	 * providers rely solely on a daemon-written cache (e.g. Codex). */
	script?: string;
	/** Normalize raw JSON (cache or script output) into QuotaData. */
	parse: (raw: any) => QuotaData;
	/** Render quota into themed segments. */
	render: (q: QuotaData, theme: Theme) => string[];
}

// ── provider registry ───────────────────────────────────────────────────────
// To support another provider, add an entry here. Render code stays the same.

const HOME = homedir();
const QUOTA_SCRIPTS_DIR = join(HOME, ".claude", "scripts");

const PROVIDERS: ProviderQuotaHandler[] = [
	{
		id: "glm",
		matches: (id) => id.toLowerCase().startsWith("glm"),
		cacheFile: "/tmp/glm-quota-cache.json",
		script: join(QUOTA_SCRIPTS_DIR, "quota-glm.sh"),
		parse: (d) => ({
			poolPct: num(d.token_pct),
			poolResets: num(d.token_resets),
			weekPct: num(d.week_pct),
			weekResets: num(d.week_resets),
			mcpCur: num(d.mcp_cur),
			mcpTot: num(d.mcp_tot),
			level: typeof d.level === "string" ? d.level : undefined,
		}),
		render: (q, theme) => {
			const parts: string[] = [];
			// 5-hour pool — show REMAINING (100 − used) so a near-empty pool reads low.
			if (q.poolPct != null) {
				const used = q.poolPct;
				const remaining = Math.max(0, 100 - used);
				const col = used >= 80 ? "error" : used >= 60 ? "warning" : "success";
				parts.push(theme.fg(col, `⛽${remaining}%`));
			}
			if (q.poolResets && q.poolResets > 0) {
				parts.push(theme.fg("dim", `⏰${fmtClock(q.poolResets)}`));
			}
			// weekly pool — greedy tanks: only the REMAINING ones are drawn.
			// Fresh week = 10 tanks, they vanish as the week is used; 100% used = 💨.
			// weekPct = % USED.
			if (q.weekPct != null) {
				const used = q.weekPct;
				const tanks = Math.max(0, Math.min(10, Math.round((100 - used) / 10)));
				if (tanks > 0) {
					const col = used >= 80 ? "error" : used >= 60 ? "warning" : "success";
					parts.push(theme.fg(col, `🛢️`.repeat(tanks) + `${100 - used}%`));
				} else {
					parts.push(theme.fg("error", "💨"));
				}
			}
			if (q.weekResets && q.weekResets > 0) {
				parts.push(theme.fg("dim", `📅${fmtDayClock(q.weekResets)}`));
			}
			// MCP count (z.ai tool-call budget)
			if (q.mcpCur != null && q.mcpTot != null && q.mcpTot > 0) {
				parts.push(theme.fg("dim", `📡${q.mcpCur}/${q.mcpTot}`));
			}
			return parts;
		},
	},
	{
		id: "codex",
		// GPT / Codex / o-series models. Cache written by the codex-quota daemon
		// (codex-quota.lua); no fetch script — relies solely on the daemon cache.
		matches: (id) =>
			id.startsWith("gpt") || id.includes("codex") ||
			id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4"),
		cacheFile: "/tmp/codex-quota-cache.json",
		parse: (d) => ({
			poolPct: num(d.token_pct),
			poolResets: num(d.token_resets),
			weekPct: num(d.week_pct),
			weekResets: num(d.week_resets),
			level: typeof d.plan === "string" ? d.plan : undefined,
		}),
		render: (q, theme) => {
			const parts: string[] = [];
			// 5-hour pool — only when it exists (OpenAI temporarily collapsed it;
			// token_resets==0 ⇒ absent). Show REMAINING like GLM.
			if (q.poolPct != null && q.poolResets && q.poolResets > 0) {
				const used = q.poolPct;
				const remaining = Math.max(0, 100 - used);
				const col = used >= 80 ? "error" : used >= 60 ? "warning" : "success";
				parts.push(theme.fg(col, `⛽${remaining}%`));
				parts.push(theme.fg("dim", `⏰${fmtClock(q.poolResets)}`));
			}
			// weekly pool — same greedy tanks as GLM (weekPct = % USED).
			if (q.weekPct != null) {
				const used = q.weekPct;
				const tanks = Math.max(0, Math.min(10, Math.round((100 - used) / 10)));
				if (tanks > 0) {
					const col = used >= 80 ? "error" : used >= 60 ? "warning" : "success";
					parts.push(theme.fg(col, `🛢️`.repeat(tanks) + `${100 - used}%`));
				} else {
					parts.push(theme.fg("error", "💨"));
				}
			}
			if (q.weekResets && q.weekResets > 0) {
				parts.push(theme.fg("dim", `📅${fmtDayClock(q.weekResets)}`));
			}
			return parts;
		},
	},
];

function handlerFor(modelId: string): ProviderQuotaHandler | null {
	const id = (modelId || "").toLowerCase();
	return PROVIDERS.find((p) => p.matches(id)) ?? null;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function num(v: any): number | undefined {
	if (v == null) return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
}

function p2(n: number): string {
	return String(n).padStart(2, "0");
}

function fmtClock(epochSec: number): string {
	const d = new Date(epochSec * 1000);
	return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function fmtDayClock(epochSec: number): string {
	const d = new Date(epochSec * 1000);
	return `${DAYS[d.getDay()]} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function fmtTok(n: number): string {
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
	if (n >= 1000) return Math.floor(n / 1000) + "k";
	return String(n);
}

function modelIcon(id: string): string {
	const s = (id || "").toLowerCase();
	if (s.startsWith("glm") || s.includes("zai")) return "🐇";
	if (s.includes("deepseek")) return "🔷";
	if (s.startsWith("claude") || s.includes("opus") || s.includes("sonnet") || s.includes("haiku")) return "🧠";
	if (s.includes("gpt") || s.startsWith("o1") || s.startsWith("o3") || s.startsWith("o4")) return "✨";
	return "🤖";
}

function shortCwd(cwd: string): string {
	const h = HOME;
	return cwd.startsWith(h) ? "~" + cwd.slice(h.length) : cwd;
}

function pctColor(pct: number): string {
	return pct >= 90 ? "error" : pct >= 70 ? "warning" : "success";
}

function makeBar(pct: number, theme: Theme): string {
	const filled = Math.max(0, Math.min(10, Math.floor(pct / 10)));
	const col = pctColor(pct);
	return theme.fg(col, "█".repeat(filled)) + theme.fg("dim", "░".repeat(10 - filled));
}

/** Cache the tool-definition token estimate by active-tool-set signature (tools change rarely). */
let _toolsTokCache: { sig: string; tools: number } | null = null;
let _dbgLogged = false;

/**
 * Estimate the composition of the current context window:
 *   📜 system prompt  (ctx.getSystemPrompt — cached string in session state)
 *   🔧 tool definitions (ctx.getAllTools serialized JSON, active set only)
 *   💬 conversation messages
 *
 * Whichever of 🔧/💬 can't be measured directly is DERIVED from the
 * authoritative total (last model usage) so the three parts always sum to it:
 *   - getAllTools available  → messages derived = total − system − tools
 *   - getAllTools unavailable → tools derived   = total − system − messages
 * (ExtensionContext lacks getActiveTools/getAllTools; only the command ctx has them.)
 */
function estimateContextBreakdown(
	ctx: any,
	realTotal: number | null,
): { system: number; tools: number; messages: number | null } {
	// 📜 system prompt — a cached string, cheap to read
	let system = 0;
	try {
		const sp = ctx?.getSystemPrompt?.();
		if (sp) system = Math.ceil(sp.length / 4);
	} catch {
		// ignore
	}

	// 🔧 tool definitions — try getAllTools() (active subset), cached by signature
	let tools = 0;
	let toolsResolved = false;
	try {
		const all = ctx?.getAllTools?.() ?? [];
		let toolDefs = all;
		const activeNames = ctx?.getActiveTools?.() ?? [];
		if (activeNames.length > 0) {
			const set = new Set(activeNames.map((n: any) => String(n).toLowerCase()));
			const filtered = all.filter((t: any) => set.has(String(t?.name ?? "").toLowerCase()));
			if (filtered.length > 0) toolDefs = filtered; // use active subset when it matched
		}
		if (toolDefs.length > 0) {
			const sig = toolDefs.map((t: any) => t?.name).sort().join(",");
			if (_toolsTokCache && _toolsTokCache.sig === sig) {
				tools = _toolsTokCache.tools;
			} else {
				const serialized = JSON.stringify(
					toolDefs.map((t: any) => ({
						name: t?.name,
						description: t?.description,
						parameters: t?.parameters,
						promptGuidelines: t?.promptGuidelines,
					})),
				);
				tools = Math.ceil(serialized.length / 4);
				_toolsTokCache = { sig, tools };
			}
			toolsResolved = true;
		}
		// one-shot debug: what does the extension ctx actually expose?
		if (!_dbgLogged) {
			_dbgLogged = true;
			try {
				appendFileSync(
					"/tmp/statusline-debug.log",
					`[${new Date().toISOString()}] getActiveTools=${typeof ctx?.getActiveTools} getAllTools=${typeof ctx?.getAllTools} activeNames=${activeNames.length} all=${all.length} toolDefs=${toolDefs.length} tools=${tools} resolved=${toolsResolved} system=${system}\n`,
				);
			} catch {
				// ignore
			}
		}
	} catch {
		// ignore
	}

	// 💬 messages — derive whichever side wasn't measured directly
	let messages: number | null = null;
	if (realTotal != null) {
		if (toolsResolved) {
			messages = Math.max(0, realTotal - system - tools);
		} else {
			// tools unavailable on this ctx → estimate messages, derive tools
			let m = 0;
			try {
				// Use the ACTIVE (compaction-aware) message set, not the full session log:
				// buildSessionContext() returns exactly what the LLM sees (= what
				// getContextUsage measures). Falls back to buildContextEntries().
				let activeMsgs: any[] = [];
				const sc = ctx.sessionManager?.buildSessionContext?.();
				if (sc?.messages) activeMsgs = sc.messages;
				if (activeMsgs.length === 0) {
					for (const e of (ctx.sessionManager?.buildContextEntries?.() ?? [])) {
						const msg = (e as any)?.message;
						if (msg) activeMsgs.push(msg);
					}
				}
				for (const msg of activeMsgs) m += estimateTokens(msg);
			} catch {
				// ignore
			}
			messages = Math.min(realTotal, Math.max(0, m));
			tools = Math.max(0, realTotal - system - messages);
		}
	}
	return { system, tools, messages };
}

/** Join themed segments with a dim separator. */
function joinSegs(theme: Theme, segs: string[], sep = "│"): string {
	const dimSep = " " + theme.fg("dim", sep) + " ";
	return segs.filter((s) => s && s.length > 0).join(dimSep);
}


// ── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let tuiRef: { requestRender: () => void } | null = null;
	let ctxRef: ExtensionContext | null = null;

	let quotaHandler: ProviderQuotaHandler | null = null;
	let quota: QuotaData | null = null;

	let gitDirty = false;
	let quotaTimer: ReturnType<typeof setInterval> | null = null;
	let gitTimer: ReturnType<typeof setInterval> | null = null;

	function rerender(): void {
		tuiRef?.requestRender();
	}

	/** Read quota: prefer fast sync read of the daemon cache file, else run the script. */
	async function refreshQuota(): Promise<void> {
		const handler = quotaHandler;
		if (!handler) return;

		// Fast path: read the daemon-written cache file synchronously.
		if (handler.cacheFile) {
			try {
				const raw = readFileSync(handler.cacheFile, "utf8");
				quota = handler.parse(JSON.parse(raw));
				rerender();
				return;
			} catch {
				// fall through to cold-start script
			}
		}

		// Cold path: run the script (curl, ~3s) which also writes the cache.
		// Skipped for providers that rely solely on a daemon cache (no script).
		if (!handler.script) return;
		try {
			const res = await pi.exec("bash", [handler.script], { timeout: 5000 });
			if (res.code !== 0 || !res.stdout.trim()) return;
			quota = handler.parse(JSON.parse(res.stdout));
			rerender();
		} catch {
			// ignore — keep last known quota
		}
	}

	async function refreshGitDirty(): Promise<void> {
		const ctx = ctxRef;
		if (!ctx) return;
		try {
			const res = await pi.exec("git", ["status", "--porcelain"], { timeout: 3000 });
			if (res.code === 0) {
				const dirty = res.stdout.trim().length > 0;
				if (dirty !== gitDirty) {
					gitDirty = dirty;
					rerender();
				}
			}
		} catch {
			if (gitDirty) {
				gitDirty = false;
				rerender();
			}
		}
	}

	function startTimers(): void {
		stopTimers();
		// Quota: cache is refreshed by the daemon every ~5 min; poll the file often
		// since it's a cheap sync read.
		quotaTimer = setInterval(refreshQuota, 15_000);
		// Git dirty: recheck periodically (also refreshed on turn_end).
		gitTimer = setInterval(refreshGitDirty, 15_000);
	}

	function stopTimers(): void {
		if (quotaTimer) clearInterval(quotaTimer);
		if (gitTimer) clearInterval(gitTimer);
		quotaTimer = gitTimer = null;
	}

	function setupFooter(ctx: ExtensionContext): void {
		ctxRef = ctx;
		ctx.ui.setFooter((tui, theme, footerData) => {
			tuiRef = tui;
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsub,
				invalidate() {},
				render: (width: number) => renderLines(width, theme, footerData, ctx),
			};
		});
	}

	function renderLines(
		width: number,
		theme: Theme,
		footerData: { getGitBranch(): string | null },
		ctx: ExtensionContext,
	): string[] {
		const model = ctx.model;
		const modelId = model?.id ?? "no-model";

		// Re-detect quota handler if the model changed.
		const h = handlerFor(modelId);
		if (h !== quotaHandler) {
			quotaHandler = h;
			quota = null;
			refreshQuota();
		}

		// Cumulative token/cost totals across the whole session (matches pi default footer).
		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let cost = 0;
		let latestUsage: { input?: number; cacheRead?: number; cacheWrite?: number } | null = null;
		try {
			for (const e of ctx.sessionManager.getEntries()) {
				if (e.type === "message" && (e as any).message?.role === "assistant") {
					const u = (e as any).message.usage;
					if (u) {
						input += u.input ?? 0;
						output += u.output ?? 0;
						cacheRead += u.cacheRead ?? 0;
						cacheWrite += u.cacheWrite ?? 0;
						cost += u.cost?.total ?? 0;
						latestUsage = u; // last assistant in iteration order = latest
					}
				}
			}
		} catch {
			// ignore
		}

		const cu = ctx.getContextUsage();
		const pctNum = cu?.percent ?? 0;
		const pctDisp = cu?.percent == null ? "?" : Math.round(cu.percent).toString();

		// ── Line 1: model · dir · branch ──
		const segs1: string[] = [];
		segs1.push(theme.fg("accent", `${modelIcon(modelId)} ${modelId}`));
		segs1.push(theme.fg("muted", `📁 ${shortCwd(ctx.cwd)}`));

		const branch = footerData.getGitBranch();
		if (branch) {
			let b = theme.fg("dim", `🌿 ${branch}`);
			if (gitDirty) b += theme.fg("warning", "✱");
			segs1.push(b);
		}

		const line1 = truncateToWidth(joinSegs(theme, segs1), width, "");

		// ── Line 2: context bar · tokens · cost · provider quota ──
		const segs2: string[] = [];
		const realTotal = cu?.tokens ?? null;
		const bd = estimateContextBreakdown(ctx, realTotal);
		const msgStr = bd.messages != null ? fmtTok(bd.messages) : "?";
		const breakdown = `📜${fmtTok(bd.system)} 🔧${fmtTok(bd.tools)} 💬${msgStr}`;
		const totalStr = realTotal != null ? fmtTok(realTotal) : null;
		// Total first (white/prominent — context size matters) next to the bar,
		// then "=", then the dim breakdown of where the tokens are spent.
		const head = totalStr != null
			? `${theme.fg("text", totalStr)} = ${theme.fg("dim", breakdown)}`
			: theme.fg("dim", breakdown);
		const barSeg = `${makeBar(pctNum, theme)} ${theme.fg(pctColor(pctNum), `${pctDisp}%`)} ${head}`;
		segs2.push(barSeg);

		if (input || output || cacheRead || cacheWrite) {
			// Cache hit rate from the LATEST assistant request (not cumulative):
			//   hitRate = cacheRead / (input + cacheRead + cacheWrite)
			const promptTok =
				(latestUsage?.input ?? 0) + (latestUsage?.cacheRead ?? 0) + (latestUsage?.cacheWrite ?? 0);
			const hitRate = promptTok > 0 ? ((latestUsage?.cacheRead ?? 0) / promptTok) * 100 : null;

			const tokParts = [`⬆️${fmtTok(input)}`, `🍖${fmtTok(cacheRead)}`];
			if (cacheWrite > 0) tokParts.push(`✍️${fmtTok(cacheWrite)}`);
			tokParts.push(`⬇️${fmtTok(output)}`);
			let tok = theme.fg("dim", tokParts.join(" "));
			if (hitRate != null) {
				const col = hitRate >= 70 ? "success" : hitRate >= 40 ? "warning" : "dim";
				tok += " " + theme.fg(col, `🎯${hitRate.toFixed(0)}%`);
			}
			segs2.push(tok);
		}

		if (cost > 0) {
			segs2.push(theme.fg("dim", `💰 $${cost.toFixed(3)}`));
		}

		if (quotaHandler && quota) {
			// One continuous segment (spaces, no internal │ pipes).
			const qParts = quotaHandler.render(quota, theme);
			if (qParts.length) segs2.push(qParts.join(" "));
		} else if (quotaHandler && !quota) {
			segs2.push(theme.fg("dim", "⛽ …"));
		}

		const line2 = truncateToWidth(joinSegs(theme, segs2), width, "");
		return [line1, line2];
	}

	// ── lifecycle ───────────────────────────────────────────────────────────

	pi.on("session_start", (_event, ctx) => {
		if (!enabled) return;
		// Footer + background polling only make sense in the interactive TUI.
		if (ctx.mode !== "tui") return;
		quotaHandler = handlerFor(ctx.model?.id ?? "");
		setupFooter(ctx);
		refreshQuota();
		refreshGitDirty();
		startTimers();
	});

	pi.on("model_select", (_event, ctx) => {
		const h = handlerFor(ctx.model?.id ?? "");
		if (h !== quotaHandler) {
			quotaHandler = h;
			quota = null;
			refreshQuota();
		}
		rerender();
	});

	// Re-render as token usage changes.
	pi.on("message_end", () => rerender());
	pi.on("turn_end", () => {
		refreshGitDirty();
		rerender();
	});
	pi.on("agent_settled", () => rerender());

	pi.on("session_shutdown", () => {
		stopTimers();
		tuiRef = null;
		ctxRef = null;
	});

	// ── toggle command ──────────────────────────────────────────────────────

	pi.registerCommand("statusline", {
		description: "Toggle Claude Code-style status line footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) {
				quotaHandler = handlerFor(ctx.model?.id ?? "");
				setupFooter(ctx);
				refreshQuota();
				refreshGitDirty();
				startTimers();
				ctx.ui.notify("✅ Status line enabled", "info");
			} else {
				stopTimers();
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("↩️  Default footer restored", "info");
			}
		},
	});
}
