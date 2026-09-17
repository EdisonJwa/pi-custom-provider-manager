/**
 * Configuration model for a custom provider.
 *
 * This extension is a **provider configuration and model-discovery layer**. It
 * describes what Pi cannot infer itself — identity, API type, endpoint,
 * credentials, discovery endpoint/parser, model defaults, manual models, and
 * per-model overrides — and compiles that into a native Pi `Provider`.
 *
 * The configuration file holds no dynamic model catalog: Pi owns restoration and
 * persistence of discovered models.
 */

/** The four Pi API implementations this extension supports. */
export type SupportedApi =
	| "openai-completions"
	| "openai-responses"
	| "anthropic-messages"
	| "google-generative-ai";

export const SUPPORTED_APIS: readonly SupportedApi[] = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
];

/** Model-list formats the extension can parse. */
export type ModelParser = "openai" | "anthropic" | "gemini";

export const MODEL_PARSERS: readonly ModelParser[] = ["openai", "anthropic", "gemini"];

/** pi thinking levels, from least to most effort. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * Maps pi thinking levels to what the upstream understands.
 *
 * - a string: the endpoint accepts this value for that level
 * - `null`: the level is unsupported and hidden
 * - omitted: fall back to the API implementation's default
 */
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

export interface ModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/**
 * Values every discovered model inherits before its own override is applied.
 *
 * Most model-list endpoints return only an id, so Pi's required metadata has to
 * come from somewhere explicit. `contextWindow` and `maxTokens` must be
 * configurable for exactly that reason.
 */
export interface ModelDefaults {
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	cost?: ModelCost;
}

/**
 * A model the user defines directly.
 *
 * Covers two cases: a provider with no usable model-list endpoint, and models a
 * provider lists but does not return. Omitted values come from `modelDefaults`.
 * When the same id appears in discovery and `manualModels`, the manual
 * definition wins.
 */
export interface ManualModel {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: ModelCost;
	thinkingLevelMap?: ThinkingLevelMap;
	compat?: Record<string, unknown>;
}

/**
 * Per-model metadata corrections, for what a model-list endpoint cannot know or
 * reports incorrectly.
 *
 * `"*"` applies to every model on the provider; the exact-id override is applied
 * on top.
 */
export interface ModelOverride {
	name?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: Partial<ModelCost>;
	thinkingLevelMap?: ThinkingLevelMap;
	compat?: Record<string, unknown>;
}

/** Where and how to fetch a provider's dynamic model list. */
export interface DiscoveryConfig {
	/** Model-list endpoint. A path is resolved against `baseUrl`; an absolute URL is used as-is. */
	endpoint: string;
	parser: ModelParser;
	/** Bounds the request. Default 15000. */
	timeoutMs?: number;
}

export interface ProviderAuthConfig {
	/** Optional environment-variable fallback. A credential stored by Pi takes precedence. */
	env?: string;
}

export interface CustomProviderConfig {
	id: string;
	name: string;
	api: SupportedApi;
	baseUrl: string;
	auth: ProviderAuthConfig;
	headers?: Record<string, string>;
	discovery?: DiscoveryConfig;
	modelDefaults: ModelDefaults;
	manualModels?: ManualModel[];
	modelOverrides?: Record<string, ModelOverride>;
}

export interface CustomProviderFile {
	/** Config schema version. */
	version: number;
	providers: CustomProviderConfig[];
}

export const CONFIG_VERSION = 1;
