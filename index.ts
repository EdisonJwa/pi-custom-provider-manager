/**
 * Custom Provider Manager — configure and discover custom LLM providers.
 *
 * The extension is a **provider configuration and model-discovery layer**: it
 * describes providers in `~/.pi/agent/custom-providers.json`, compiles them into
 * native Pi providers, and lets Pi run them. It does not reimplement Pi's LLM
 * runtime, message normalization, streaming, tool calling, usage accounting,
 * retry behavior, or context management.
 *
 * Startup performs local work only — read the configuration, build providers,
 * register them. Model discovery happens through `fetchModels`, which Pi drives
 * from its own persisted catalog, so a slow or unreachable provider never delays
 * initialization.
 *
 * Commands:
 *   /custom-provider              list configured providers
 *   /custom-provider add          guided setup for a new provider
 *   /custom-provider edit         change an existing provider
 *   /custom-provider refresh      re-fetch one provider's model list
 *   /custom-provider delete       remove a provider
 *   /custom-provider test         probe discovery and explain the result
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadProviders, type LoadResult } from "./src/core/store.ts";
import { syncProviders, trackedIds, type RegisteredProvider, type SyncResult } from "./src/core/register.ts";
import { addProviderFlow, editProviderFlow } from "./src/flows/add.ts";
import { removeProviderFlow, refreshProviderFlow, testProviderFlow } from "./src/flows/manage.ts";
import { shortTokens, table, thinkingSummary } from "./src/ui/table.ts";
import { showReport } from "./src/ui/report.ts";
import { apiLabel } from "./src/ui/labels.ts";

const STATUS_KEY = "custom-providers";

export default async function customProviderManager(pi: ExtensionAPI): Promise<void> {
	// The only await in the factory is the local config read. No provider is
	// contacted here.
	let loadResult: LoadResult = { providers: [], problems: [] };
	try {
		loadResult = await loadProviders();
	} catch (error) {
		loadResult = { providers: [], problems: [], error: `failed to load providers: ${(error as Error).message}` };
	}

	let result: SyncResult = syncProviders(pi, loadResult, new Set());
	let tracked = trackedIds(result);
	let registered: RegisteredProvider[] = result.providers;
	// Tracked separately from `loadResult`, which is only the startup read: after
	// a reload this must reflect the file as it is now, or a fixed JSON error
	// would keep being reported for the rest of the session.
	let loadError = loadResult.error;

	const problems = [...result.problems];
	if (loadResult.error) problems.unshift(loadResult.error);
	const failed = registered.filter((provider) => provider.error);

	// Deferred: the extension factory can run before any UI exists.
	if (problems.length > 0 || failed.length > 0) {
		pi.on("session_start", (_event, ctx) => {
			for (const problem of problems) ctx.ui.notify(`custom-providers: ${problem}`, "error");
		});
	}

	// Endpoint health belongs in the footer, not the transcript. Missing
	// credentials are persistent state, not an event.
	pi.on("session_start", (_event, ctx) => {
		updateStatus(ctx, registered);
	});

	/** Re-read the configuration and apply it, without touching the network. */
	const reload = async (ctx: ExtensionContext): Promise<SyncResult> => {
		const loaded = await loadProviders();
		const next = syncProviders(pi, loaded, tracked);
		tracked = trackedIds(next);
		registered = next.providers;
		loadError = loaded.error;
		updateStatus(ctx, registered);
		return next;
	};

	pi.registerCommand("custom-provider", {
		description: "Manage custom LLM providers",
		handler: async (args, ctx) => {
			const [action, ...rest] = (args ?? "").trim().split(/\s+/);
			switch ((action ?? "").toLowerCase()) {
				case "":
				case "list":
				case "status":
					await showStatus(ctx, registered, loadError);
					return;
				case "add":
					await addProviderFlow(ctx, async () => {
						await reload(ctx);
					});
					return;
				case "edit": {
					const target = rest[0] ?? (await pickProvider(ctx, registered, "Edit which provider?"));
					if (!target) return;
					await editProviderFlow(ctx, registered, target, async () => {
						await reload(ctx);
					});
					return;
				}
				case "remove":
				case "rm":
				case "delete": {
					const target = rest[0] ?? (await pickProvider(ctx, registered, "Delete which provider?"));
					if (!target) return;
					await removeProviderFlow(ctx, registered, target, async () => {
						await reload(ctx);
					});
					return;
				}
				case "refresh":
				case "reload": {
					const target = rest[0] ?? (await pickProvider(ctx, registered, "Refresh which provider?"));
					if (!target) return;
					await refreshProviderFlow(ctx, registered, target);
					return;
				}
				case "test": {
					const target = rest[0] ?? (await pickProvider(ctx, registered, "Test which provider?"));
					if (!target) return;
					await testProviderFlow(ctx, registered, target);
					return;
				}
				default:
					ctx.ui.notify(
						`Unknown /custom-provider action "${action}". Try add, edit, delete, refresh, or test.`,
						"warning",
					);
			}
		},
	});

	pi.registerTool({
		name: "custom_provider_status",
		label: "Custom provider status",
		description:
			"List the custom LLM providers configured in this Pi install, including API type, base URL, discovery endpoint, credential source, and the models currently available. Use when the user asks which custom providers or models are configured.",
		parameters: Type.Object({
			provider: Type.Optional(Type.String({ description: "Only report this provider id." })),
		}),
		async execute(_toolCallId, params) {
			const targets = params.provider
				? registered.filter((entry) => entry.config.id === params.provider)
				: registered;
			if (targets.length === 0) {
				return { content: [{ type: "text" as const, text: "No custom providers configured." }], details: {} };
			}
			const lines: string[] = [];
			for (const entry of targets) {
				const { config } = entry;
				lines.push(`${config.id} — ${config.name}`);
				lines.push(`  api: ${config.api}`);
				lines.push(`  baseUrl: ${config.baseUrl}`);
				lines.push(
					`  discovery: ${config.discovery ? `${config.discovery.endpoint} (${config.discovery.parser})` : "none"}`,
				);
				lines.push(`  credential: ${credentialLabel(config.auth?.env)}`);
				lines.push(
					`  manual models (${entry.models.length}): ${entry.models.map((model) => model.id).join(", ") || "none"}`,
				);
				if (entry.error) lines.push(`  error: ${entry.error}`);
			}
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: {} };
		},
	});
}

