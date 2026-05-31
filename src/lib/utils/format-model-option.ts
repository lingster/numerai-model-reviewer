/**
 * Label for a model in the "Search Models" picker. Beyond the name and owner,
 * it surfaces the model's current stake and trailing 1-year return (when known)
 * so users can tell at a glance which models are worth comparing.
 *
 * Format: `name (owner) · <stake> NMR · ±<return>% 1y`
 * Stake/return segments are omitted when absent or zero.
 */
import type { NumeraiModel } from '$lib/types.js';

function formatStake(stake: number): string {
	// Whole NMR with thousands separators once we're past tiny stakes; otherwise
	// two decimals so sub-1-NMR amounts aren't shown as "0".
	return stake >= 1 ? Math.round(stake).toLocaleString('en-US') : stake.toFixed(2);
}

export function formatModelOption(model: NumeraiModel): string {
	const parts = [`${model.name} (${model.username})`];

	if (model.stake != null && model.stake > 0) {
		parts.push(`${formatStake(model.stake)} NMR`);
	}

	if (model.return1y != null && model.return1y !== 0) {
		const sign = model.return1y > 0 ? '+' : '';
		parts.push(`${sign}${model.return1y.toFixed(1)}% 1y`);
	}

	return parts.join(' · ');
}
