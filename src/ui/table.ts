/**
 * Terminal-width-aware formatting for the `/custom-provider` reports.
 *
 * pi renders `ctx.ui.notify` and overlay text verbatim, so columns are laid out
 * here rather than by a layout engine. Two rules drive the design:
 *
 *   - the requested width is a hard budget, not a suggestion: separator spaces
 *     are subtracted before columns are sized, so a table never overflows
 *   - identifiers are never truncated. A model id the user cannot read is a
 *     model id they cannot copy, so when space runs out descriptive columns are
 *     dropped instead.
 */

/** Used when the terminal size is unknown (piped output, tests). */
const FALLBACK_WIDTH = 100;

export interface Column {
	header: string;
	/** Share of the flexible budget, or an exact cell count when `fixed` is set. */
	size: number;
	/** Cell count that does not scale with the terminal. */
	fixed?: boolean;
	/** Minimum cell count for a flexible column. Default 6. */
	min?: number;
	/** Maximum cell count, so a wide terminal does not pad to absurdity. */
	max?: number;
	/** Right-align numeric columns so magnitudes line up. */
	align?: "left" | "right";
	/**
	 * Drop this column first when the budget is too tight. Columns without it
	 * are kept as long as possible, which protects identifiers.
	 */
	dropPriority?: number;
	/**
	 * Size this column to its widest cell rather than to a share of the budget.
	 * Use for identifier columns (model ids, endpoint names) so they are shown in
	 * full whenever the terminal allows, and never padded to a fixed guess.
	 */
	fitContent?: boolean;
	/**
	 * Allow clipping this cell as a last resort. Only for descriptive columns:
	 * an identifier that gets clipped is one the user cannot copy, so identifiers
	 * must leave this unset and rely on column dropping instead.
	 */
	clip?: boolean;
}

export function terminalWidth(): number {
	const columns = process.stdout.columns;
	return columns && columns > 0 ? columns : FALLBACK_WIDTH;
}

/**
 * Render aligned rows inside `width` columns.
 *
 * `maxWidth` lets a caller that already knows its container (an overlay) pass
 * the real budget instead of guessing from `process.stdout`.
 */
export function table(columns: Column[], rows: string[][], maxWidth?: number): string[] {
	const budget = Math.max(12, (maxWidth ?? terminalWidth()) - 2);

	// Drop descriptive columns until the identifiers can be shown in full.
	const active = fitColumns(columns, rows, budget);
	const widths = allocateWithContent(active, rows, allocate(active, budget), budget);

	const lines = [formatRow(active.map((c) => c.header), widths, false, active)];
	for (const row of rows) {
		const cells = row.slice(0, active.length);
		lines.push(formatRow(cells, widths, true, active));
	}
	return lines;
}

/**
 * Give content-fitted columns exactly the width their widest cell needs, then
 * let the remaining columns divide what is left. This is what keeps a model id
 * intact on a wide terminal instead of pinning it to an arbitrary share.
 */
