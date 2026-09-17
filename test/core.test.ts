/**
 * Tests for extension-owned behavior (§24).
 *
 * These cover the parts this extension actually implements: configuration
 * parsing and validation, the three model-list parsers, model resolution and the
 * merge rules, thinking/compat passthrough, and provider construction. Pi's own
 * provider test suite covers streaming and tool calling, which this extension
 * does not implement and therefore does not duplicate.
 *
 * Run: node --test --experimental-strip-types test/
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeProvider } from "../src/core/store.ts";
import { parseModels, dedupeModels } from "../src/core/parsers/index.ts";
import { resolveModels, compileManualModels } from "../src/core/resolve.ts";
import { buildProvider } from "../src/core/provider.ts";
import { buildDiscoveryHeaders, resolveDiscoveryUrl } from "../src/core/discovery.ts";
import { createApiKeyAuth } from "../src/core/auth.ts";
import { syncProviders } from "../src/core/register.ts";
import { apiLabel, apiFromLabel, parserFromLabel, parserChoices, apiChoices } from "../src/ui/labels.ts";

// ---------------------------------------------------------------- fixtures

const DEFAULT_MODELS = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
] as const;

function defaults(overrides = {}) {
	return { reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8_192, ...overrides };
}

function provider(overrides = {}) {
	return {
		id: "p",
		name: "P",
		api: "openai-completions",
		baseUrl: "https://api.example.com/v1",
		auth: {},
		modelDefaults: defaults(),
		...overrides,
	};
}

/** Resolve one id through a provider config, for terse assertions. */
function resolve(ids, overrides = {}) {
	return resolveModels(
		ids.map((id) => (typeof id === "string" ? { id } : id)),
		provider(overrides),
	);
}

// ------------------------------------------------- §23 configuration parsing

test("configuration: a valid provider parses", () => {
	const problems = [];
	const parsed = normalizeProvider(provider(), problems);
	assert.equal(problems.length, 0);
	assert.equal(parsed.id, "p");
	assert.equal(parsed.api, "openai-completions");
	assert.deepEqual(parsed.modelDefaults, defaults());
});

test("configuration: every supported API is accepted", () => {
	for (const api of DEFAULT_MODELS) {
		const problems = [];
		const parsed = normalizeProvider(provider({ api }), problems);
		assert.equal(parsed?.api, api, `${api} should parse`);
		assert.equal(problems.length, 0);
	}
});

test("configuration: an unsupported API is reported, not silently dropped", () => {
	const problems = [];
	const parsed = normalizeProvider(provider({ api: "google-vertex" }), problems);
	assert.equal(parsed, undefined);
	assert.match(problems.join("; "), /api must be one of/);
});

test("configuration: missing required fields are all reported at once", () => {
	const problems = [];
	const parsed = normalizeProvider({ id: "", name: "", baseUrl: "", api: "nope" }, problems);
	assert.equal(parsed, undefined);
	assert.equal(problems.length, 4);
});

test("configuration: an invalid base URL is rejected", () => {
	const problems = [];
	const parsed = normalizeProvider(provider({ baseUrl: "not a url" }), problems);
	assert.equal(parsed, undefined);
	assert.match(problems.join("; "), /not a valid URL/);
});

test("configuration: non-positive contextWindow and maxTokens are rejected", () => {
	const problems = [];
	normalizeProvider(provider({ modelDefaults: defaults({ contextWindow: 0, maxTokens: -1 }) }), problems);
	assert.match(problems.join("; "), /contextWindow must be > 0/);
	assert.match(problems.join("; "), /maxTokens must be > 0/);
});

test("configuration: discovery requires both endpoint and parser", () => {
	const problems = [];
	normalizeProvider(provider({ discovery: { endpoint: "", parser: "bogus" } }), problems);
	assert.match(problems.join("; "), /discovery.endpoint is required/);
	assert.match(problems.join("; "), /discovery.parser must be one of/);
});

test("configuration: duplicate manual model ids are rejected", () => {
	const problems = [];
	normalizeProvider(provider({ manualModels: [{ id: "a" }, { id: "a" }] }), problems);
	assert.match(problems.join("; "), /duplicate id "a"/);
});

test("configuration: an invalid thinking level key is reported (§23)", () => {
	const problems = [];
	normalizeProvider(provider({ manualModels: [{ id: "m", thinkingLevelMap: { hight: "high" } }] }), problems);
	assert.match(problems.join("; "), /unknown level "hight"/);
});

test("configuration: an absent thinkingLevelMap is not a problem", () => {
	const problems = [];
	normalizeProvider(provider({ manualModels: [{ id: "m" }] }), problems);
	assert.equal(problems.length, 0);
});

