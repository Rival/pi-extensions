/**
 * Session Title Editor — shows the session name on the input box's top border.
 *
 *   ───────────────────────────────────────────── dreams_and_triple  ──
 *   ❯ <your input>
 *
 * Named session   → name embedded in the editor's top border (Claude Code / omp style)
 * Unnamed session → default editor border, untouched
 *
 * Also mirrors the name into the terminal / Kitty tab title via setTitle().
 *
 * Mechanism: setEditorComponent() + a CustomEditor subclass that overrides
 * render() and rewrites lines[0] (the top border). Unlike setHeader(), the
 * editor is a FIXED on-screen element, so the title never scrolls away.
 *
 * Settings: extensions/session-header.settings.json (loaded once per
 *            registration — /reload picks up edits; invalid fields fall
 *            back to defaults and are reported once as a warning)
 * Toggle:  /session-title   (in-memory; default comes from settings)
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
	stripTerminalSequences,
	visibleWidth,
	type EditorTheme,
	type TUI,
} from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── session-title settings ──────────────────────────────────────────────────

export type SessionTitleStyle = "rounded" | "square";

export interface SessionTitleSettings {
	enabled: boolean;
	style: SessionTitleStyle;
	leftCap: string;
	rightCap: string;
	padding: number;
	trailerWidth: number;
}

export interface SessionTitleSettingsResult {
	settings: SessionTitleSettings;
	warning?: string;
}

export const DEFAULT_SESSION_TITLE_SETTINGS: Readonly<SessionTitleSettings> =
	Object.freeze({
		enabled: true,
		style: "rounded",
		leftCap: "",
		rightCap: "",
		padding: 1,
		trailerWidth: 2,
	});

/**
 * Parse and validate a raw settings value.
 *
 * - Missing fields keep their defaults; unknown properties are ignored.
 * - Supplied invalid fields are collected and reported once in `warning`.
 */
export function parseSessionTitleSettings(
	value: unknown,
): SessionTitleSettingsResult {
	const settings: SessionTitleSettings = {
		...DEFAULT_SESSION_TITLE_SETTINGS,
	};
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {
			settings,
			warning: "Session title settings must be a JSON object",
		};
	}

	const input = value as Record<string, unknown>;
	const rejected: string[] = [];
	const supplied = (key: string) => Object.hasOwn(input, key);

	if (supplied("enabled")) {
		if (typeof input.enabled === "boolean") settings.enabled = input.enabled;
		else rejected.push("enabled");
	}
	if (supplied("style")) {
		if (input.style === "rounded" || input.style === "square") {
			settings.style = input.style;
		} else rejected.push("style");
	}
	for (const key of ["leftCap", "rightCap"] as const) {
		if (!supplied(key)) continue;
		if (typeof input[key] === "string") settings[key] = input[key];
		else rejected.push(key);
	}
	for (const key of ["padding", "trailerWidth"] as const) {
		if (!supplied(key)) continue;
		const candidate = input[key];
		if (Number.isSafeInteger(candidate) && Number(candidate) >= 0) {
			settings[key] = Number(candidate);
		} else rejected.push(key);
	}

	return {
		settings,
		warning:
			rejected.length > 0
				? `Invalid session title settings fields: ${rejected.join(", ")}`
				: undefined,
	};
}

const DEFAULT_SETTINGS_PATH = fileURLToPath(
	new URL("./session-header.settings.json", import.meta.url),
);

/**
 * Load settings from the JSON file adjacent to this extension. Missing or
 * malformed files fall back to the defaults with a warning.
 */
export function loadSessionTitleSettings(
	settingsPath = DEFAULT_SETTINGS_PATH,
): SessionTitleSettingsResult {
	try {
		return parseSessionTitleSettings(
			JSON.parse(readFileSync(settingsPath, "utf8")),
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			settings: { ...DEFAULT_SESSION_TITLE_SETTINGS },
			warning: `Could not load session title settings: ${message}`,
		};
	}
}

