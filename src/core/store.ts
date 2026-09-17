/**
 * Reading, validating, and writing `~/.pi/agent/custom-providers.json`.
 *
 * The file holds provider configuration only — never a model catalog, which Pi
 * persists itself. Every parse is tolerant: a corrupt file degrades to "no
 * providers" with a diagnostic rather than breaking startup, and validation
 * reports every problem it finds so a hand-edit can be fixed in one pass.
 *
 * Validation happens *before* registration (§23), and a configuration that fails
 * is never allowed to replace a provider that is currently registered (§22).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	CONFIG_VERSION,
	MODEL_PARSERS,
	SUPPORTED_APIS,
	THINKING_LEVELS,
	type CustomProviderConfig,
	type CustomProviderFile,
	type DiscoveryConfig,
	type ManualModel,
	type ModelCost,
	type ModelDefaults,
	type ModelOverride,
	type ModelParser,
	type SupportedApi,
	type ThinkingLevelMap,
} from "./types.ts";

/**
 * Pi's agent directory.
 *
 * Delegated to Pi rather than reimplemented: Pi honours its own
 * `PI_CODING_AGENT_DIR` override, and guessing the name here would silently
 * ignore it.
 */
export function agentDir(): string {
	try {
		return getAgentDir();
	} catch {
		return join(process.env.HOME ?? process.cwd(), ".pi", "agent");
	}
}

export function configPath(): string {
	return join(agentDir(), "custom-providers.json");
}

export interface LoadResult {
	providers: CustomProviderConfig[];
	/** Present when the file exists but could not be used at all. */
	error?: string;
	/** Problems with individual entries, which were skipped. */
	problems: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function toCost(raw: unknown): ModelCost | undefined {
	if (!isRecord(raw)) return undefined;
	const cost: ModelCost = {
		input: typeof raw.input === "number" ? raw.input : 0,
		output: typeof raw.output === "number" ? raw.output : 0,
		cacheRead: typeof raw.cacheRead === "number" ? raw.cacheRead : 0,
		cacheWrite: typeof raw.cacheWrite === "number" ? raw.cacheWrite : 0,
	};
	return cost;
}

function toPartialCost(raw: unknown): Partial<ModelCost> | undefined {
	if (!isRecord(raw)) return undefined;
	const cost: Partial<ModelCost> = {};
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		const value = raw[key];
		if (typeof value === "number" && Number.isFinite(value)) cost[key] = value;
	}
	return Object.keys(cost).length > 0 ? cost : undefined;
}

function toInputList(raw: unknown): ("text" | "image")[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const list = raw.filter((v): v is "text" | "image" => v === "text" || v === "image");
	return list.length > 0 ? list : undefined;
}

/**
 * Validate a thinking level map. Returns the map and any problems found.
 *
 * Unknown keys are rejected rather than dropped: a typo like `"hight"` would
 * otherwise silently do nothing, which is the failure mode this validation
 * exists to prevent.
 */
function toThinkingLevelMap(raw: unknown, where: string, problems: string[]): ThinkingLevelMap | undefined {
	// Absent is the normal case — most models have no explicit map.
	if (raw === undefined) return undefined;
	if (!isRecord(raw)) {
		problems.push(`${where}: thinkingLevelMap must be an object`);
		return undefined;
	}
	const map: ThinkingLevelMap = {};
	for (const [level, value] of Object.entries(raw)) {
		if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
			problems.push(`${where}: thinkingLevelMap has unknown level "${level}" (expected ${THINKING_LEVELS.join(", ")})`);
			continue;
		}
		if (value !== null && typeof value !== "string") {
			problems.push(`${where}: thinkingLevelMap["${level}"] must be a string or null`);
			continue;
		}
		map[level as keyof ThinkingLevelMap] = value as string | null;
	}
	return Object.keys(map).length > 0 ? map : undefined;
}

