/**
 * Registering configured providers with Pi.
 *
 * Nothing here performs remote I/O, which is the design's hard rule (§2.2, §26).
 * A provider that is offline, slow, or unreachable cannot delay extension
 * initialization, because nothing here talks to it.
 *
 * Removal goes through `pi.unregisterProvider()` so Pi drops the provider's
 * models, auth fallback, and stream handler; the extension keeps no runtime
 * provider state of its own (§20).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildProvider, staticModels } from "./provider.ts";
import type { LoadResult } from "./store.ts";
import type { Model } from "@earendil-works/pi-ai";
import type { CustomProviderConfig, SupportedApi } from "./types.ts";

export interface RegisteredProvider {
	config: CustomProviderConfig;
	/** Models available with no network access — the manual baseline. */
	models: Model<SupportedApi>[];
	/** Set when registration threw. */
	error?: string;
}

export interface SyncResult {
	providers: RegisteredProvider[];
	/** A problem with the file as a whole. */
	error?: string;
	/** Per-entry problems, including entries that were skipped. */
	problems: string[];
	/** Provider ids unregistered because they are no longer configured. */
	removed: string[];
}

/**
 * Apply a loaded configuration to Pi.
 *
 * `previouslyRegistered` is the set of ids this extension registered last time.
 * Any id missing from the new configuration is unregistered: Pi merges a
 * re-registration over the previous one, so simply not registering a provider
 * again would leave its old registration live for the rest of the session.
 *
 * Never throws — a provider that fails to register is reported and skipped.
 */
export function syncProviders(
	pi: ExtensionAPI,
	loaded: LoadResult,
	previouslyRegistered: ReadonlySet<string>,
): SyncResult {
	const providers: RegisteredProvider[] = [];
	const removed: string[] = [];
	const problems = [...loaded.problems];

	const configured = new Set(loaded.providers.map((provider) => provider.id));

	for (const id of previouslyRegistered) {
		if (configured.has(id)) continue;
		try {
			pi.unregisterProvider(id);
			removed.push(id);
		} catch (error) {
			problems.push(`${id}: failed to unregister — ${(error as Error).message}`);
		}
	}

	for (const config of loaded.providers) {
		const entry: RegisteredProvider = { config, models: staticModels(config) };
		try {
			pi.registerProvider(buildProvider(config));
		} catch (error) {
			entry.error = (error as Error).message;
			problems.push(`${config.id}: registration failed — ${entry.error}`);
		}
		providers.push(entry);
	}

	return { providers, problems, removed, error: loaded.error };
}

/**
 * The ids to diff the next sync against.
 *
 * Every configured provider is included, including one whose registration threw.
 * Pi validates a re-registration *before* storing it, so a failure leaves the
 * previous registration live — meaning an id that errored may still be
 * registered, and dropping it here would make a later delete fail to unregister
 * it. Including a first-time failure is harmless: `unregisterProvider` has no
 * effect on a provider that was never registered.
 */
export function trackedIds(result: SyncResult): Set<string> {
	return new Set(result.providers.map((provider) => provider.config.id));
}
