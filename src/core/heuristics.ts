/**
 * Lookups into Pi's own built-in model catalog.
 *
 * Pi already ships metadata for the models it supports natively — exact context
 * windows, pricing, thinking-level maps, and `compat` flags. When a custom
 * endpoint serves one of those models, inheriting that metadata is strictly
 * better than guessing, and it is the one piece of "discovery" this extension
 * can do without a network call.
 *
 * This is a *reference*, never an authority: the provider's `modelDefaults` and
 * the user's `modelOverrides` both outrank it (§13, §16).
 */

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ThinkingLevelMap } from "./types.ts";

export interface CatalogHints {
	name?: string;
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: Record<string, number>;
	compat?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function isThinkingLevelMap(value: unknown): value is ThinkingLevelMap {
	if (!isRecord(value)) return false;
	return Object.keys(value).every((key) => THINKING_LEVELS.has(key));
}

/**
 * Normalize a model id for catalog comparison.
 *
 * A release date is part of the id and is stripped before the tag rules; a `:`
 * or `/` separates a vendor from the model and is folded to a hyphen so
 * `anthropic/claude-opus-4.7` and `Anthropic: Claude Opus 4.7` compare equal.
 */
export function normalizeId(id: string): string {
	return id
		.toLowerCase()
		.replace(/:\s*/g, "-")
		.replace(/@.*$/, "")
		.replace(/-(latest|preview|stable|beta|exp|experimental)$/, "")
		.replace(/[.\s_]+/g, "-")
		.replace(/\/+|-+/g, "-")
		.replace(/^-|-$/g, "")
		.replace(/-\d{8}$/, "");
}

/**
 * The id with a leading vendor segment removed.
 *
 * Only a segment originally separated by `/` or `:` qualifies, so
 * `anthropic/claude-opus-4.7` yields `claude-opus-4-7` while `grok-4` is left
 * alone — splitting a plain hyphenated id would reduce it to `4`.
 */
export function stripVendor(id: string): string {
	const match = /^([a-z0-9_.-]+)\s*([/:])\s*(.+)$/i.exec(id.trim());
	if (!match) return normalizeId(id);
	const [, left, separator, right] = match;
	// A `:` followed by a known qualifier is a tag (`model:free`), not a vendor.
	if (separator === ":" && isTagQualifier(right)) return normalizeId(`${left}-${right}`);
	return normalizeId(right);
}

/** True when a `:` right-hand side is a tag rather than a model name. */
function isTagQualifier(value: string): boolean {
	const lower = value.toLowerCase();
	if (/^(free|latest|preview|stable|beta|exp|experimental|online|extended|thinking|instruct|chat|base|vision|mini|nano|turbo|fast)$/.test(lower)) {
		return true;
	}
	if (/^\d+(?:\.\d+)?[bm]$/.test(lower)) return true;
	if (/^(?:q|iq|fp|bf|int)\d+(_[a-z0-9]+)*$/.test(lower)) return true;
	return false;
}

/** Drop a trailing size or quantisation suffix: `qwen2-5-coder-7b` -> `qwen2-5-coder`. */
export function stripTag(normalized: string): string {
	let out = normalized;
	for (let i = 0; i < 6; i++) {
		const next = out.replace(
			/-(?:\d+(?:-\d+)?[bBmM]|q\d+(?:-k(?:-[a-z0-9]+)*)?|i?q\d+(?:-[a-z0-9]+)*|fp\d+|bf\d+|int\d+|instruct|chat|base|free|online|extended)$/i,
			"",
		);
		if (next === out) break;
		out = next;
	}
	return out.replace(/-\d+$/, "");
}

/** Drop an intermediate version segment: `deepseek-v4-1-flash` -> `deepseek-v4-flash`. */
function stripVersionSegment(normalized: string): string {
	return normalized.replace(/-(\d+)-(?=[a-z])/g, "-");
}

/** Every form of an id worth trying against the catalog, most specific first. */
function catalogCandidates(id: string): string[] {
	const normalized = normalizeId(id);
	const withoutTag = stripTag(normalized);
	const forms = [normalized, withoutTag, stripVersionSegment(withoutTag), stripVersionSegment(normalized)];
	return [...new Set(forms.filter(Boolean))];
}

/**
 * Providers that host a family's models directly, keyed by the family token in
 * a model id. The first-party provider is authoritative for context window and
 * pricing; aggregators resell the same id at different numbers.
 */
const FIRST_PARTY: Record<string, string[]> = {
	claude: ["anthropic"],
	gpt: ["openai", "openai-codex"],
	o1: ["openai"], o3: ["openai"], o4: ["openai"], o5: ["openai"],
	gemini: ["google", "google-vertex"],
	grok: ["xai"],
	deepseek: ["deepseek"],
	GLM: ["zai", "zai-coding-cn"],
	llama: ["meta"],
	mistral: ["mistral"], magistral: ["mistral"],
	qwen: ["qwen-token-plan", "qwen-token-plan-cn"],
	kimi: ["moonshotai", "moonshotai-cn", "kimi-coding"],
	minimax: ["minimax", "minimax-cn"],
	command: ["cohere"],
	nova: ["amazon-bedrock"],
};

/** Providers that resell or proxy other labs' models. */
const AGGREGATOR = /openrouter|baseten|fireworks|cloudflare|nvidia|huggingface|vercel|opencode|azure|bedrock|copilot|together|groq|xiaomi|ant-ling/i;

/**
 * Sort key that floats authoritative entries above resellers.
 *
 * The same id appears under many providers with different context windows and
 * prices (`gpt-5.5` is 272k on `openai`, 1050k on `azure-openai-responses`).
 * Without ranking, whichever provider is enumerated first wins.
 */
function providerRank(entry: unknown): number {
	if (!isRecord(entry)) return 100;
	const modelId = typeof entry.id === "string" ? entry.id.toLowerCase() : "";
	const provider = typeof entry.provider === "string" ? entry.provider : "";
	if (!provider) return 50;

	const family = /^([a-z]+)/.exec(modelId.replace(/^[a-z0-9_.-]+\//, ""))?.[1] ?? "";
	const owners =
		FIRST_PARTY[family] ?? Object.entries(FIRST_PARTY).find(([token]) => modelId.includes(token.toLowerCase()))?.[1];
	if (owners) {
		if (owners.includes(provider)) return 0;
		if (AGGREGATOR.test(provider)) return 20;
		return 5;
	}
	return AGGREGATOR.test(provider) ? 20 : 10;
}

let builtinIndex: Map<string, CatalogHints> | undefined;

/** Build a lookup over every model Pi knows, keyed by normalized id and name. */
function getBuiltinIndex(): Map<string, CatalogHints> {
	if (builtinIndex) return builtinIndex;
	const index = new Map<string, CatalogHints>();

	let models: unknown[] = [];
	try {
		models = [...builtinModels().getModels()];
	} catch {
		builtinIndex = index;
		return index;
	}

	// Prefer the id whose provider hosts the family, so the numbers come from the
	// lab rather than a reseller.
	const ranked = [...models].sort((a, b) => providerRank(a) - providerRank(b));

	for (const entry of ranked) {
		if (!isRecord(entry)) continue;
		if (typeof entry.id !== "string") continue;

		const hints: CatalogHints = {};
		if (typeof entry.name === "string") hints.name = cleanName(entry.name);
		if (entry.reasoning === true) hints.reasoning = true;
		if (isThinkingLevelMap(entry.thinkingLevelMap)) hints.thinkingLevelMap = entry.thinkingLevelMap;
		if (Array.isArray(entry.input)) {
			const input = entry.input.filter((v): v is "text" | "image" => v === "text" || v === "image");
			if (input.length > 0) hints.input = input;
		}
		if (typeof entry.contextWindow === "number") hints.contextWindow = entry.contextWindow;
		if (typeof entry.maxTokens === "number") hints.maxTokens = entry.maxTokens;
		if (isRecord(entry.cost)) {
			const cost = entry.cost;
			const rates: Record<string, number> = {};
			for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
				const value = cost[key];
				if (typeof value === "number" && Number.isFinite(value)) rates[key] = value;
			}
			// An all-zero cost is "unknown", not "free"; leaving it out lets the
			// provider's own defaults apply instead of masking them with zeros.
			if (rates.input || rates.output) hints.cost = rates;
		}
		if (isRecord(entry.compat)) hints.compat = entry.compat;

		const keys = catalogCandidates(entry.id);
		if (typeof entry.name === "string") keys.push(normalizeId(cleanName(entry.name)));
		// First writer wins, so a canonical entry is not shadowed by an alias.
		for (const key of keys) {
			if (key && !index.has(key)) index.set(key, hints);
		}
	}

	builtinIndex = index;
	return index;
}

/** Drop the trailing disambiguator from a display name, e.g. "Opus 4.5 (latest)". */
function cleanName(name: string): string {
	return name.replace(/\s*\((latest|preview|stable|beta|exp|experimental)\)\s*$/i, "").trim();
}

/** Pi's catalog metadata for a model id, when Pi knows it. */
export function catalogHints(id: string): CatalogHints | undefined {
	const index = getBuiltinIndex();
	for (const candidate of [...catalogCandidates(id), ...catalogCandidates(stripVendor(id))]) {
		const hit = index.get(candidate);
		if (hit) return hit;
	}
	return undefined;
}