function toManualModel(raw: unknown, where: string, problems: string[]): ManualModel | undefined {
	if (!isRecord(raw)) {
		problems.push(`${where}: must be an object`);
		return undefined;
	}
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	if (!id) {
		problems.push(`${where}: id is required`);
		return undefined;
	}

	const model: ManualModel = { id };
	if (typeof raw.name === "string" && raw.name.trim()) model.name = raw.name.trim();
	if (typeof raw.reasoning === "boolean") model.reasoning = raw.reasoning;
	const input = toInputList(raw.input);
	if (input) model.input = input;
	if (isPositiveNumber(raw.contextWindow)) model.contextWindow = Math.floor(raw.contextWindow);
	else if (raw.contextWindow !== undefined) problems.push(`${where}: contextWindow must be > 0`);
	if (isPositiveNumber(raw.maxTokens)) model.maxTokens = Math.floor(raw.maxTokens);
	else if (raw.maxTokens !== undefined) problems.push(`${where}: maxTokens must be > 0`);
	const cost = toCost(raw.cost);
	if (cost) model.cost = cost;
	const map = toThinkingLevelMap(raw.thinkingLevelMap, where, problems);
	if (map) model.thinkingLevelMap = map;
	if (isRecord(raw.compat)) model.compat = raw.compat;
	return model;
}

function toOverride(raw: unknown, where: string, problems: string[]): ModelOverride | undefined {
	if (!isRecord(raw)) {
		problems.push(`${where}: must be an object`);
		return undefined;
	}
	const override: ModelOverride = {};
	if (typeof raw.name === "string" && raw.name.trim()) override.name = raw.name.trim();
	if (typeof raw.reasoning === "boolean") override.reasoning = raw.reasoning;
	const input = toInputList(raw.input);
	if (input) override.input = input;
	if (isPositiveNumber(raw.contextWindow)) override.contextWindow = Math.floor(raw.contextWindow);
	else if (raw.contextWindow !== undefined) problems.push(`${where}: contextWindow must be > 0`);
	if (isPositiveNumber(raw.maxTokens)) override.maxTokens = Math.floor(raw.maxTokens);
	else if (raw.maxTokens !== undefined) problems.push(`${where}: maxTokens must be > 0`);
	const cost = toPartialCost(raw.cost);
	if (cost) override.cost = cost;
	const map = toThinkingLevelMap(raw.thinkingLevelMap, where, problems);
	if (map) override.thinkingLevelMap = map;
	if (isRecord(raw.compat)) override.compat = raw.compat;
	return override;
}

/**
 * Coerce one entry into a validated `CustomProviderConfig`.
 *
 * Returns undefined when the entry cannot be used. Every reason is pushed onto
 * `problems` so a user with several mistakes sees all of them at once.
 */
