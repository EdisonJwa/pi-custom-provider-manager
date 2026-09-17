/**
 * Compiling a provider configuration into a native Pi `Provider`.
 *
 * This is where the extension's architectural boundary is enforced. Everything
 * here runs locally: read configuration, build a `Provider` object, hand it to
 * Pi. No remote call is made during construction (§2.2).
 *
 * `createProvider()` owns the dynamic catalog — it restores Pi's last persisted
 * list, and publishes successful refreshes back through Pi's model store. The
 * extension therefore keeps no catalog of its own and persists nothing (§2.3).
 */

import { createProvider, type Model, type Provider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { createProviderAuth } from "./auth.ts";
import { fetchProviderModels } from "./discovery.ts";
import { compileManualModels, resolveModels, toPiModel, type ResolvedModel } from "./resolve.ts";
import type { CustomProviderConfig, SupportedApi } from "./types.ts";

/**
 * The Pi API implementation for a configured API type.
 *
 * The lazy entrypoints are used so a provider SDK is loaded only when a model
 * belonging to that API is actually exercised (§5).
 */
function apiImplementation(api: SupportedApi) {
	switch (api) {
		case "openai-completions":
			return openAICompletionsApi();
		case "openai-responses":
			return openAIResponsesApi();
		case "anthropic-messages":
			return anthropicMessagesApi();
		case "google-generative-ai":
			return googleGenerativeAIApi();
	}
}

/** Turn resolved metadata into Pi models for this provider and API. */
function toPiModels(resolved: ResolvedModel[], config: CustomProviderConfig): Model<SupportedApi>[] {
	return resolved.map((model) => toPiModel(model, config.id, config.api));
}

/**
 * Build the `fetchModels` callback.
 *
 * Pi calls this when it refreshes the provider — at startup from its persisted
 * catalog, and on an explicit refresh. Throwing is the correct response to a
 * failure: Pi keeps the previous catalog rather than replacing it with nothing.
 */
/**
 * Pi's resolved credential for a provider, as a discovery key.
 *
 * The extension only registers api-key auth, so a stored `api_key` credential is
 * the case that matters. An OAuth credential has no plain key to forward, and
 * such a provider falls back to its environment variable.
 */
function storedKeyFrom(context: RefreshModelsContext): string | undefined {
	const credential = context.credential;
	if (credential?.type === "api_key" && credential.key) return credential.key;
	return undefined;
}

function buildFetchModels(config: CustomProviderConfig) {
	return async (context: RefreshModelsContext): Promise<readonly Model<SupportedApi>[]> => {
		// Pass Pi's resolved credential through: a provider authenticated with
		// `/login` and no environment variable would otherwise discover nothing.
		const discovered = await fetchProviderModels(config, context.signal, storedKeyFrom(context));
		return toPiModels(resolveModels(discovered, config), config);
	};
}

/**
 * Compile a provider configuration.
 *
 * `models` is the static baseline — the manual models, resolved through the same
 * chain as discovered ones. The dynamic catalog arrives through `fetchModels`.
 */
export function buildProvider(config: CustomProviderConfig): Provider<SupportedApi> {
	const provider = createProvider<SupportedApi>({
		id: config.id,
		name: config.name,
		baseUrl: config.baseUrl,
		headers: config.headers,
		auth: createProviderAuth(config),
		models: toPiModels(compileManualModels(config), config),
		fetchModels: config.discovery ? buildFetchModels(config) : undefined,
		api: apiImplementation(config.api),
	});
	return provider;
}

/** The models a configuration can offer without any network access. */
export function staticModels(config: CustomProviderConfig): Model<SupportedApi>[] {
	return toPiModels(compileManualModels(config), config);
}
