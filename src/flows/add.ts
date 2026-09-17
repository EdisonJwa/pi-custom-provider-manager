/**
 * `/custom-provider add` and `/custom-provider edit`.
 *
 * The flow collects only what Pi cannot infer: identity, API type, endpoint,
 * credential source, discovery endpoint and parser, and model defaults. Anything
 * a model-list endpoint reliably reports is left to discovery, and anything the
 * user needs to correct per model goes in `modelOverrides`.
 *
 * Nothing is written until the whole configuration validates, and registration
 * happens only after the file is saved (§22, §23).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadProviders, normalizeBaseUrl, saveProviders, suggestEnvVars, suggestId } from "../core/store.ts";
import { apiChoices, apiFromLabel, apiLabel, defaultDiscoveryEndpoint, parserChoices, parserFromLabel } from "../ui/labels.ts";
import { ask, askList, askText, CANCEL, CLEAR } from "../ui/prompt.ts";
import type { CustomProviderConfig, ManualModel, ModelDefaults, ModelParser, SupportedApi } from "../core/types.ts";

export async function addProviderFlow(ctx: ExtensionContext, after: () => Promise<void>): Promise<void> {
	const { providers: existing, problems, error } = await loadProviders();
	if (error) {
		ctx.ui.notify(error, "error");
		return;
	}
	if (problems.length > 0) {
		ctx.ui.notify(`Existing configuration has issues:\n  - ${problems.join("\n  - ")}`, "warning");
	}

	const collected = await collect(ctx, existing.map((provider) => provider.id));
	if (!collected) return;

	await saveProviders([...existing, collected.config]);
	await after();
	const modelCount = collected.config.manualModels?.length ?? 0;
	ctx.ui.notify(
		`Added ${collected.config.id} · ${modelCount} manual model${modelCount === 1 ? "" : "s"}` +
			(collected.config.discovery ? `. Models will appear after a refresh.` : "."),
		"info",
	);
}

export async function editProviderFlow(
	ctx: ExtensionContext,
	registered: { config: CustomProviderConfig }[],
	id: string,
	after: () => Promise<void>,
): Promise<void> {
	const { providers, error } = await loadProviders();
	if (error) {
		ctx.ui.notify(error, "error");
		return;
	}
	const index = providers.findIndex((provider) => provider.id === id);
	if (index === -1) {
		ctx.ui.notify(`No provider named "${id}".`, "warning");
		return;
	}

	const current = providers[index];
	const collected = await collect(ctx, [], current);
	if (!collected) return;

	const next = [...providers];
	next[index] = collected.config;
	await saveProviders(next);
	await after();
	ctx.ui.notify(`Updated ${collected.config.id}.`, "info");
}

/**
 * Collect one provider's configuration.
 *
 * Pass `existing` to edit: every prompt is prefilled with the current value, and
 * the id is fixed because changing it would orphan the registered provider.
 */
