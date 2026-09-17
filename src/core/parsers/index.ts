/**
 * Model-list parsers.
 *
 * Three parsers, matching the three model-list shapes that matter:
 *
 *   - `openai`    `{ "data": [{ "id": ... }] }` — OpenAI and everything that
 *                 imitates it (LiteLLM, vLLM, LM Studio, most gateways).
 *   - `anthropic` `{ "data": [{ "id", "display_name" }] }`
 *   - `gemini`    `{ "models": [{ "name": "models/<id>" }] }`
 *
 * OpenAI Chat Completions and OpenAI Responses share the `openai` parser, so the
 * extension has four inference APIs but only three parsers.
 *
 * A discovered entry contributes only what the endpoint actually reported. Core
 * shape is required; extra metadata is used when present but never depended on,
 * and everything else comes from the provider's `modelDefaults` and overrides.
 */

import type { ModelParser } from "../types.ts";

/** One model as reported by a model-list endpoint. */
export interface ParsedModel {
	/** The id used for requests. */
	id: string;
	/** Display name, when the endpoint reported one distinct from the id. */
	name?: string;
}

export interface ParseResult {
	models: ParsedModel[];
	/** Set when the payload did not match the parser's expected shape. */
	error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

/**
 * OpenAI-shaped lists: an array of objects under `data`.
 *
 * A bare array is also accepted, since some gateways omit the envelope.
 */
function parseOpenAi(payload: unknown): ParseResult {
	const list = Array.isArray(payload) ? payload : isRecord(payload) && Array.isArray(payload.data) ? payload.data : undefined;
	if (!list) return { models: [], error: "expected an array under \"data\"" };

	const models: ParsedModel[] = [];
	for (const entry of list) {
		if (typeof entry === "string") {
			if (entry.trim()) models.push({ id: entry.trim() });
			continue;
		}
		if (!isRecord(entry)) continue;
		const id = firstString(entry, ["id"]);
		if (!id) continue;
		const name = firstString(entry, ["name", "display_name"]);
		models.push(name && name !== id ? { id, name } : { id });
	}
	return { models };
}

/**
 * Anthropic-shaped lists: `data` entries carrying `id` and `display_name`.
 *
 * The id is what requests use; `display_name` is preferred for the UI when it
 * differs.
 */
function parseAnthropic(payload: unknown): ParseResult {
	const list = Array.isArray(payload) ? payload : isRecord(payload) && Array.isArray(payload.data) ? payload.data : undefined;
	if (!list) return { models: [], error: "expected an array under \"data\"" };

	const models: ParsedModel[] = [];
	for (const entry of list) {
		if (!isRecord(entry)) continue;
		const id = firstString(entry, ["id"]);
		if (!id) continue;
		const name = firstString(entry, ["display_name", "name"]);
		models.push(name && name !== id ? { id, name } : { id });
	}
	return { models };
}

/**
 * Gemini-shaped lists: entries under `models` whose `name` is `models/<id>`.
 *
 * The `models/` prefix is part of the resource name, not the id a request uses,
 * so it is stripped. The remainder — including its own `/` separators for
 * tuned or publisher models — is left intact.
 */
function parseGemini(payload: unknown): ParseResult {
	const list = Array.isArray(payload) ? payload : isRecord(payload) && Array.isArray(payload.models) ? payload.models : undefined;
	if (!list) return { models: [], error: "expected an array under \"models\"" };

	const models: ParsedModel[] = [];
	for (const entry of list) {
		if (typeof entry === "string") {
			const id = stripGeminiPrefix(entry);
			if (id) models.push({ id });
			continue;
		}
		if (!isRecord(entry)) continue;
		const raw = firstString(entry, ["name", "id"]);
		if (!raw) continue;
		const id = stripGeminiPrefix(raw);
		if (!id) continue;
		const name = firstString(entry, ["displayName", "display_name"]);
		models.push(name && name !== id ? { id, name } : { id });
	}
	return { models };
}

/** `models/gemini-3-pro` -> `gemini-3-pro`; leaves an unprefixed id alone. */
function stripGeminiPrefix(value: string): string {
	const trimmed = value.trim();
	const withoutPrefix = trimmed.startsWith("models/") ? trimmed.slice("models/".length) : trimmed;
	return withoutPrefix.trim();
}

/** Parse a model-list payload with the configured parser. */
export function parseModels(parser: ModelParser, payload: unknown): ParseResult {
	switch (parser) {
		case "openai":
			return parseOpenAi(payload);
		case "anthropic":
			return parseAnthropic(payload);
		case "gemini":
			return parseGemini(payload);
	}
}

/** Deduplicate a parsed list, keeping first-seen order and the richer name. */
export function dedupeModels(models: ParsedModel[]): ParsedModel[] {
	const seen = new Map<string, ParsedModel>();
	for (const model of models) {
		const existing = seen.get(model.id);
		if (!existing) {
			seen.set(model.id, model);
			continue;
		}
		if (!existing.name && model.name) seen.set(model.id, { id: model.id, name: model.name });
	}
	return [...seen.values()];
}