// ------------------------------------------------------- §10 model parsers

test("openai parser: reads data[].id", () => {
	const result = parseModels("openai", { data: [{ id: "model-a" }] });
	assert.deepEqual(result.models, [{ id: "model-a" }]);
});

test("openai parser: accepts a bare array", () => {
	assert.deepEqual(parseModels("openai", [{ id: "a" }]).models, [{ id: "a" }]);
});

test("openai parser: keeps a display name distinct from the id", () => {
	assert.deepEqual(parseModels("openai", { data: [{ id: "a", name: "A Model" }] }).models, [
		{ id: "a", name: "A Model" },
	]);
});

test("openai parser: rejects a payload that is not a model list", () => {
	assert.ok(parseModels("openai", { models: [] }).error);
});

test("anthropic parser: prefers display_name", () => {
	assert.deepEqual(parseModels("anthropic", { data: [{ id: "claude-x", display_name: "Claude X" }] }).models, [
		{ id: "claude-x", name: "Claude X" },
	]);
});

test("gemini parser: strips the models/ resource prefix (§10.3)", () => {
	assert.deepEqual(parseModels("gemini", { models: [{ name: "models/gemini-3-pro" }] }).models, [
		{ id: "gemini-3-pro" },
	]);
});

test("gemini parser: leaves an unprefixed name alone", () => {
	assert.deepEqual(parseModels("gemini", { models: [{ name: "gemini-3-pro" }] }).models, [{ id: "gemini-3-pro" }]);
});

test("gemini parser: reads displayName", () => {
	assert.deepEqual(parseModels("gemini", { models: [{ name: "models/x", displayName: "X" }] }).models, [
		{ id: "x", name: "X" },
	]);
});

test("dedupe: keeps first-seen order and the richer name", () => {
	assert.deepEqual(dedupeModels([{ id: "a" }, { id: "a", name: "A" }, { id: "b" }]), [
		{ id: "a", name: "A" },
		{ id: "b" },
	]);
});

// ------------------------------------------- §13–§16 model resolution rules

test("defaults apply to a model the catalog does not know (§14)", () => {
	const [resolved] = resolve(["totally-unknown-model"], {
		modelDefaults: defaults({ contextWindow: 4242, maxTokens: 424 }),
	});
	assert.equal(resolved.contextWindow, 4242);
	assert.equal(resolved.maxTokens, 424);
	assert.equal(resolved.reasoning, false);
});

test("a per-model override beats the defaults (§16)", () => {
	const [resolved] = resolve(["m"], { modelOverrides: { m: { contextWindow: 99, reasoning: true, name: "Custom" } } });
	assert.equal(resolved.contextWindow, 99);
	assert.equal(resolved.reasoning, true);
	assert.equal(resolved.name, "Custom");
});

test("the wildcard override applies before the exact id", () => {
	const resolved = resolve(["a", "b"], { modelOverrides: { "*": { maxTokens: 111 }, b: { maxTokens: 222 } } });
	assert.equal(resolved.find((m) => m.id === "a").maxTokens, 111);
	assert.equal(resolved.find((m) => m.id === "b").maxTokens, 222);
});

test("a manual model wins over a discovered model with the same id (§15)", () => {
	const resolved = resolveModels(
		[{ id: "shared" }],
		provider({ manualModels: [{ id: "shared", name: "Manual", contextWindow: 777 }] }),
	);
	assert.equal(resolved.length, 1);
	assert.equal(resolved[0].name, "Manual");
	assert.equal(resolved[0].contextWindow, 777);
});

test("a manual model supplements discovery with an id it never reported (§15)", () => {
	const resolved = resolveModels([{ id: "discovered" }], provider({ manualModels: [{ id: "manual-only" }] }));
	assert.deepEqual(resolved.map((m) => m.id).sort(), ["discovered", "manual-only"]);
});

test("a partial cost override keeps the other rates", () => {
	const [resolved] = resolve(["m"], {
		modelDefaults: defaults({ cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }),
		modelOverrides: { m: { cost: { output: 9 } } },
	});
	assert.deepEqual(resolved.cost, { input: 1, output: 9, cacheRead: 3, cacheWrite: 4 });
});

test("compileManualModels produces the static baseline (§8)", () => {
	const baseline = compileManualModels(provider({ manualModels: [{ id: "a" }, { id: "b", contextWindow: 999 }] }));
	assert.equal(baseline.length, 2);
	assert.equal(baseline.find((m) => m.id === "b").contextWindow, 999);
});

test("a provider with no manual models has an empty baseline", () => {
	assert.deepEqual(compileManualModels(provider()), []);
});

// --------------------------------------------- §17 thinking and compat