async function collect(
	ctx: ExtensionContext,
	takenIds: string[],
	existing?: CustomProviderConfig,
): Promise<{ config: CustomProviderConfig } | undefined> {
	const baseUrlInput = await askText(ctx, "Base URL", {
		placeholder: existing?.baseUrl ?? "https://api.example.com/v1  ·  http://localhost:11434",
		fallback: existing?.baseUrl,
	});
	if (!baseUrlInput) return undefined;
	const baseUrl = normalizeBaseUrl(baseUrlInput);

	const suggested = existing?.id ?? uniqueId(suggestId(baseUrl), takenIds);
	const name = await askText(ctx, "Provider name (shown in the UI)", {
		placeholder: existing?.name ?? suggested,
		fallback: existing?.name ?? suggested,
	});
	if (!name) return undefined;

	// The id is the Pi provider id, so it is fixed once registered.
	const id = existing
		? existing.id
		: await askText(ctx, "Provider ID (Pi provider name)", { placeholder: suggested, fallback: suggested });
	if (!id) return undefined;

	const api = await chooseApi(ctx, baseUrl, existing?.api);
	if (!api) return undefined;

	// ---- credential ---------------------------------------------------------
	const envName = await collectEnv(ctx, id, existing);
	if (envName === CANCEL) return undefined;

	// ---- discovery ----------------------------------------------------------
	const discovery = await collectDiscovery(ctx, api, existing);
	if (discovery === CANCEL) return undefined;

	// ---- model defaults -----------------------------------------------------
	const defaults = await collectDefaults(ctx, existing?.modelDefaults);
	if (!defaults) return undefined;

	// ---- manual models ------------------------------------------------------
	const manualModels = await collectManual(ctx, existing);
	if (manualModels === CANCEL) return undefined;

	const config: CustomProviderConfig = { id, name, api, baseUrl, auth: {}, modelDefaults: defaults };
	if (envName) config.auth.env = envName;
	if (existing?.headers) config.headers = existing.headers;
	if (discovery) config.discovery = discovery;
	if (manualModels.length > 0) config.manualModels = manualModels;
	if (existing?.modelOverrides) config.modelOverrides = existing.modelOverrides;

	return { config };
}

async function chooseApi(
	ctx: ExtensionContext,
	baseUrl: string,
	current: SupportedApi | undefined,
): Promise<SupportedApi | undefined> {
	const choices = apiChoices();
	if (current) {
		// Editing: the API is shown first so an unchanged provider needs one Enter.
		const choice = await ctx.ui.select(
			`API type (now: ${apiLabel(current)})`,
			[apiLabel(current), ...choices.filter((entry) => entry.value !== current).map((entry) => entry.label)],
		);
		return choice ? apiFromLabel(choice) : undefined;
	}

	// A URL hint orders the list; it never decides silently.
	const lower = baseUrl.toLowerCase();
	const guess: SupportedApi = lower.includes("anthropic") || lower.includes("claude")
		? "anthropic-messages"
		: lower.includes("generativelanguage") || lower.includes("gemini")
			? "google-generative-ai"
			: "openai-completions";
	const ordered = [guess, ...choices.map((entry) => entry.value).filter((value) => value !== guess)];
	const choice = await ctx.ui.select("API type", ordered.map((value) => apiLabel(value)));
	return choice ? apiFromLabel(choice) : undefined;
}

async function collectEnv(
	ctx: ExtensionContext,
	id: string,
	existing: CustomProviderConfig | undefined,
): Promise<string | undefined | typeof CANCEL> {
	const suggested = suggestEnvVars(id)[0];
	const detected = suggestEnvVars(id).find((name) => process.env[name]);
	const current = existing?.auth?.env;

	const choices = [
		...(current ? [`Keep env ${current}`] : []),
		...(detected && detected !== current ? [`Use ${detected} (detected)`] : []),
		"Enter an environment variable name",
		"No environment variable (Pi credential store only)",
	];
	const choice = await ctx.ui.select("Credential environment variable", choices);
	if (!choice) return CANCEL;
	if (choice.startsWith("Keep env ")) return current;
	if (choice.startsWith("Use ")) return detected;
	if (choice.startsWith("No environment")) return undefined;

	const answer = await ask(ctx, "Environment variable name", current ?? suggested);
	if (answer === CANCEL) return CANCEL;
	if (answer === CLEAR || answer === "") return current;
	return answer;
}