/**
 * Embed `name` into a full-width top-border line:
 *   ─×fill + cap + padded name + cap + ─×trailer   (exactly `width` columns)
 *
 * - `border(s)` applies the editor's dynamic border color.
 * - Caps render only for the "rounded" style; "square" omits them.
 * - The padded label uses reverse-video over that color, so its background
 *   matches the border while its text uses the terminal background color.
 *   Caps, fill, and trailer stay outside reverse-video.
 * - Returns `top` unchanged when there is no name, the line is a scroll
 *   indicator, or the terminal is too narrow to fit the fixed-width parts.
 *
 * Pure + side-effect-free so it can be unit-tested with an identity color fn.
 */
export function decorateTopBorder(
	top: string,
	width: number,
	name: string | undefined,
	border: (s: string) => string,
	settings: SessionTitleSettings = { ...DEFAULT_SESSION_TITLE_SETTINGS },
): string {
	if (!name) return top;
	// Decorate only the plain full-width border. Scroll indicators can lose their
	// arrows/text when truncated, so checking for specific marker words is unsafe.
	if (stripTerminalSequences(top) !== "─".repeat(width)) return top;

	const rounded = settings.style === "rounded";
	const leftCap = rounded ? settings.leftCap : "";
	const rightCap = rounded ? settings.rightCap : "";

	// Feasibility check before allocating any repeated strings: the label must
	// keep at least one fill column, and oversized numeric settings must not
	// reach repeat().
	const fixedWidth =
		visibleWidth(name) +
		settings.padding * 2 +
		visibleWidth(leftCap) +
		visibleWidth(rightCap) +
		settings.trailerWidth;
	if (width <= fixedWidth) return top; // too narrow — keep default border

	const fillCount = width - fixedWidth;
	const pad = " ".repeat(settings.padding);
	const label = `${pad}${name}${pad}`;
	const trailer = "─".repeat(settings.trailerWidth);

	let line = border("─".repeat(fillCount));
	if (leftCap !== "") line += border(leftCap);
	line += `\x1b[7m${border(label)}\x1b[27m`;
	if (rightCap !== "") line += border(rightCap);
	if (trailer !== "") line += border(trailer);
	return line;
}

// ── custom editor ───────────────────────────────────────────────────────────

class SessionTitleEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly getName: () => string | undefined,
		private readonly settings: SessionTitleSettings,
	) {
		super(tui, theme, keybindings);
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length > 0) {
			// Reuse the editor's public borderColor callback so the dashes match.
			const border = this.borderColor;
			lines[0] = decorateTopBorder(
				lines[0],
				width,
				this.getName(),
				border,
				this.settings,
			);
		}
		return lines;
	}
}

/**
 * Compose the title decoration on top of ANOTHER custom editor (e.g. the
 * GhostEditor from pi-ghost-autocomplete) without replacing it: a Proxy that
 * intercepts only `render` (decorating lines[0]) and passes everything else —
 * input, ghost text, submit callbacks, borderColor — straight to the base
 * instance. No duplicated editor state: the base stays the single owner.
 */
function makeTitledEditor(
	base: CustomEditor,
	getName: () => string | undefined,
	settings: SessionTitleSettings,
): CustomEditor {
	return new Proxy(base, {
		get(target: any, prop: string | symbol, _receiver: any): any {
			if (prop === "render") {
				return (width: number): string[] => {
					const lines = target.render(width);
					if (lines.length > 0) {
						lines[0] = decorateTopBorder(
							lines[0],
							width,
							getName(),
							(s: string) => target.borderColor(s),
							settings,
						);
					}
					return lines;
				};
			}
			const value = target[prop];
			return typeof value === "function" ? value.bind(target) : value;
		},
		set(target: any, prop: string | symbol, value: any): boolean {
			target[prop] = value;
			return true;
		},
	}) as unknown as CustomEditor;
}

// ── extension ───────────────────────────────────────────────────────────────

function titleFor(getName: () => string | undefined, cwd: string): string {
	const name = getName();
	return name ? `π · ${name}` : `π · ${path.basename(cwd)}`;
}

