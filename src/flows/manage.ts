/**
 * `/custom-provider delete | refresh | test`.
 *
 * `delete` is the one operation that must actively tell Pi to drop a provider —
 * Pi merges re-registrations, so leaving a provider unregistered in the file
 * would otherwise keep it selectable for the rest of the session (§19, §20).
 *
 * `refresh` goes through Pi's public model-registry refresh path so the dynamic
 * catalog is fetched, validated, and persisted by Pi (§12).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadProviders, saveProviders } from "../core/store.ts";
import { fetchProviderModels, buildDiscoveryHeaders, resolveDiscoveryUrl, discoveryAuthDescription } from "../core/discovery.ts";
import { resolveModels } from "../core/resolve.ts";
import { apiLabel, defaultDiscoveryEndpoint } from "../ui/labels.ts";
import { shortTokens, table, thinkingSummary } from "../ui/table.ts";
import { showReport } from "../ui/report.ts";
import type { RegisteredProvider } from "../core/register.ts";

export async function removeProviderFlow(
	ctx: ExtensionContext,
	registered: RegisteredProvider[],
	id: string,
	after: () => Promise<void>,
): Promise<void> {
	const { providers, error } = await loadProviders();
	if (error) {
		ctx.ui.notify(error, "error");
		return;
	}
	const provider = providers.find((entry) => entry.id === id);
	if (!provider) {
		ctx.ui.notify(`No provider named "${id}".`, "warning");
		return;
	}

	const ok = await ctx.ui.confirm(
		`Delete "${provider.id}"?`,
		[
			`${provider.name} — ${apiLabel(provider.api)}`,
			provider.baseUrl,
			"",
			"This removes the local configuration and unregisters the provider from Pi.",
			"The server itself is untouched.",
		].join("\n"),
	);
	if (!ok) return;

	await saveProviders(providers.filter((entry) => entry.id !== provider.id));
	// The reload unregisters it: syncProviders diffs the new id set against the
	// set registered last time and calls pi.unregisterProvider for the difference.
	await after();
	ctx.ui.notify(`Deleted ${provider.id}.`, "info");
}

/**
 * Refresh one provider's model list through Pi.
 *
 * Pi's refresh validates the new catalog before publishing it and keeps the
 * previous one on failure, so this reports what Pi decided rather than managing
 * any catalog state itself (§12, §22).
 */
export async function refreshProviderFlow(
	ctx: ExtensionContext,
	registered: RegisteredProvider[],
	id: string,
): Promise<void> {
	const entry = registered.find((provider) => provider.config.id === id);
	if (!entry) {
		ctx.ui.notify(`No provider named "${id}". Run /custom-provider to see configured providers.`, "warning");
		return;
	}
	if (!entry.config.discovery) {
		ctx.ui.notify(
			`"${id}" has no discovery endpoint — it is manual-models only. Edit it to add one.`,
			"info",
		);
		return;
	}

	ctx.ui.setWorkingMessage(`Refreshing ${id}…`);
	try {
		const result = await ctx.modelRegistry.refresh({
			providers: [id],
			force: true,
			signal: AbortSignal.timeout((entry.config.discovery.timeoutMs ?? 15_000) + 5_000),
		});

		const failure = result.errors.get(id);
		if (failure) {
			ctx.ui.notify(
				`Refresh failed for ${id}: ${failure.message}\nThe previous model list is still in place.`,
				"error",
			);
			return;
		}
		if (result.aborted) {
			ctx.ui.notify(`Refresh of ${id} was cancelled. The previous model list is still in place.`, "warning");
			return;
		}

		const models = ctx.modelRegistry.getAll().filter((model) => model.provider === id);
		const discovered = models.filter((model) => !entry.models.some((manual) => manual.id === model.id));
		ctx.ui.notify(
			`Refreshed ${id} · ${discovered.length} discovered, ${entry.models.length} manual.`,
			"info",
		);
	} catch (error) {
		ctx.ui.notify(`Refresh failed for ${id}: ${(error as Error).message}`, "error");
	} finally {
		ctx.ui.setWorkingMessage();
	}
}

/**
 * Probe one provider's discovery endpoint and explain what came back.
 *
 * This is the diagnostic for "my models did not appear": it reports the URL, the
 * auth header used, the parser, and each stage's outcome, without going through
 * Pi's provider machinery.
 */