async function collectDiscovery(
	ctx: ExtensionContext,
	api: SupportedApi,
	existing: CustomProviderConfig | undefined,
): Promise<CustomProviderConfig["discovery"] | undefined | typeof CANCEL> {
	const current = existing?.discovery;
	const choices = [
		...(current ? [`Keep ${current.endpoint} (${current.parser})`] : []),
		"Discover models from an endpoint",
		"No discovery (manual models only)",
	];
	const choice = await ctx.ui.select("Model discovery", choices);
	if (!choice) return CANCEL;
	if (choice.startsWith("Keep ")) return current;
	if (choice.startsWith("No discovery")) return undefined;

	const endpointInput = await askText(ctx, "Models endpoint (path or absolute URL)", {
		placeholder: current?.endpoint ?? defaultDiscoveryEndpoint(api),
		fallback: current?.endpoint ?? defaultDiscoveryEndpoint(api),
	});
	if (!endpointInput) return CANCEL;

	const parserChoicesList = parserChoices();
	const parserLabelChoice = await ctx.ui.select(
		"Model list parser",
		parserChoicesList.map((entry) => entry.label),
	);
	if (!parserLabelChoice) return CANCEL;
	const parser: ModelParser | undefined = parserFromLabel(parserLabelChoice);
	if (!parser) return CANCEL;

	const timeout = await askText(ctx, "Discovery timeout in ms", {
		placeholder: String(current?.timeoutMs ?? 15000),
		fallback: String(current?.timeoutMs ?? 15000),
	});
	if (!timeout) return CANCEL;
	const timeoutMs = Number.parseInt(timeout, 10);

	return { endpoint: endpointInput, parser, ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}) };
}

async function collectDefaults(
	ctx: ExtensionContext,
	existing: ModelDefaults | undefined,
): Promise<ModelDefaults | undefined> {
	const base: ModelDefaults = existing ?? {
		reasoning: false,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 8_192,
	};

	const contextWindow = await askText(ctx, "Default context window (tokens)", {
		placeholder: String(base.contextWindow),
		fallback: String(base.contextWindow),
	});
	if (!contextWindow) return undefined;
	const context = Number.parseInt(contextWindow, 10);
	if (!Number.isFinite(context) || context <= 0) {
		ctx.ui.notify("Context window must be a positive number.", "warning");
		return undefined;
	}

	const maxTokens = await askText(ctx, "Default max output tokens", {
		placeholder: String(base.maxTokens),
		fallback: String(base.maxTokens),
	});
	if (!maxTokens) return undefined;
	const max = Number.parseInt(maxTokens, 10);
	if (!Number.isFinite(max) || max <= 0) {
		ctx.ui.notify("Max output tokens must be a positive number.", "warning");
		return undefined;
	}

	const reasoningChoice = await ctx.ui.select("Do these models support thinking by default?", [
		base.reasoning ? "Yes" : "No",
		base.reasoning ? "No" : "Yes",
	]);
	if (!reasoningChoice) return undefined;
	const reasoning = reasoningChoice === "Yes";

	const inputChoice = await ctx.ui.select("Default input modalities", [
		"Text only",
		"Text and images",
	]);
	if (!inputChoice) return undefined;

	return {
		reasoning,
		input: inputChoice === "Text and images" ? ["text", "image"] : ["text"],
		contextWindow: context,
		maxTokens: max,
		...(base.cost ? { cost: base.cost } : {}),
	};
}

async function collectManual(
	ctx: ExtensionContext,
	existing: CustomProviderConfig | undefined,
): Promise<ManualModel[] | typeof CANCEL> {
	const current = existing?.manualModels ?? [];
	if (current.length > 0) {
		const keep = await ctx.ui.select(`Keep ${current.length} manual model definition(s)?`, [
			"Keep them",
			"Replace them",
		]);
		if (!keep) return CANCEL;
		if (keep === "Keep them") return current;
	}

	const ids = await askList(ctx, "Manual model IDs, comma-separated (optional)", "company-llm-v7, internal-coder");
	if (ids === undefined) return CANCEL;
	const seen = new Set<string>();
	const manual: ManualModel[] = [];
	for (const id of ids) {
		if (seen.has(id)) continue;
		seen.add(id);
		manual.push({ id });
	}
	return manual;
}

function uniqueId(id: string, taken: string[]): string {
	if (!taken.includes(id)) return id;
	let suffix = 2;
	while (taken.includes(`${id}-${suffix}`)) suffix++;
	return `${id}-${suffix}`;
}
