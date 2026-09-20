/**
 * Custom compaction — use a cheaper/faster model for summarization when it fits.
 *
 * Default model: glm-4.7 via the z.ai Anthropic endpoint (reuses your zai-anthropic
 * subscription auth). glm-4.7 has a 200k context window, cheaper/faster than glm-5.2.
 *
 * Logic:
 *   - Estimate tokens of the messages being summarized.
 *   - If they fit in glm-4.7's 200k window (minus output budget) → summarize with glm-4.7.
 *   - If too big → return nothing → pi falls back to its DEFAULT compaction (your main model).
 *
 * Situational overrides via `/compact`:
 *   /compact glm-4.7                → force glm-4.7 for this compaction
 *   /compact glm-4.6 focus on auth  → model + extra instructions
 *   /compact focus on auth          → just instructions, default model selection
 *   /compact google/gemini-2.5-flash→ any registry model (uses its own auth)
 *
 * The summary format mirrors pi's built-in compaction (Goal/Progress/Next Steps +
 * cumulative <read-files>/<modified-files> tracking), so file tracking stays intact.
 *
 * Returns undefined (→ pi default) when: model not resolvable, no auth, context too
 * big, or the call fails. Never blocks compaction.
 */

import { complete } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	estimateTokens,
	serializeConversation,
	type ExtensionAPI,
	type Model,
} from "@earendil-works/pi-coding-agent";

// ── config ──────────────────────────────────────────────────────────────────

/** Default compaction model (used when context fits its window). */
const DEFAULT_MODEL_ID = "glm-4.7";

/**
 * z.ai models routable through the Anthropic endpoint (api.z.ai/api/anthropic),
 * reusing the zai-anthropic subscription auth. id → context window.
 * Add entries here to enable more z.ai models for compaction.
 */
const ZAI_ANTHROPIC_MODELS: Record<string, number> = {
	"glm-4.7": 204800,
	"glm-4.6": 204800,
	"glm-4.5": 131072,
	"glm-5.1": 200000,
	"glm-5.2": 1_000_000,
};

/** Output token budget for the summary. */
const SUMMARY_MAX_TOKENS = 8192;
/** Extra headroom when checking fit (instruction prompt, tags, framing). */
const SAFETY_MARGIN = 4096;

// ── pi's summary prompts (mirrored so format stays consistent) ───────────────

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const SUMMARIZATION_SYSTEM_PROMPT =
	"You are a precise conversation summarizer. Produce a structured markdown summary. Never continue the conversation or add new advice.";

// ── file tracking (mirrors pi's computeFileLists + formatFileOperations) ─────

function computeFileLists(fileOps: { read?: string[]; edited?: string[]; written?: string[] }): {
	readFiles: string[];
	modifiedFiles: string[];
} {
	const modified = new Set<string>([...(fileOps.edited ?? []), ...(fileOps.written ?? [])]);
	const readFiles = [...(fileOps.read ?? [])].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles, modifiedFiles };
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

// ── model resolution ────────────────────────────────────────────────────────

interface ResolvedModel {
	model: Model;
	contextWindow: number;
	/** Auth provider — either the zai-anthropic base (shared) or the model's own. */
	authSource: Model;
}

/**
 * Resolve a model spec into something callable.
 *   "glm-4.7"            → z.ai via anthropic endpoint (reuses zai-anthropic auth)
 *   "google/gemini-..."  → registry lookup (own auth)
 */
function resolveModel(
	spec: string,
	registry: { getAll(): Model[] },
	baseZaiModel: Model | undefined,
): ResolvedModel | null {
	const lower = spec.toLowerCase();

	// provider/id form → registry lookup
	if (lower.includes("/")) {
		const [provider, ...rest] = spec.split("/");
		const id = rest.join("/");
		const m = registry.getAll().find((x) => x.provider === provider && x.id.toLowerCase() === id.toLowerCase());
		if (m && m.contextWindow) return { model: m, contextWindow: m.contextWindow, authSource: m };
		return null;
	}

	// z.ai model via the anthropic endpoint (reuse subscription auth)
	if (lower in ZAI_ANTHROPIC_MODELS && baseZaiModel) {
		const ctx = ZAI_ANTHROPIC_MODELS[lower]!;
		return {
			model: { ...baseZaiModel, id: spec, name: `${spec} (compaction)`, contextWindow: ctx },
			contextWindow: ctx,
			authSource: baseZaiModel,
		};
	}

	// bare id → any registry match
	const m = registry.getAll().find((x) => x.id.toLowerCase() === lower);
	if (m && m.contextWindow) return { model: m, contextWindow: m.contextWindow, authSource: m };

	return null;
}