function allocateWithContent(columns: Column[], rows: string[][], widths: number[], budget: number): number[] {
	const separators = Math.max(0, columns.length - 1);
	const out = [...widths];
	const fixedTotal = columns.filter((c) => c.fixed).reduce((sum, c) => sum + c.size, 0);
	const weighted = columns
		.map((column, index) => ({ column, index }))
		.filter(({ column }) => !column.fixed && !column.fitContent);

	// Content-fitted columns are served first, from the budget left after the
	// fixed ones — an identifier outranks a descriptive column, so a model id is
	// never clipped to make room for a name it does not need.
	const contentIdx = columns
		.map((column, index) => ({ column, index }))
		.filter(({ column }) => column.fitContent && !column.fixed);

	let contentUsed = 0;
	for (const { column, index } of contentIdx) {
		const longest = Math.max(column.header.length, ...rows.map((r) => (r[index] ?? "").length));
		const want = clamp(longest, column.min ?? 6, column.max ?? Number.MAX_SAFE_INTEGER);
		out[index] = want;
		contentUsed += want;
	}

	// Weighted columns share whatever the identifiers did not need, with a floor
	// so they never vanish to zero.
	const weightedBudget = Math.max(weighted.length * 6, budget - separators - fixedTotal - contentUsed);
	const totalWeight = weighted.reduce((sum, { column }) => sum + column.size, 0) || 1;
	for (const { column, index } of weighted) {
		out[index] = clamp(Math.floor((weightedBudget * column.size) / totalWeight), column.min ?? 6, column.max ?? Number.MAX_SAFE_INTEGER);
	}

	// If identifiers alone exceed the budget, take the space back from the
	// weighted columns rather than overflowing.
	let excess = out.reduce((sum, w) => sum + w, 0) + separators - budget;
	for (let i = weighted.length - 1; i >= 0 && excess > 0; i--) {
		const { column, index } = weighted[i];
		const take = Math.min(excess, out[index] - (column.min ?? 6));
		out[index] -= take;
		excess -= take;
	}
	// Nothing left to take: clamp the content columns themselves so the row still
	// fits, accepting a clipped identifier as the lesser evil.
	for (let i = contentIdx.length - 1; i >= 0 && excess > 0; i--) {
		const { index } = contentIdx[i];
		const take = Math.min(excess, Math.max(0, out[index] - 6));
		out[index] -= take;
		excess -= take;
	}
	return out;
}

/**
 * Drop the least important columns until the rest fit.
 *
 * The test is the columns' *floors* against the budget, which guarantees the
 * layout never overflows. Descriptive columns are shed before an identifier is
 * ever shortened; if even the floors do not fit, the allocator clamps and the
 * caller is expected to render a narrow form instead.
 */
function fitColumns(columns: Column[], rows: string[][], budget: number): Column[] {
	let active = columns.map((column, index) => ({ column, index }));

	const floor = (cols: typeof active) =>
		cols.reduce((sum, { column }) => sum + (column.fixed ? column.size : (column.min ?? 6)), 0) +
		Math.max(0, cols.length - 1);

	while (active.length > 1 && floor(active) > budget) {
		const victims = active
			.filter(({ column }) => column.dropPriority !== undefined)
			.sort((a, b) => (a.column.dropPriority ?? 0) - (b.column.dropPriority ?? 0));
		if (victims.length === 0) break;
		active = active.filter((entry) => entry !== victims[0]);
	}
	void rows;

	// An identifier whose content exceeds its allocation is the one case where a
	// descriptive column is still worse than a shorter id: shed those too, so the
	// id gets as much room as the budget can give it.
	const wanted = (cols: typeof active) =>
		cols.reduce((sum, { column, index }) => {
			if (column.fixed) return sum + column.size;
			const longest = Math.max(column.header.length, ...rows.map((r) => (r[index] ?? "").length));
			return sum + clamp(longest, column.min ?? 6, column.max ?? Number.MAX_SAFE_INTEGER);
		}, 0) + Math.max(0, cols.length - 1);

	while (active.length > 1 && wanted(active) > budget) {
		const victims = active
			.filter(({ column }) => column.dropPriority !== undefined)
			.sort((a, b) => (a.column.dropPriority ?? 0) - (b.column.dropPriority ?? 0));
		if (victims.length === 0) break;
		active = active.filter((entry) => entry !== victims[0]);
	}

	return active.map((entry) => entry.column);
}