test("thinkingLevelMap passes through unchanged, including nulls (§17.2)", () => {
	const map = { low: "low", medium: "medium", high: "high", xhigh: null, max: "max" };
	const [resolved] = resolve(["m"], { modelOverrides: { m: { reasoning: true, thinkingLevelMap: map } } });
	assert.deepEqual(resolved.thinkingLevelMap, map);
});

test("compat passes through unchanged (§17.3)", () => {
	const compat = { supportsDeveloperRole: false, maxTokensField: "max_tokens", requiresToolResultName: true };
	const [resolved] = resolve(["m"], { modelOverrides: { m: { compat } } });
	assert.deepEqual(resolved.compat, compat);
});

test("a compat override merges onto an inferred one", () => {
	const [resolved] = resolve(["m"], {
		modelOverrides: { "*": { compat: { a: 1 } }, m: { compat: { b: 2 } } },
	});
	assert.deepEqual(resolved.compat, { a: 1, b: 2 });
});

// ------------------------------------------------- §8 provider construction

test("every supported API builds a provider", () => {
	for (const api of DEFAULT_MODELS) {
		const built = buildProvider(provider({ api, manualModels: [{ id: "m" }] }));
		assert.equal(built.id, "p");
		assert.deepEqual(built.getModels().map((m) => m.id), ["m"]);
	}
});

test("a built provider exposes its manual models without any network access (§9)", () => {
	const built = buildProvider(provider({ manualModels: [{ id: "a" }, { id: "b" }] }));
	assert.deepEqual(built.getModels().map((m) => m.id), ["a", "b"]);
});

test("a built provider carries the configured base URL and API", () => {
	const built = buildProvider(provider({ api: "google-generative-ai", manualModels: [{ id: "m" }] }));
	const [model] = built.getModels();
	assert.equal(model.api, "google-generative-ai");
	assert.equal(model.provider, "p");
});

test("a provider without discovery still builds", () => {
	const built = buildProvider(provider({ manualModels: [{ id: "m" }] }));
	assert.equal(built.id, "p");
});

// ------------------------------------------- §11 discovery request shaping

test("a relative discovery endpoint resolves against baseUrl", () => {
	assert.equal(resolveDiscoveryUrl(provider({ discovery: { endpoint: "/models", parser: "openai" } })), "https://api.example.com/v1/models");
});

test("an absolute discovery endpoint is used as-is", () => {
	const url = "https://other.example.com/list";
	assert.equal(resolveDiscoveryUrl(provider({ discovery: { endpoint: url, parser: "openai" } })), url);
});

test("discovery auth follows the selected API (§11)", () => {
	const original = process.env.DISC_TEST_KEY;
	process.env.DISC_TEST_KEY = "secret";
	try {
		const withEnv = (api) => buildDiscoveryHeaders(provider({ api, auth: { env: "DISC_TEST_KEY" } }));

		assert.equal(withEnv("openai-completions").authorization, "Bearer secret");
		assert.equal(withEnv("openai-responses").authorization, "Bearer secret");
		assert.equal(withEnv("anthropic-messages")["x-api-key"], "secret");
		assert.equal(withEnv("anthropic-messages")["anthropic-version"], "2023-06-01");
		assert.equal(withEnv("google-generative-ai")["x-goog-api-key"], "secret");
	} finally {
		if (original === undefined) delete process.env.DISC_TEST_KEY;
		else process.env.DISC_TEST_KEY = original;
	}
});

test("provider headers are merged into the discovery request", () => {
	const headers = buildDiscoveryHeaders(provider({ headers: { "X-Client": "pi" } }));
	assert.equal(headers["X-Client"], "pi");
});

test("a missing env var produces no auth header rather than an empty one", () => {
	const headers = buildDiscoveryHeaders(provider({ auth: { env: "DEFINITELY_UNSET_VAR_XYZ" } }));
	assert.equal(headers.authorization, undefined);
	assert.equal(headers["x-api-key"], undefined);
});

// ------------------------------------------------- §7 provider auth model

test("apiKey auth resolves the configured environment variable", async () => {
	const original = process.env.AUTH_TEST_KEY;
	process.env.AUTH_TEST_KEY = "from-env";
	try {
		const auth = createApiKeyAuth(provider({ auth: { env: "AUTH_TEST_KEY" } }));
		const result = await auth.resolve({ ctx: { env: async (name) => process.env[name], fileExists: async () => false }, signal: AbortSignal.timeout(1000) });
		assert.equal(result.auth.apiKey, "from-env");
		assert.equal(result.source, "AUTH_TEST_KEY");
	} finally {
		if (original === undefined) delete process.env.AUTH_TEST_KEY;
		else process.env.AUTH_TEST_KEY = original;
	}
});

