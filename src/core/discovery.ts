/**
 * Remote model discovery.
 *
 * Discovery is explicit asynchronous work owned by the provider's `fetchModels`
 * callback. It never runs on the extension startup path (§2.2): Pi restores the
 * last catalog it persisted and calls `fetchModels` when a refresh is actually
 * requested.
 *
 * A failure here never deletes a catalog. `createProvider` keeps the previous
 * one when the callback throws (§22), so an outage degrades to "the models you
 * had", not "no models".
 */

import { resolveEndpointAuth, authHeadersFor } from "./auth.ts";
import { parseModels, dedupeModels, type ParsedModel } from "./parsers/index.ts";
import type { CustomProviderConfig, SupportedApi } from "./types.ts";

/**
 * The absolute URL to fetch.
 *
 * A relative endpoint is resolved against `baseUrl`, so `"/models"` and
 * `"/v1/models"` both work without the config needing to repeat the host.
 */
export function resolveDiscoveryUrl(config: CustomProviderConfig): string {
	const endpoint = config.discovery?.endpoint ?? "";
	if (/^https?:\/\//i.test(endpoint)) return endpoint;
	const base = config.baseUrl.replace(/\/+$/, "");
	const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
	return `${base}${path}`;
}

/**
 * Request headers for the model-list call (§11).
 *
 * The credential is whatever Pi resolved for this provider, falling back to the
 * configured environment variable. The header format follows the selected API —
 * bearer for the OpenAI-shaped APIs, `x-api-key` for Anthropic, `x-goog-api-key`
 * for Gemini. Provider `headers` are merged in last so a gateway can override
 * anything.
 */
export function buildDiscoveryHeaders(config: CustomProviderConfig, storedKey?: string): Record<string, string> {
	const headers: Record<string, string> = {
		accept: "application/json",
		...authHeadersFor(config.api, resolveEndpointAuth(config, storedKey)),
	};
	for (const [key, value] of Object.entries(config.headers ?? {})) {
		headers[key] = value;
	}
	return headers;
}

/**
 * Fetch and parse the provider's model list.
 *
 * Throws on any failure — a non-2xx response, an unparseable payload, or a
 * timeout — which is what tells `createProvider` to retain the previous catalog.
 *
 * `storedKey` is Pi's resolved credential for this provider, when the caller has
 * one. Passing it is what makes discovery work for a user who authenticated with
 * `/login` instead of exporting an environment variable.
 */
export async function fetchProviderModels(
	config: CustomProviderConfig,
	signal: AbortSignal,
	storedKey?: string,
): Promise<ParsedModel[]> {
	if (!config.discovery) return [];

	const timeoutMs = config.discovery.timeoutMs ?? 15_000;
	const timeout = AbortSignal.timeout(timeoutMs);
	// `AbortSignal.any` is what makes cancellation and the provider-specific
	// bound work together: either one aborts the request.
	const combined = AbortSignal.any([signal, timeout]);
	const url = resolveDiscoveryUrl(config);

	let response: Response;
	try {
		response = await fetch(url, { headers: buildDiscoveryHeaders(config, storedKey), signal: combined });
	} catch (error) {
		if (timeout.aborted) throw new Error(`Model discovery timed out after ${timeoutMs}ms (${url})`);
		throw new Error(`Model discovery failed for ${url}: ${(error as Error).message}`);
	}

	if (!response.ok) {
		throw new Error(`Model discovery failed: HTTP ${response.status} ${response.statusText} (${url})`.trim());
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new Error(`Model discovery returned invalid JSON from ${url}: ${(error as Error).message}`);
	}

	const parsed = parseModels(config.discovery.parser, payload);
	if (parsed.error) {
		throw new Error(`Model discovery: ${parsed.error} (parser "${config.discovery.parser}", ${url})`);
	}
	if (parsed.models.length === 0) {
		throw new Error(`Model discovery found no models at ${url} (parser "${config.discovery.parser}")`);
	}

	return dedupeModels(parsed.models);
}

/** The discovery auth header shape for an API, for diagnostics. */
export function discoveryAuthDescription(api: SupportedApi): string {
	switch (api) {
		case "anthropic-messages":
			return "x-api-key header";
		case "google-generative-ai":
			return "x-goog-api-key header";
		default:
			return "Authorization: Bearer";
	}
}