export async function testProviderFlow(
	ctx: ExtensionContext,
	registered: RegisteredProvider[],
	id: string,
): Promise<void> {
	const entry = registered.find((provider) => provider.config.id === id);
	if (!entry) {
		ctx.ui.notify(`No provider named "${id}". Run /custom-provider to see configured providers.`, "warning");
		return;
	}
	const config = entry.config;

	const lines: string[] = [
		`${config.id} — ${config.name}`,
		`API: ${apiLabel(config.api)}`,
		`Base URL: ${config.baseUrl}`,
		`Credential: ${config.auth?.env ? `Pi store, else env ${config.auth.env}` : "Pi credential store"}`,
		"",
		`Manual models: ${entry.models.length}`,
		...(entry.models.length > 0
			? table(
					[
						{ header: "MODEL", size: 34, fitContent: true },
						{ header: "CTX", size: 8, fixed: true, align: "right" },
						{ header: "OUT", size: 8, fixed: true, align: "right" },
						{ header: "THINKING", size: 22, dropPriority: 1 },
					],
					entry.models.map((model) => [
						model.id,
						shortTokens(model.contextWindow),
						shortTokens(model.maxTokens),
						thinkingSummary(model.reasoning, model.thinkingLevelMap as Record<string, string | null> | undefined),
					]),
				)
			: []),
	];

	if (!config.discovery) {
		lines.push("", "No discovery endpoint configured — this provider is manual-models only.");
		await showReport(ctx, `Provider: ${config.id}`, lines);
		return;
	}

	const url = resolveDiscoveryUrl(config);
	lines.push(
		"",
		"Discovery",
		`  Endpoint: ${config.discovery.endpoint}`,
		`  URL: ${url}`,
		`  Parser: ${config.discovery.parser}`,
		`  Auth: ${discoveryAuthDescription(config.api)}`,
		`  Timeout: ${config.discovery.timeoutMs ?? 15_000}ms`,
	);

	const headers = buildDiscoveryHeaders(config);
	const headerNames = Object.keys(headers).filter((name) => !["accept"].includes(name.toLowerCase()));
	lines.push(`  Headers: ${headerNames.join(", ") || "(none)"}`);

	ctx.ui.setWorkingMessage(`Probing ${config.id}…`);
	try {
		const discovered = await fetchProviderModels(config, AbortSignal.timeout(config.discovery.timeoutMs ?? 15_000));
		const resolved = resolveModels(discovered, config);

		lines.push("", `Discovery succeeded: ${discovered.length} model${discovered.length === 1 ? "" : "s"}.`, "");
		lines.push(
			...table(
				[
					{ header: "MODEL", size: 34, fitContent: true },
					{ header: "NAME", size: 24, dropPriority: 3 },
					{ header: "CTX", size: 8, fixed: true, align: "right" },
					{ header: "OUT", size: 8, fixed: true, align: "right" },
					{ header: "THINKING", size: 20, dropPriority: 1 },
				],
				resolved.slice(0, 40).map((model) => [
					model.id,
					model.name,
					shortTokens(model.contextWindow),
					shortTokens(model.maxTokens),
					thinkingSummary(model.reasoning, model.thinkingLevelMap as Record<string, string | null> | undefined),
				]),
			),
		);
		if (resolved.length > 40) lines.push(`+ ${resolved.length - 40} more models`);

		const fromCatalog = resolved.filter((model) => model.name !== model.id).length;
		lines.push(
			"",
			`${resolved.length} models resolve to Pi models. ${fromCatalog} inherit a display name from Pi's own catalog.`,
			`${entry.models.length} manual model(s) are registered in addition.`,
		);
	} catch (error) {
		lines.push("", `Discovery failed: ${(error as Error).message}`, "");
		lines.push(
			"Pi keeps the previously restored model list when a refresh fails, so this provider",
			"stays usable with its last known catalog.",
			"",
			"Checks:",
			`  - Is ${url} the right path? The default for this API is ${defaultDiscoveryEndpoint(config.api)}.`,
			`  - Does the endpoint expect ${discoveryAuthDescription(config.api)}? A chat endpoint that works can still reject the model list.`,
			`  - Does the payload match the "${config.discovery.parser}" parser? Try another parser, or add manual models instead.`,
		);
	} finally {
		ctx.ui.setWorkingMessage();
	}

	await showReport(ctx, `Provider: ${config.id}`, lines);
}
