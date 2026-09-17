/**
 * A scrollable report overlay.
 *
 * `/custom-provider` and `/custom-provider test` produce reference output — a user reads it
 * while doing something else, copying a model id or checking why a model is
 * missing. `ctx.ui.notify` cannot serve that: its `info` form is a transient
 * status line the next call replaces, and its `error`/`warning` forms are single
 * transcript entries that scroll away and cannot be reopened.
 *
 * This renders the same content in an overlay with real scrolling, so a long
 * report stays readable and dismisses with Escape. Scrolling is delegated to
 * pi-tui's ScrollView; this component only supplies the text and the frame.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, ScrollView } from "@earendil-works/pi-tui";

/** How many rows to leave for the frame (title, two rules, footer, margins). */
const CHROME_ROWS = 6;

/** Fixed-height text body: pi supplies the width, so tables lay out exactly. */
class TextBody implements Component {
	constructor(private readonly lines: string[]) {}

	invalidate(): void {
		// Content is fixed at construction, so there is nothing to recompute.
	}

	render(width: number): string[] {
		return this.lines.flatMap((line) => wrapTo(line, width));
	}
}

class ReportOverlay implements Component {
	readonly focused = true;
	private readonly scrollView: ScrollView;
	private readonly body: Component;
	private viewportHeight: number;

	constructor(
		body: Component,
		private readonly theme: Theme,
		private readonly title: string,
		private readonly done: () => void,
		viewportHeight: number,
	) {
		this.scrollView = new ScrollView(body, { follow: "none" });
		this.body = body;
		this.viewportHeight = viewportHeight;
	}

	invalidate(): void {
		this.scrollView.invalidate?.();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, "ctrl+c")) {
			this.done();
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			this.scrollView.scrollBy(-1);
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			this.scrollView.scrollBy(1);
			return;
		}
		if (matchesKey(data, "shift+up")) {
			this.scrollView.scrollBy(-10);
			return;
		}
		if (matchesKey(data, "shift+down")) {
			this.scrollView.scrollBy(10);
			return;
		}
		if (matchesKey(data, Key.home)) this.scrollView.scrollToStart();
		if (matchesKey(data, Key.end)) this.scrollView.scrollToEnd();
	}

	render(width: number): string[] {
		const inner = Math.max(20, width - 4);
		// The scroll view must be told the content height before it can window
		// itself, so the body is measured against the real inner width each render.
		const contentHeight = this.body.render(inner).length;
		const visible = Math.max(3, this.viewportHeight - CHROME_ROWS);
		this.scrollView.updateLayout(contentHeight, visible, () => {});
		const windowed = this.scrollView.render(inner);

		const rule = this.theme.fg("dim", "─".repeat(inner));
		return [
			this.theme.fg("accent", this.title),
			rule,
			...windowed,
			rule,
			this.theme.fg("dim", "↑↓ scroll · Shift+↑↓ page · Home/End ends · Esc close"),
		];
	}
}

/**
 * Show `lines` in a scrollable overlay.
 *
 * Falls back to a transcript entry when the host cannot composite a custom
 * component (piped output, print mode), so the report is never lost — only less
 * comfortable to read.
 */
export async function showReport(ctx: ExtensionContext, title: string, lines: string[]): Promise<void> {
	const custom = ctx.ui.custom;
	if (typeof custom !== "function") {
		ctx.ui.notify(`${title}\n${lines.join("\n")}`, "info");
		return;
	}

	const terminalRows = ctx.mode === "tui" && process.stdout.rows ? process.stdout.rows : 30;
	try {
		await custom<void>(
			(tui, theme, _keybindings, done) => {
				// Read the live terminal height so the scroll window matches the
				// overlay's actual size rather than the shape at open time.
				const rows = liveRows(tui, terminalRows);
				return new ReportOverlay(new TextBody(lines), theme, title, () => done(undefined), rows);
			},
			{
				overlay: true,
				overlayOptions: { width: "90%", maxHeight: "85%", margin: 1 },
			},
		);
	} catch {
		ctx.ui.notify(`${title}\n${lines.join("\n")}`, "info");
	}
}

/** The terminal height, preferring whatever the TUI reports. */
function liveRows(tui: unknown, fallback: number): number {
	const candidate = (tui as { height?: unknown; rows?: unknown } | undefined);
	if (typeof candidate?.height === "number" && candidate.height > 0) return candidate.height;
	if (typeof candidate?.rows === "number" && candidate.rows > 0) return candidate.rows;
	return fallback;
}

/** Hard-wrap a line that exceeds the overlay width, keeping ANSI-free tables intact. */
function wrapTo(line: string, width: number): string[] {
	if (width <= 0 || line.length <= width) return [line];
	const out: string[] = [];
	for (let i = 0; i < line.length; i += width) out.push(line.slice(i, i + width));
	return out;
}