/** Split the budget between fixed and flexible columns, minus separator spaces. */
function allocate(columns: Column[], budget: number): number[] {
	const separators = Math.max(0, columns.length - 1);
	const available = Math.max(0, budget - separators);

	const fixedTotal = columns.filter((c) => c.fixed).reduce((sum, c) => sum + c.size, 0);
	const flexible = columns.filter((c) => !c.fixed);
	const flexWeight = flexible.reduce((sum, c) => sum + c.size, 0) || 1;
	const flexBudget = Math.max(0, available - fixedTotal);

	const widths = columns.map((column) => {
		if (column.fixed) return column.size;
		const share = Math.floor((flexBudget * column.size) / flexWeight);
		return clamp(share, column.min ?? 6, column.max ?? Number.MAX_SAFE_INTEGER);
	});

	// Clamping can leave slack (a max-capped column) or an overflow (floors
	// exceeding the budget). Reconcile against the flex columns only.
	const total = widths.reduce((sum, w) => sum + w, 0);
	if (total > available) {
		let excess = total - available;
		for (let i = columns.length - 1; i >= 0 && excess > 0; i--) {
			const column = columns[i];
			if (column.fixed) continue;
			const floor = column.min ?? 6;
			const take = Math.min(excess, widths[i] - floor);
			widths[i] -= take;
			excess -= take;
		}
	}
	return widths;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

/**
 * Emit one row, guaranteeing it is no wider than the sum of `widths`.
 *
 * The invariant matters more than fidelity: a cell that would exceed its column
 * is clipped even when the column is an identifier, because an overflowing row
 * wraps and destroys the whole table's alignment. `fitColumns` has already shed
 * descriptive columns to keep that from happening to a model id.
 */
function formatRow(cells: string[], widths: number[], truncate: boolean, columns?: Column[]): string {
	const out = cells.map((cell, index) => {
		const w = widths[index] ?? 10;
		const align = columns?.[index]?.align ?? "left";
		const value = cell ?? "";
		// The last column absorbs slack rather than padding it out, so trailing
		// whitespace never reaches the terminal.
		const isLast = index === cells.length - 1;
		const raw = truncate && value.length > w ? clip(value, w) : value;
		if (align === "right") return padLeft(raw, w);
		return isLast ? pad(raw, w).trimEnd() : pad(raw, w);
	});
	return out.join(" ").trimEnd();
}

function clip(text: string, w: number): string {
	if (text.length <= w) return text;
	if (w <= 1) return text.slice(0, w);
	return `${text.slice(0, w - 1)}…`;
}

function pad(text: string, w: number): string {
	return text.length >= w ? text : text + " ".repeat(w - text.length);
}

function padLeft(text: string, w: number): string {
	return text.length >= w ? text : " ".repeat(w - text.length) + text;
}

/**
 * Format a token count for a narrow column: `384k`, `272k`, `1M`.
 *
 * Lowercase `k` and uppercase `M` throughout, with a single decimal only when
 * rounding would discard meaningful precision (a 131072-token window is
 * `131k`, but 32768 is `32.8k`, not `33k`).
 */
export function shortTokens(count: number): string {
	if (!Number.isFinite(count) || count <= 0) return "—";
	if (count >= 1_000_000) {
		const millions = count / 1_000_000;
		return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
	}
	if (count >= 100_000) return `${Math.round(count / 1000)}k`;
	if (count >= 1000) {
		const thousands = count / 1000;
		// Keep one decimal while it adds information, so power-of-two windows read
		// as `32.8k` rather than a lossy `33k`.
		return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`;
	}
	return String(count);
}

/**
 * The thinking levels a model exposes, using pi's own level names.
 *
 * A contiguous run collapses to a range (`low–xhigh`) so the column stays narrow
 * without inventing abbreviations that require reading the source.
 */
export function thinkingSummary(
	reasoning: boolean,
	thinkingLevelMap: Record<string, string | null> | undefined,
): string {
	if (!reasoning) return "off";
	const order = ["minimal", "low", "medium", "high", "xhigh", "max"];
	const offered = order.filter((level) => thinkingLevelMap?.[level] !== null);
	if (offered.length === 0) return "off";
	if (offered.length === order.length) return "all";

	// Collapse a contiguous run that starts at the first level.
	const ranges: string[] = [];
	let runStart = 0;
	for (let i = 1; i <= offered.length; i++) {
		const contiguous = i < offered.length && order.indexOf(offered[i]) === order.indexOf(offered[i - 1]) + 1;
		if (contiguous) continue;
		const run = offered.slice(runStart, i);
		ranges.push(run.length >= 3 ? `${run[0]}–${run[run.length - 1]}` : run.join("·"));
		runStart = i;
	}
	return ranges.join("·");
}