/** The persistent footer chip: provider count, plus how many need credentials. */
function updateStatus(ctx: ExtensionContext, registered: RegisteredProvider[]): void {
	if (registered.length === 0) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const broken = registered.filter((provider) => provider.error).length;
	const count = `${registered.length} provider${registered.length === 1 ? "" : "s"}`;
	ctx.ui.setStatus(STATUS_KEY, broken > 0 ? `${count} · ${broken} failed` : count);
}

/** Describe a credential without revealing it. */
function credentialLabel(env: string | undefined): string {
	if (!env) return "Pi credential store only (no env fallback)";
	return process.env[env] ? `Pi store, else env ${env}` : `Pi store; env ${env} is not set`;
}

async function pickProvider(
	ctx: ExtensionContext,
	registered: RegisteredProvider[],
	title: string,
): Promise<string | undefined> {
	if (registered.length === 0) {
		ctx.ui.notify("No custom providers configured. Run /custom-provider add to set one up.", "info");
		return undefined;
	}
	if (registered.length === 1) return registered[0].config.id;
	return ctx.ui.select(title, registered.map((entry) => entry.config.id));
}

async function showStatus(
	ctx: ExtensionContext,
	registered: RegisteredProvider[],
	loadError: string | undefined,
): Promise<void> {
	if (loadError) {
		ctx.ui.notify(loadError, "error");
		return;
	}
	if (registered.length === 0) {
		ctx.ui.notify(
			"No custom providers. Run /custom-provider add to set one up, or edit ~/.pi/agent/custom-providers.json.",
			"info",
		);
		return;
	}

	const rows = registered.map((entry) => {
		const { config } = entry;
		const targets = entry.models.map((model) => model.id).join(", ");
		return [
			config.id,
			apiLabel(config.api),
			entry.config.discovery ? entry.config.discovery.parser : "manual",
			String(entry.models.length),
			config.baseUrl,
		];
	});

	const lines = table(
		[
			{ header: "PROVIDER", size: 16, fitContent: true },
			{ header: "API", size: 20 },
			{ header: "PARSER", size: 8 },
			{ header: "MANUAL", size: 7, align: "right" },
			{ header: "BASE URL", size: 30, dropPriority: 1 },
		],
		rows,
	);

	const problems = registered.flatMap((entry) => (entry.error ? [`${entry.config.id}: ${entry.error}`] : []));
	const detail = registered.flatMap((entry) => {
		const out: string[] = [];
		if (entry.config.discovery) {
			out.push(`${entry.config.id}: discovers from ${entry.config.discovery.endpoint} (${entry.config.discovery.parser})`);
		}
		if (entry.config.auth?.env && !process.env[entry.config.auth.env]) {
			out.push(`${entry.config.id}: env ${entry.config.auth.env} is not set`);
		}
		return out;
	});

	const footer = [
		"",
		"Manual models are listed above. Discovered models are restored by Pi from its own",
		"model store and refreshed in the background — run /custom-provider refresh to fetch now.",
		"",
		"/custom-provider add · edit · delete · refresh · test",
	];
	await showReport(ctx, `Custom providers (${registered.length})`, formatStatus(lines, problems, detail, footer));
}

function formatStatus(lines: string[], problems: string[], detail: string[], footer: string[]): string[] {
	const out = [...lines];
	if (problems.length > 0) {
		out.push("", "Needs attention:");
		for (const problem of problems) out.push(`  - ${problem}`);
	}
	if (detail.length > 0) {
		out.push("", "Details:");
		for (const note of detail) out.push(`  - ${note}`);
	}
	out.push(...footer);
	return out;
}

export { shortTokens, thinkingSummary };