export function normalizeProvider(raw: unknown, problems: string[] = []): CustomProviderConfig | undefined {
	if (!isRecord(raw)) {
		problems.push("provider entry must be an object");
		return undefined;
	}

	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	const name = typeof raw.name === "string" ? raw.name.trim() : "";
	const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "";
	const label = id || name || "<unnamed provider>";

	if (!id) problems.push(`${label}: id is required`);
	if (!name) problems.push(`${label}: name is required`);

	let baseUrlValid = false;
	if (baseUrl) {
		try {
			new URL(baseUrl);
			baseUrlValid = true;
		} catch {
			problems.push(`${label}: baseUrl is not a valid URL ("${baseUrl}")`);
		}
	} else {
		problems.push(`${label}: baseUrl is required`);
	}

	const api = SUPPORTED_APIS.includes(raw.api as SupportedApi) ? (raw.api as SupportedApi) : undefined;
	if (!api) {
		problems.push(
			`${label}: api must be one of ${SUPPORTED_APIS.join(", ")}${raw.api !== undefined ? ` (got ${JSON.stringify(raw.api)})` : ""}`,
		);
	}

	if (!id || !name || !baseUrlValid || !api) return undefined;

	const provider: CustomProviderConfig = {
		id,
		name,
		api,
		baseUrl,
		auth: {},
		modelDefaults: { reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8_192 },
	};

	// ---- auth ---------------------------------------------------------------
	if (isRecord(raw.auth)) {
		const env = typeof raw.auth.env === "string" ? raw.auth.env.trim() : "";
		if (env) provider.auth.env = env;
	} else if (raw.auth !== undefined) {
		problems.push(`${label}: auth must be an object`);
	}

	// ---- headers ------------------------------------------------------------
	if (isRecord(raw.headers)) {
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(raw.headers)) {
			if (typeof value === "string") headers[key] = value;
			else problems.push(`${label}: headers["${key}"] must be a string`);
		}
		if (Object.keys(headers).length > 0) provider.headers = headers;
	}

	// ---- discovery ----------------------------------------------------------
	if (raw.discovery !== undefined) {
		if (!isRecord(raw.discovery)) {
			problems.push(`${label}: discovery must be an object`);
		} else {
			const endpoint = typeof raw.discovery.endpoint === "string" ? raw.discovery.endpoint.trim() : "";
			const parser = MODEL_PARSERS.includes(raw.discovery.parser as ModelParser)
				? (raw.discovery.parser as ModelParser)
				: undefined;
			if (!endpoint) problems.push(`${label}: discovery.endpoint is required when discovery is set`);
			if (!parser) {
				problems.push(`${label}: discovery.parser must be one of ${MODEL_PARSERS.join(", ")}`);
			}
			if (endpoint && parser) {
				const discovery: DiscoveryConfig = { endpoint, parser };
				if (isPositiveNumber(raw.discovery.timeoutMs)) discovery.timeoutMs = Math.floor(raw.discovery.timeoutMs);
				else if (raw.discovery.timeoutMs !== undefined) {
					problems.push(`${label}: discovery.timeoutMs must be > 0`);
				}
				provider.discovery = discovery;
			}
		}
	}

	// ---- model defaults -----------------------------------------------------
	if (raw.modelDefaults !== undefined) {
		if (!isRecord(raw.modelDefaults)) {
			problems.push(`${label}: modelDefaults must be an object`);
		} else {
			const defaults: ModelDefaults = { ...provider.modelDefaults };
			if (typeof raw.modelDefaults.reasoning === "boolean") defaults.reasoning = raw.modelDefaults.reasoning;
			const input = toInputList(raw.modelDefaults.input);
			if (input) defaults.input = input;
			if (isPositiveNumber(raw.modelDefaults.contextWindow)) {
				defaults.contextWindow = Math.floor(raw.modelDefaults.contextWindow);
			} else if (raw.modelDefaults.contextWindow !== undefined) {
				problems.push(`${label}: modelDefaults.contextWindow must be > 0`);
			}
			if (isPositiveNumber(raw.modelDefaults.maxTokens)) {
				defaults.maxTokens = Math.floor(raw.modelDefaults.maxTokens);
			} else if (raw.modelDefaults.maxTokens !== undefined) {
				problems.push(`${label}: modelDefaults.maxTokens must be > 0`);
			}
			const cost = toCost(raw.modelDefaults.cost);
			if (cost) defaults.cost = cost;
			provider.modelDefaults = defaults;
		}
	}

	// ---- manual models ------------------------------------------------------
	if (raw.manualModels !== undefined) {
		if (!Array.isArray(raw.manualModels)) {
			problems.push(`${label}: manualModels must be an array`);
		} else {
			const manual: ManualModel[] = [];
			const seen = new Set<string>();
			raw.manualModels.forEach((entry, index) => {
				const model = toManualModel(entry, `${label}: manualModels[${index}]`, problems);
				if (!model) return;
				if (seen.has(model.id)) {
					problems.push(`${label}: manualModels has a duplicate id "${model.id}"`);
					return;
				}
				seen.add(model.id);
				manual.push(model);
			});
			if (manual.length > 0) provider.manualModels = manual;
		}
	}

	// ---- per-model overrides ------------------------------------------------
	if (raw.modelOverrides !== undefined) {
		if (!isRecord(raw.modelOverrides)) {
			problems.push(`${label}: modelOverrides must be an object`);
		} else {
			const overrides: Record<string, ModelOverride> = {};
			for (const [key, value] of Object.entries(raw.modelOverrides)) {
				const override = toOverride(value, `${label}: modelOverrides["${key}"]`, problems);
				if (override) overrides[key] = override;
			}
			if (Object.keys(overrides).length > 0) provider.modelOverrides = overrides;
		}
	}

	return provider;
}

