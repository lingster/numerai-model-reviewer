import { describe, expect, it } from 'vitest';
import { effectiveModels, isUsingAllUserModels } from './model-selection';

const a = { id: '1', name: 'model_a' };
const b = { id: '2', name: 'model_b' };

describe('effectiveModels', () => {
	it('uses the models that were picked', () => {
		expect(effectiveModels([a], [a, b], true)).toEqual([a]);
	});

	it('falls back to every model of the selected user when none are picked', () => {
		// Charting a whole account should not mean clicking each model in turn.
		expect(effectiveModels([], [a, b], true)).toEqual([a, b]);
	});

	it('has nothing to chart when no user is selected', () => {
		expect(effectiveModels([], [a, b], false)).toEqual([]);
	});
});

describe('isUsingAllUserModels', () => {
	it('is true only when the fallback actually supplied models', () => {
		expect(isUsingAllUserModels([], [a, b])).toBe(true);
		expect(isUsingAllUserModels([a], [a])).toBe(false);
		expect(isUsingAllUserModels([], [])).toBe(false);
	});
});