export default function registerSessionHeader(
	pi: ExtensionAPI,
	loaded: SessionTitleSettingsResult = loadSessionTitleSettings(),
): void {
	// Loaded once per registration — /reload re-imports the extension and picks
	// up edits to the adjacent JSON. The editor renders with this one object.
	const settings = loaded.settings;
	let enabled = settings.enabled;
	let warningShown = false;

	// Editor composition state: another extension (pi-ghost-autocomplete)
	// replaces the editor AFTER our session_start — so we remember the base
	// factory and re-wrap it. setEditorComponent preserves the typed text
	// (setText(currentText) in pi), so re-wrapping is seamless.
	let ourFactory:
		| ((tui: TUI, theme: EditorTheme, kb: KeybindingsManager) => CustomEditor)
		| null = null;
	let baseFactory: any = null;
	const retryTimers: ReturnType<typeof setTimeout>[] = [];

	function mountEditor(ctx: ExtensionContext): void {
		const current = (ctx.ui as any).getEditorComponent?.();
		if (current === ourFactory) return; // уже мы — ничего не делать
		baseFactory = current ?? null;
		const prevFactory = current ?? null;
		const getName = () => pi.getSessionName();
		ourFactory = (tui, theme, kb) => {
			const base = prevFactory ? prevFactory(tui, theme, kb) : null;
			return base
				? makeTitledEditor(base as CustomEditor, getName, settings)
				: new SessionTitleEditor(tui, theme, kb, getName, settings);
		};
		ctx.ui.setEditorComponent(ourFactory);
	}

	function scheduleRewrap(ctx: ExtensionContext): void {
		// ghost-autocomplete ставит свой редактор через ~мс после нашего
		// session_start: перевешиваемся поверх, как только он появится.
		for (const delay of [300, 1500, 4000]) {
			const t = setTimeout(() => {
				if (enabled) mountEditor(ctx);
			}, delay);
			t.unref?.();
			retryTimers.push(t);
		}
	}

	// ghost может пере-ставить свой редактор и ПОЗЖЕ (не только на старте),
	// поэтому вечный сторож: раз в 2.5с проверяет, что текущая фабрика — наша.
	// Когда всё стабильно, это один getEditorComponent() и ничего больше.
	let watchdog: ReturnType<typeof setInterval> | null = null;
	let lastCtx: ExtensionContext | null = null;

	function startWatchdog(ctx: ExtensionContext): void {
		lastCtx = ctx;
		stopWatchdog();
		watchdog = setInterval(() => {
			if (enabled && lastCtx) mountEditor(lastCtx);
		}, 2500);
		watchdog.unref?.();
	}

	function stopWatchdog(): void {
		if (watchdog) {
			clearInterval(watchdog);
			watchdog = null;
		}
	}

	function restoreDefault(ctx: ExtensionContext): void {
		// Возвращаем не дефолт, а базовый редактор (ghost), если он был,
		// иначе выключим и ghost-подсказки.
		ctx.ui.setEditorComponent(baseFactory ?? undefined);
		ourFactory = null;
	}

	function apply(ctx: ExtensionContext): void {
		// The editor reads pi.getSessionName() fresh on every render, so it adapts
		// to /name automatically — we mount once and keep it for the session.
		if (enabled) {
			mountEditor(ctx);
			scheduleRewrap(ctx);
			startWatchdog(ctx);
		} else {
			stopWatchdog();
			restoreDefault(ctx);
		}
		ctx.ui.setTitle(titleFor(() => pi.getSessionName(), ctx.cwd));
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (loaded.warning && !warningShown) {
			ctx.ui.notify(loaded.warning, "warning");
			warningShown = true;
		}
		apply(ctx);
	});

	pi.on("session_info_changed", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		// Editor re-renders every frame → name updates live; just refresh the tab title.
		ctx.ui.setTitle(titleFor(() => pi.getSessionName(), ctx.cwd));
	});

	pi.on("session_shutdown", (_event, ctx) => {
		for (const t of retryTimers) clearTimeout(t);
		retryTimers.length = 0;
		stopWatchdog();
		if (ctx.mode === "tui") {
			try {
				ctx.ui.setTitle(titleFor(() => undefined, ctx.cwd));
			} catch {
				// best-effort
			}
		}
	});

	pi.registerCommand("session-title", {
		description: "Toggle session-name title on the input box border",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (ctx.mode === "tui") {
				apply(ctx);
				ctx.ui.notify(
					enabled ? "✅ Session title on" : "↩️  Default editor restored",
					"info",
				);
			}
		},
	});
}
