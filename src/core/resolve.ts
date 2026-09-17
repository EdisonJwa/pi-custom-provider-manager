/**
 * Resolving model metadata.
 *
 * A discovered model usually supplies only an id, and Pi needs more. Each model
 * is resolved through a fixed precedence chain (§13):
 *
 *     discovered metadata
 *             ↓
 *     provider model defaults
 *             ↓
 *     per-model override
 *             ↓
 *     manual model, when the same id is explicitly defined
 *             ↓
 *     Pi Model
 *
 * The output is a plain Pi `Model` — only fields Pi's `Model` type defines are
 * emitted, and no separate capability registry is introduced (§16). Manual
 * models that discovery never reported are appended so a provider can declare
 * models its endpoint does not list (§15).
 */

import { catalogHints } from "./heuristics.ts";
import type { ParsedModel } from "./parsers/index.ts";
import type {
	CustomProviderConfig,
	ManualModel,
	ModelCost,
	ModelDefaults,
	ModelOverride,
	ThinkingLevelMap,
} from "./types.ts";
import type { Model, Api } from "@earendil-works/pi-ai";

/** Zero cost, the recommended default when pricing is unknown (§14). */
export const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * The metadata of one model, before it becomes a Pi `Model`.
 *
 * `provider` is filled in by the caller, since resolution is provider-agnostic.
 */
export interface ResolvedModel {
	id: string;
	name: string;
	api: CustomProviderConfig["api"];
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: ModelCost;
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: ThinkingLevelMap;
	compat?: Record<string, unknown>;
	samplingParams?: Record<string, unknown>;
	headers?: Record<string, string>;
}

/** Merge partial cost over a base, so a one-field override keeps the rest. */
function mergeCost(base: ModelCost, patch: Partial<ModelCost> | undefined): ModelCost {
	if (!patch) return base;
	return {
		input: patch.input ?? base.input,
		output: patch.output ?? base.output,
		cacheRead: patch.cacheRead ?? base.cacheRead,
		cacheWrite: patch.cacheWrite ?? base.cacheWrite,
	};
}

/**
 * Overlay a manual model or an override onto resolved metadata.
 *
 * Both carry the same optional field set, so one merge serves both. A manual
 * model is simply the highest-precedence overlay.
 */
function overlay(
	base: ResolvedModel,
	patch: ManualModel | ModelOverride,
): ResolvedModel {
	const next: ResolvedModel = { ...base };
	if (patch.name !== undefined) next.name = patch.name;
	if (patch.reasoning !== undefined) next.reasoning = patch.reasoning;
	if (patch.input !== undefined) next.input = patch.input;
	if (patch.contextWindow !== undefined) next.contextWindow = patch.contextWindow;
	if (patch.maxTokens !== undefined) next.maxTokens = patch.maxTokens;
	if (patch.cost !== undefined) next.cost = mergeCost(base.cost, patch.cost);
	// An override's map replaces the inferred one: it is the more specific
	// statement of intent, and a partial merge would make it impossible to
	// *remove* an inherited level.
	if (patch.thinkingLevelMap !== undefined) next.thinkingLevelMap = { ...patch.thinkingLevelMap };
	if (patch.compat !== undefined) next.compat = { ...(base.compat ?? {}), ...patch.compat };
	return next;
}

/**
 * The starting point for one id: what Pi's own catalog knows, else the
 * provider's declared defaults.
 *
 * Pi's catalog is consulted first because it carries exact context windows,
 * pricing, thinking levels, and compatibility flags for models Pi already
 * supports. A model Pi knows nothing about falls back to `modelDefaults`, which
 * is the authoritative source for a private gateway.
 */
function baseline(id: string, name: string | undefined, defaults: ModelDefaults): ResolvedModel {
	const hints = catalogHints(id);
	return {
		id,
		name: name ?? hints?.name ?? id,
		api: "openai-completions",
		baseUrl: "",
		reasoning: defaults.reasoning,
		input: defaults.input,
		cost: defaults.cost ?? ZERO_COST,
		contextWindow: defaults.contextWindow,
		maxTokens: defaults.maxTokens,
		thinkingLevelMap: undefined,
		compat: undefined,
	};
}

/**
 * Resolve one discovered model through the full chain.
 *
 * `"*"` in `modelOverrides` is applied before the exact-id entry, so a wildcard
 * sets a floor and a specific entry corrects it.
 */