/** Parse "/compact <spec> [instructions]" — returns model + leftover instructions. */
function parseCompactArg(
	customInstructions: string | undefined,
	registry: { getAll(): Model[] },
	baseZaiModel: Model | undefined,
): { modelId: string; instructions: string | undefined } {
	if (!customInstructions) return { modelId: DEFAULT_MODEL_ID, instructions: undefined };
	const trimmed = customInstructions.trim();
	const firstToken = trimmed.split(/\s+/)[0] ?? "";

	// Does the first token resolve to a model?
	const resolved = resolveModel(firstToken, registry, baseZaiModel);
	if (resolved) {
		const rest = trimmed.slice(firstToken.length).trim();
		return { modelId: firstToken, instructions: rest || undefined };
	}
	// Not a model → whole thing is instructions, use default model selection
	return { modelId: DEFAULT_MODEL_ID, instructions: trimmed };
}

// ── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, customInstructions, signal } = event;
		const {
			messagesToSummarize,
			turnPrefixMessages,
			tokensBefore,
			firstKeptEntryId,
			previousSummary,
			fileOps,
		} = preparation;

		// Base model carrying the z.ai Anthropic endpoint + subscription auth.
		const baseZaiModel = ctx.modelRegistry.getAll().find((m) => m.provider === "zai-anthropic");

		const { modelId, instructions } = parseCompactArg(customInstructions, ctx.modelRegistry, baseZaiModel);
		const resolved = resolveModel(modelId, ctx.modelRegistry, baseZaiModel);
		if (!resolved) {
			ctx.ui.notify(`Compaction: could not resolve model "${modelId}", using default`, "warning");
			return; // → pi default
		}
		const { model, contextWindow, authSource } = resolved;

		// Auth (reuse zai-anthropic subscription for z.ai models, own auth for others)
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(authSource);
		if (!auth.ok || !auth.apiKey) {
			ctx.ui.notify(`Compaction: no auth for ${authSource.provider}, using default`, "warning");
			return;
		}

		// ── Fit check: does the to-summarize context fit the model's window? ──
		const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
		let inputTokens = 0;
		for (const m of allMessages) inputTokens += estimateTokens(m);

		// Instruction prompt overhead (serialized text is ~ the messages; add prompt framing).
		const promptOverhead = Math.ceil(
			(SUMMARIZATION_PROMPT.length + (previousSummary?.length ?? 0) + 2000) / 4,
		);
		const needed = inputTokens + promptOverhead + SUMMARY_MAX_TOKENS + SAFETY_MARGIN;

		if (needed > contextWindow) {
			ctx.ui.notify(
				`Compaction: ${model.id} needs ~${needed.toLocaleString()} tok > ${contextWindow.toLocaleString()} ctx window → using default model`,
				"info",
			);
			return; // → pi default compaction (your main model)
		}

		// ── Build the summarization request (mirror pi's format) ──
		const conversationText = serializeConversation(convertToLlm(allMessages));
		const basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
		const focus = instructions ? `\n\nAdditional focus: ${instructions}` : "";

		let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
		if (previousSummary) promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
		promptText += basePrompt + focus;

		const summaryMessages = [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: promptText }],
				timestamp: Date.now(),
			},
		];

		ctx.ui.notify(
			`Compacting with ${model.id}: ~${inputTokens.toLocaleString()} tok input, ${allMessages.length} msgs…`,
			"info",
		);

		try {
			const response = await complete(
				model,
				{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summaryMessages },
				{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env, maxTokens: SUMMARY_MAX_TOKENS, signal },
			);

			let summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n")
				.trim();

			if (!summary) {
				if (!signal.aborted) ctx.ui.notify("Compaction: empty summary, using default", "warning");
				return;
			}

			// Append cumulative file tracking (preserves pi's read/modified-file lists).
			const { readFiles, modifiedFiles } = computeFileLists(fileOps);
			summary += formatFileOperations(readFiles, modifiedFiles);

			ctx.ui.notify(`✓ Compacted with ${model.id}`, "info");

			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
					details: { readFiles, modifiedFiles },
				},
			};
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Compaction with ${model.id} failed (${msg.slice(0, 80)}), using default`, "warning");
			return; // → pi default
		}
	});
}