test("a stored credential takes precedence over the environment (§7)", async () => {
	const original = process.env.AUTH_TEST_KEY2;
	process.env.AUTH_TEST_KEY2 = "from-env";
	try {
		const auth = createApiKeyAuth(provider({ auth: { env: "AUTH_TEST_KEY2" } }));
		const result = await auth.resolve({
			credential: { type: "api_key", key: "from-store" },
			ctx: { env: async (name) => process.env[name], fileExists: async () => false },
			signal: AbortSignal.timeout(1000),
		});
		assert.equal(result.auth.apiKey, "from-store");
		assert.equal(result.source, "stored API key");
	} finally {
		if (original === undefined) delete process.env.AUTH_TEST_KEY2;
		else process.env.AUTH_TEST_KEY2 = original;
	}
});

test("unconfigured auth resolves to undefined, which marks the provider unconfigured", async () => {
	const auth = createApiKeyAuth(provider({ auth: { env: "DEFINITELY_UNSET_VAR_XYZ" } }));
	const result = await auth.resolve({
		ctx: { env: async () => undefined, fileExists: async () => false },
		signal: AbortSignal.timeout(1000),
	});
	assert.equal(result, undefined);
});

test("apiKey auth is named after the provider, for /login", () => {
	assert.equal(createApiKeyAuth(provider({ name: "Company Gateway" })).name, "Company Gateway API key");
});

// ------------------------------- §20 / §22 registration and removal behavior

/** A stand-in for ExtensionAPI that records provider lifecycle calls. */
function fakePi() {
	const calls = [];
	return {
		calls,
		registerProvider: (entry) => calls.push(`register:${entry.id}`),
		unregisterProvider: (id) => calls.push(`unregister:${id}`),
	};
}

test("registration adds every configured provider", () => {
	const pi = fakePi();
	const result = syncProviders(pi, { providers: [provider({ id: "a" }), provider({ id: "b" })], problems: [] }, new Set());
	assert.deepEqual(pi.calls, ["register:a", "register:b"]);
	assert.deepEqual(result.providers.map((entry) => entry.config.id), ["a", "b"]);
});

test("a provider removed from the configuration is unregistered (§20)", () => {
	const pi = fakePi();
	const result = syncProviders(pi, { providers: [provider({ id: "b" })], problems: [] }, new Set(["a", "b"]));
	assert.ok(pi.calls.includes("unregister:a"), "a should be unregistered");
	assert.ok(!pi.calls.includes("unregister:b"), "b is still configured");
	assert.deepEqual(result.removed, ["a"]);
});

test("a provider that fails to register is reported, and the rest still register (§22)", () => {
	const pi = fakePi();
	// An unsupported API cannot be built into a provider, but validation already
	// rejects it — so force the failure by handing in an entry that bypasses it.
	const broken = { ...provider({ id: "broken" }) };
	broken.api = undefined;
	const result = syncProviders(pi, { providers: [broken, provider({ id: "ok" })], problems: [] }, new Set());
	assert.equal(result.providers.length, 2);
	assert.ok(result.providers[0].error, "the broken provider should carry an error");
	assert.ok(pi.calls.includes("register:ok"), "the healthy provider should still register");
});

test("configuration problems are carried through to the result", () => {
	const pi = fakePi();
	const result = syncProviders(pi, { providers: [], problems: ["x: bad"] }, new Set());
	assert.deepEqual(result.problems, ["x: bad"]);
});

test("unregistering a provider that is no longer present is not attempted twice", () => {
	const pi = fakePi();
	syncProviders(pi, { providers: [], problems: [] }, new Set(["gone"]));
	syncProviders(pi, { providers: [], problems: [] }, new Set());
	assert.deepEqual(pi.calls, ["unregister:gone"]);
});

// ----------------------------------------------------------- UI labels

test("every API has a distinct user-facing label that round-trips", () => {
	for (const { label, value } of apiChoices()) {
		assert.equal(apiFromLabel(label), value);
	}
	assert.equal(apiChoices().length, 4);
});

test("every parser has a label that round-trips", () => {
	for (const { label, value } of parserChoices()) {
		assert.equal(parserFromLabel(label), value);
	}
	assert.equal(parserChoices().length, 3);
});

test("apiLabel names the four APIs as the spec does", () => {
	assert.equal(apiLabel("openai-completions"), "OpenAI Chat Completions");
	assert.equal(apiLabel("openai-responses"), "OpenAI Responses");
	assert.equal(apiLabel("anthropic-messages"), "Anthropic Messages");
	assert.equal(apiLabel("google-generative-ai"), "Google Gemini");
});
