/**
 * Shared display names.
 *
 * Centralised so the same state is never described two different ways — the menu,
 * the status table, and the `test` report all name the four APIs identically.
 */

import type { SupportedApi, ModelParser } from "../core/types.ts";

const API_LABELS: Record<SupportedApi, string> = {
	"openai-completions": "OpenAI Chat Completions",
	"openai-responses": "OpenAI Responses",
	"anthropic-messages": "Anthropic Messages",
	"google-generative-ai": "Google Gemini",
};

/** The user-facing name of an API type. */
export function apiLabel(api: SupportedApi): string {
	return API_LABELS[api] ?? api;
}

/** The menu entry for an API, in the order the spec lists them. */
export function apiChoices(): { label: string; value: SupportedApi }[] {
	return (Object.keys(API_LABELS) as SupportedApi[]).map((api) => ({ label: API_LABELS[api], value: api }));
}

/** Parse an api choice label back to its value. */
export function apiFromLabel(label: string): SupportedApi | undefined {
	const entry = (Object.entries(API_LABELS) as [SupportedApi, string][]).find(([, value]) => value === label);
	return entry?.[0];
}

const PARSER_LABELS: Record<ModelParser, string> = {
	openai: "OpenAI  ({ \"data\": [ { \"id\": … } ] })",
	anthropic: "Anthropic  ({ \"data\": [ { \"id\": …, \"display_name\": … } ] })",
	gemini: "Gemini  ({ \"models\": [ { \"name\": \"models/…\" } ] })",
};

export function parserChoices(): { label: string; value: ModelParser }[] {
	return (Object.keys(PARSER_LABELS) as ModelParser[]).map((parser) => ({
		label: PARSER_LABELS[parser],
		value: parser,
	}));
}

export function parserFromLabel(label: string): ModelParser | undefined {
	const entry = (Object.entries(PARSER_LABELS) as [ModelParser, string][]).find(([, value]) => value === label);
	return entry?.[0];
}

/** The default discovery endpoint for an API, offered as a placeholder. */
export function defaultDiscoveryEndpoint(api: SupportedApi): string {
	switch (api) {
		case "anthropic-messages":
			return "/v1/models";
		case "google-generative-ai":
			return "/v1beta/models";
		default:
			return "/v1/models";
	}
}
