/**
 * Small wrappers over `ctx.ui` that make wizard steps skippable and cancellable.
 *
 * pi's `ui.input()` returns undefined both when the user cancels (Esc) and when
 * the prompt is unavailable, so every helper returns a discriminated result and
 * callers decide which of the two happened. Typing `-` clears a value, matching
 * the convention used by pi's own settings editors.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const CANCEL = Symbol("cancel");
export const CLEAR = Symbol("clear");

export type Answer = string | typeof CANCEL | typeof CLEAR;

export async function ask(ctx: ExtensionContext, title: string, placeholder?: string): Promise<Answer> {
	const value = await ctx.ui.input(title, placeholder);
	if (value === undefined) return CANCEL;
	const trimmed = value.trim();
	if (trimmed === "-") return CLEAR;
	return trimmed;
}

/**
 * Prompt for text where `fallback` is used both when the user submits an empty
 * line and when they type `-` to clear. Returns undefined only on cancel.
 */
export async function askText(
	ctx: ExtensionContext,
	title: string,
	options: { placeholder?: string; fallback?: string } = {},
): Promise<string | undefined> {
	const answer = await ask(ctx, title, options.placeholder);
	if (answer === CANCEL) return undefined;
	if (answer === CLEAR || answer === "") return options.fallback;
	return answer;
}

/** Prompt for a free-form list, accepting commas or newlines as separators. */
export async function askList(ctx: ExtensionContext, title: string, placeholder?: string): Promise<string[] | undefined> {
	const answer = await ask(ctx, title, placeholder);
	if (answer === CANCEL) return undefined;
	if (answer === CLEAR || answer === "") return [];
	return answer
		.split(/[,\n]/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}