function resolveOne(
	model: ParsedModel,
	config: CustomProviderConfig,
): ResolvedModel {
	const defaults = config.modelDefaults;
	const overrides = config.modelOverrides ?? {};
	let resolved = baseline(model.id, model.name, defaults);

	// Catalog metadata outranks the provider's declared defaults, since it is
	// measured rather than guessed. Defaults still win for anything the catalog
	// does not describe.
	const hints = catalogHints(model.id);
	if (hints) {
		resolved.reasoning = hints.reasoning ?? defaults.reasoning;
		resolved.input = hints.input ?? defaults.input;
		resolved.contextWindow = hints.contextWindow ?? defaults.contextWindow;
		resolved.maxTokens = hints.maxTokens ?? defaults.maxTokens;
		if (hints.cost) resolved.cost = { ...ZERO_COST, ...defaults.cost, ...hints.cost } as ModelCost;
		if (hints.thinkingLevelMap) resolved.thinkingLevelMap = hints.thinkingLevelMap;
		if (hints.compat) resolved.compat = hints.compat;
		if (hints.name && !model.name) resolved.name = hints.name;
	}

	const wildcard = overrides["*"];
	if (wildcard) resolved = overlay(resolved, wildcard);
	const exact = overrides[model.id];
	if (exact) resolved = overlay(resolved, exact);

	return resolved;
}

/**
 * Turn one manual model into a resolved model, using the same chain so a manual
 * entry and a discovered entry are described by identical rules.
 */
function resolveManual(model: ManualModel, config: CustomProviderConfig): ResolvedModel {
	// A manual model is an explicit declaration: it is the final word for the id,
	// so it is resolved as if it were discovered and then overlaid on itself.
	const resolved = resolveOne({ id: model.id, name: model.name }, config);
	return overlay(resolved, model);
}

/**
 * Resolve a discovered catalog plus the provider's manual models into the final
 * list (§11, §15).
 *
 * Deduplication is by id. When an id appears in both discovery and
 * `manualModels`, the manual definition wins — that is what lets a user correct
 * an automatic result without disabling discovery.
 */
export function resolveModels(discovered: ParsedModel[], config: CustomProviderConfig): ResolvedModel[] {
	const resolved = new Map<string, ResolvedModel>();

	for (const model of discovered) {
		if (!resolved.has(model.id)) resolved.set(model.id, resolveOne(model, config));
	}

	// Manual models are applied last, and may also introduce ids discovery never
	// reported (the "provider lists a subset" case).
	for (const manual of config.manualModels ?? []) {
		resolved.set(manual.id, resolveManual(manual, config));
	}

	return [...resolved.values()];
}

/**
 * The static baseline Pi registers: manual models only.
 *
 * Discovery results are not in here. They arrive through `fetchModels`, which Pi
 * restores from its own persisted catalog and refreshes in the background, so
 * the extension never blocks startup on a remote endpoint (§2.2, §9).
 */
export function compileManualModels(config: CustomProviderConfig): ResolvedModel[] {
	return (config.manualModels ?? []).map((manual) => resolveManual(manual, config));
}

/** Attach the provider identity and API to a resolved model, producing a Pi model. */
export function toPiModel<TApi extends Api>(
	resolved: ResolvedModel,
	providerId: string,
	api: TApi,
): Model<TApi> {
	const model: Model<TApi> = {
		id: resolved.id,
		name: resolved.name,
		api,
		provider: providerId,
		baseUrl: resolved.baseUrl,
		reasoning: resolved.reasoning,
		input: resolved.input,
		cost: resolved.cost,
		contextWindow: resolved.contextWindow,
		maxTokens: resolved.maxTokens,
	};
	if (resolved.thinkingLevelMap) model.thinkingLevelMap = resolved.thinkingLevelMap as Model<TApi>["thinkingLevelMap"];
	// `compat` is a conditional type keyed on the API, so an untyped record from
	// configuration cannot be narrowed to it directly — the API implementation
	// validates what it reads, and unknown keys are ignored.
	if (resolved.compat) model.compat = resolved.compat as unknown as Model<TApi>["compat"];
	if (resolved.samplingParams) model.samplingParams = resolved.samplingParams;
	if (resolved.headers) model.headers = resolved.headers;
	return model;
}