export async function loadProviders(): Promise<LoadResult> {
	let text: string;
	try {
		text = await readFile(configPath(), "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { providers: [], problems: [] };
		return { providers: [], problems: [], error: `Cannot read ${configPath()}: ${(error as Error).message}` };
	}

	if (!text.trim()) return { providers: [], problems: [] };

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { providers: [], problems: [], error: `${configPath()} is not valid JSON: ${(error as Error).message}` };
	}

	// A bare array was the shape of an earlier config format; accept it so a
	// hand-edited file is not rejected outright.
	const rawList = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.providers : undefined;
	if (!Array.isArray(rawList)) {
		return { providers: [], problems: [], error: `${configPath()} must contain a "providers" array.` };
	}

	const providers: CustomProviderConfig[] = [];
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const raw of rawList) {
		const provider = normalizeProvider(raw, problems);
		if (!provider) continue;
		if (seen.has(provider.id)) {
			problems.push(`${provider.id}: duplicate provider id — later entry ignored`);
			continue;
		}
		seen.add(provider.id);
		providers.push(provider);
	}

	return { providers, problems };
}

/** Write the provider list atomically, preserving nothing else in the file. */
export async function saveProviders(providers: CustomProviderConfig[]): Promise<string> {
	const path = configPath();
	const payload: CustomProviderFile = {
		version: CONFIG_VERSION,
		providers: [...providers].sort((a, b) => a.id.localeCompare(b.id)),
	};
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	await rename(tmp, path);
	return path;
}

/** Normalize a user-typed base URL into the root form Pi expects. */
export function normalizeBaseUrl(input: string): string {
	let url = input.trim();
	if (!url) return url;
	if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
	return url.replace(/\/+$/, "");
}

/**
 * Suggest a provider id from a base URL: `https://api.acme.dev/v1` -> `acme`.
 *
 * Hosts that carry no usable name (a bare IP, `localhost`, a container-internal
 * name) fall back to `local`, which is almost always what the user means.
 */
export function suggestId(baseUrl: string): string {
	try {
		const host = new URL(normalizeBaseUrl(baseUrl)).hostname;
		if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host === "[::1]") return "local";

		const parts = host.split(".").filter((part) => part && part !== "www");
		if (parts.length === 0) return "provider";

		// Trim generic TLDs and hosting prefixes so `api.acme.dev` becomes `acme`.
		const generic = new Set(["api", "com", "net", "org", "io", "dev", "ai", "co", "cloud", "app"]);
		const meaningful = parts.filter((part) => !generic.has(part));
		const candidate = (meaningful[0] ?? parts[0]).toLowerCase();
		if (candidate === "localhost") return "local";
		return sanitizeId(candidate);
	} catch {
		return "provider";
	}
}

/** Provider ids become Pi provider names, so keep them to a safe character set. */
function sanitizeId(value: string): string {
	const cleaned = value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
	return cleaned || "provider";
}

/** Environment variable names derived from an id, e.g. `my-proxy` -> `MY_PROXY_API_KEY`. */
export function suggestEnvVars(id: string): string[] {
	const upper = id.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
	if (!upper) return ["CUSTOM_API_KEY"];
	return [`${upper}_API_KEY`, `${upper}_TOKEN`];
}
