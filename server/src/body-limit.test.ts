/**
 * Request bodies are capped.
 *
 * The bridge buffers a body into a `Request` before the worker's handler — and
 * therefore before routing, the CORS allowlist and rate limiting — ever sees
 * it. Without a cap, one unauthenticated client can make the process allocate
 * as much memory as it cares to send. Every route this API exposes is a GET,
 * so the cap can be small.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApiServer } from './server.js';
import { TEST_ORIGIN as ORIGIN, testConfig } from './test-support/server-config.js';

const LIMIT = 1024;

let directory: string;
let close: () => Promise<void>;
let baseUrl: string;

beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), 'numerai-body-'));
	const config = testConfig(join(directory, 'test.sqlite'), { maxRequestBodyBytes: LIMIT });

	const api = createApiServer(config);
	close = api.close;
	await new Promise<void>((ready) => api.server.listen(0, '127.0.0.1', ready));
	baseUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
	await close?.();
	rmSync(directory, { recursive: true, force: true });
});

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
	fetch(`${baseUrl}/health`, { method: 'POST', headers: { Origin: ORIGIN, ...headers }, body });

describe('a request body larger than the limit', () => {
	it('is rejected with 413 rather than buffered', async () => {
		const response = await post('x'.repeat(LIMIT + 1));
		expect(response.status).toBe(413);
		await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/too large/i) });
	});

	it('is rejected on a streamed body, where content-length is absent', async () => {
		// A declared length is a hint, not a promise; the running total is what counts.
		const chunks = new ReadableStream({
			start(controller) {
				for (let index = 0; index < 8; index += 1) controller.enqueue(new Uint8Array(LIMIT));
				controller.close();
			}
		});
		const response = await fetch(`${baseUrl}/health`, {
			method: 'POST',
			headers: { Origin: ORIGIN },
			body: chunks,
			// @ts-expect-error duplex is required by undici for a streamed body
			duplex: 'half'
		});
		expect(response.status).toBe(413);
	});

	it('leaves the server answering afterwards', async () => {
		await post('x'.repeat(LIMIT + 1)).catch(() => undefined);
		const response = await fetch(`${baseUrl}/health`, { headers: { Origin: ORIGIN } });
		expect(response.status).toBe(200);
	});
});

describe('a request body within the limit', () => {
	it('reaches the handler, which routes it as usual', async () => {
		const response = await post('x'.repeat(LIMIT));
		// /health is GET-only, so the handler 404s it — the point is that it got there.
		expect(response.status).not.toBe(413);
	});
});
