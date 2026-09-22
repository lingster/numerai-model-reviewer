/**
 * The bridge's own logic. The routing and business rules are the worker's and
 * are tested there; what can break here is the seam between module systems.
 */
import { describe, expect, it } from 'vitest';
import { resolveFetchHandler } from './server.js';

describe('resolveFetchHandler', () => {
	const fetch = async () => new Response('ok');

	it('accepts a module whose default export is the handler object', () => {
		// What tsx gives us today: the worker package is CJS, so ESM default
		// interop nests it one level down.
		expect(resolveFetchHandler({ default: { fetch } })).toBeTypeOf('function');
	});

	it('accepts a module that exposes fetch directly', () => {
		expect(resolveFetchHandler({ fetch })).toBeTypeOf('function');
	});

	it('keeps the handler bound to its object', async () => {
		const handler = { greeting: 'hi', fetch(this: { greeting: string }) { return Promise.resolve(new Response(this.greeting)); } };
		const resolved = resolveFetchHandler({ default: handler });
		await expect((await resolved({} as Request, {}, {})).text()).resolves.toBe('hi');
	});

	it('fails loudly when there is no handler, rather than at the first request', () => {
		expect(() => resolveFetchHandler({})).toThrow(/fetch handler/);
		expect(() => resolveFetchHandler(undefined)).toThrow(/fetch handler/);
	});
});
