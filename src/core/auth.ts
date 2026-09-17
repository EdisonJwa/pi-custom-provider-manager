/**
 * Provider authentication.
 *
 * Credentials resolve from Pi's own store first and an optional configured
 * environment variable second (§7). The extension introduces no secret store of
 * its own, and the request-side format is left entirely to the Pi API
 * implementation — this module only assembles the header a *discovery* request
 * needs, because that call is made outside Pi.
 *
 * The precedence matters for the common case: a user who has run `/login` for a
 * provider expects that credential to win over a stale exported variable.
 */

import type { ApiKeyAuth, ApiKeyCredential, ProviderAuth, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import type { CustomProviderConfig, SupportedApi } from "./types.ts";

/** Where a credential came from, for status output. */
export type AuthSource = string | undefined;

export interface ResolvedAuth {
	apiKey?: string;
	/** Human-readable origin, or a description of what is missing. */
	source: AuthSource;
	configured: boolean;
}

/** The environment variable to consult, if the provider declared one. */
export function envVarFor(config: CustomProviderConfig): string | undefined {
	return config.auth?.env;
}

/**
 * Resolve the credential for a discovery request.
 *
 * `storedKey` is the credential Pi resolved for this provider, passed down from
 * `RefreshModelsContext.credential`. It is preferred over the environment: a
 * user who authenticated with `/login` and configured no `env` would otherwise
 * send an unauthenticated model-list request and see a 401 while chat worked
 * fine — the failure this ordering exists to prevent.
 *
 * The environment is only the fallback, for the case where discovery runs
 * outside a Pi refresh (the `test` command) or Pi has no credential stored.
 */
export function resolveEndpointAuth(config: CustomProviderConfig, storedKey?: string): ResolvedAuth {
	if (storedKey && storedKey.length > 0) {
		return { apiKey: storedKey, source: "Pi credential store", configured: true };
	}

	const name = envVarFor(config);
	if (!name) {
		return { source: "no credential configured", configured: false };
	}
	const value = process.env[name];
	if (value && value.length > 0) {
		return { apiKey: value, source: `env ${name}`, configured: true };
	}
	return { source: `env ${name} is not set`, configured: false };
}

/**
 * The authentication header a discovery request should carry, per API (§11).
 *
 * Each of the four APIs authenticates differently, and sending the wrong header
 * is the most common reason a model list comes back 401 even though chat works.
 */
export function authHeadersFor(api: SupportedApi, auth: ResolvedAuth): Record<string, string> {
	if (!auth.apiKey) return {};
	switch (api) {
		case "anthropic-messages":
			return { "x-api-key": auth.apiKey, "anthropic-version": "2023-06-01" };
		case "google-generative-ai":
			return { "x-goog-api-key": auth.apiKey };
		default:
			// OpenAI Chat Completions and OpenAI Responses.
			return { authorization: `Bearer ${auth.apiKey}` };
	}
}

/**
 * Build Pi's `apiKey` auth provider for a configured provider.
 *
 * `login` lets Pi's normal authentication flow prompt for and store the key, so
 * `/login <id>` works for a custom provider exactly as it does for a built-in
 * one. `resolve` prefers that stored credential and falls back to the configured
 * environment variable.
 */
export function createApiKeyAuth(config: CustomProviderConfig): ApiKeyAuth {
	const envName = envVarFor(config);
	return {
		name: `${config.name} API key`,

		async login(interaction: ProviderAuthInteraction): Promise<ApiKeyCredential> {
			const message = envName
				? `${config.name} API key (env ${envName} is used as a fallback)`
				: `${config.name} API key`;
			const key = await interaction.prompt({ type: "secret", message });
			return { type: "api_key", key };
		},

		/**
		 * Resolve without side effects, so status output and model filtering do
		 * not depend on the environment being readable at that moment.
		 */
		async check({ credential }): Promise<{ type: "api_key"; source?: string } | undefined> {
			const stored = credential?.type === "api_key" ? credential.key : undefined;
			if (stored) return { type: "api_key", source: "stored API key" };
			if (envName && process.env[envName]) return { type: "api_key", source: envName };
			return undefined;
		},

		async resolve({ credential, ctx }) {
			const stored = credential?.type === "api_key" ? credential.key : undefined;
			if (stored) {
				return { auth: { apiKey: stored }, source: "stored API key" };
			}

			if (envName) {
				// Read through the auth context when one is available so a
				// provider-scoped environment still resolves, then fall back to the
				// process environment.
				let value: string | undefined;
				try {
					value = await ctx.env(envName);
				} catch {
					value = undefined;
				}
				value ??= process.env[envName];
				if (value && value.length > 0) {
					return { auth: { apiKey: value }, source: envName };
				}
			}

			return undefined;
		},
	};
}

/** Pi's `ProviderAuth` for a configured provider. */
export function createProviderAuth(config: CustomProviderConfig): ProviderAuth {
	return { apiKey: createApiKeyAuth(config) };
}
