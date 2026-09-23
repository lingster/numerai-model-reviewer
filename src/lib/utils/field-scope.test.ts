import { describe, expect, it } from 'vitest';
import {
	DEFAULT_FIELD_SCOPE,
	fieldScopeLabel,
	resolveFieldScopes,
	resolvePrimaryFieldScope
} from './field-scope.js';

describe('resolveFieldScopes', () => {
	it('defaults to the staked field', () => {
		expect(DEFAULT_FIELD_SCOPE).toBe('staked');
	});

	it("resolves 'staked' to a single staked request", () => {
		expect(resolveFieldScopes('staked')).toEqual(['staked']);
	});

	it("resolves 'all' to a single all-models request", () => {
		expect(resolveFieldScopes('all')).toEqual(['all']);
	});

	it("resolves 'both' to one request per field, staked first", () => {
		expect(resolveFieldScopes('both')).toEqual(['staked', 'all']);
	});
});

describe('resolvePrimaryFieldScope', () => {
	it("keeps 'staked' as staked", () => {
		expect(resolvePrimaryFieldScope('staked')).toBe('staked');
	});

	it("keeps 'all' as all", () => {
		expect(resolvePrimaryFieldScope('all')).toBe('all');
	});

	it("collapses 'both' to the payout-relevant staked field", () => {
		expect(resolvePrimaryFieldScope('both')).toBe('staked');
	});
});

describe('fieldScopeLabel', () => {
	it('labels the staked field', () => {
		expect(fieldScopeLabel('staked')).toBe('Staked field');
	});

	it('labels the all-models field', () => {
		expect(fieldScopeLabel('all')).toBe('All models');
	});
});
