/**
 * Self-hosted Numerai API: the worker's own request handler, served from Node.
 *
 * The handler in worker/src/index.ts is a plain `fetch(request, env, ctx)`
 * function over web-standard Request/Response, which Node has had since 18. So
 * this file is a bridge, not a port: node:http in, Request out, Response back.
 * Routing, CORS, rate limiting, ranking and the Numerai calls are the same code
 * that runs on Cloudflare, which is the point — one implementation, no drift.
 *
 * The only Cloudflare-specific binding the worker needs is D1, which SqliteD1
 * supplies from a local file. KV (rate limiting) is optional in the handler and
 * falls back to in-memory counting, so it is simply absent here.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import worker from '../../worker/src/index.js';
import { SqliteD1 } from './sqlite-d1.js';
import { applyMigrations, applySchema } from './migrations.js';
import { loadConfig, type ServerConfig } from './config.js';

/** The worker's `fetch`, whichever shape the module system hands us. */
export type FetchHandler = (request: Request, env: unknown, ctx: unknown) => Promise<Response>;

/**
 * The worker package has no `"type": "module"`, so importing its ESM default
 * export yields `{ default: { fetch } }` here but `{ fetch }` under a different
 * resolver. Accept either rather than depending on which one applies.
 */
export function resolveFetchHandler(module: unknown): FetchHandler {
	const candidates = [module, (module as { default?: unknown })?.default];
	for (const candidate of candidates) {
		const fetch = (candidate as { fetch?: unknown } | undefined)?.fetch;
		if (typeof fetch === 'function') return (fetch as FetchHandler).bind(candidate as object);
	}
	throw new TypeError('worker module does not export a fetch handler');
}

/** ExecutionContext stand-in: background work is awaited on shutdown, not dropped. */
class NodeExecutionContext {
	readonly pending = new Set<Promise<unknown>>();

	waitUntil(promise: Promise<unknown>): void {
		this.pending.add(promise);
		promise.catch((error) => console.error('background task failed:', error)).finally(() => {
			this.pending.delete(promise);
		});
	}

	passThroughOnException(): void {
		// Nothing to do: Node has no edge-level pass-through.
	}

	async drain(): Promise<void> {
		await Promise.allSettled([...this.pending]);
	}
}

/** Thrown when a client sends more body than we are willing to buffer. */
export class RequestTooLargeError extends Error {
	constructor(readonly limit: number) {
		super(`request body exceeds ${limit} bytes`);
		this.name = 'RequestTooLargeError';
	}
}

/**
 * A node:http request as a web Request the worker handler understands.
 *
 * The body is capped and the read abandoned as soon as the cap is passed:
 * buffering it whole first would let an unauthenticated client exhaust memory
 * before routing or rate limiting ever runs — and every route here is a GET.
 */
async function toWebRequest(req: IncomingMessage, origin: string, maxBodyBytes: number): Promise<Request> {
	const url = new URL(req.url ?? '/', origin);
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		for (const single of Array.isArray(value) ? value : [value]) headers.append(name, single);
	}

	const method = req.method ?? 'GET';
	let body: Buffer | undefined;
	if (method !== 'GET' && method !== 'HEAD') {
		// A declared length short-circuits the read; it is a hint, not a promise,
		// so the running total below is what actually enforces the cap.
		const declared = Number(req.headers['content-length'] ?? 0);
		if (Number.isFinite(declared) && declared > maxBodyBytes) throw new RequestTooLargeError(maxBodyBytes);

		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req) {
			size += (chunk as Buffer).length;
			if (size > maxBodyBytes) throw new RequestTooLargeError(maxBodyBytes);
			chunks.push(chunk as Buffer);
		}
		body = Buffer.concat(chunks);
	}

	return new Request(url, { method, headers, body });
}

async function writeWebResponse(response: Response, res: ServerResponse): Promise<void> {
	res.statusCode = response.status;
	response.headers.forEach((value, name) => res.setHeader(name, value));
	const body = response.body ? Buffer.from(await response.arrayBuffer()) : undefined;
	res.end(body);
}

export function createApiServer(config: ServerConfig) {
	const sqlite = SqliteD1.open(config.databasePath);
	if (config.applySchema) {
		applySchema(sqlite, config.schemaPath);
		const applied = applyMigrations(sqlite, config.migrationsPath);
		if (applied.length > 0) console.log(`applied migrations: ${applied.join(', ')}`);
	}
	try {
		sqlite.optimize();
	} catch (error) {
		// Statistics only improve plans; a busy or read-only database still serves.
		console.warn('PRAGMA optimize at startup failed:', error);
	}

	const env = {
		DB: sqlite.asD1(),
		NUMERAI_API_URL: config.numeraiApiUrl,
		NUMERAI_PUBLIC_KEY: config.numeraiPublicKey,
		NUMERAI_SECRET_KEY: config.numeraiSecretKey,
		ALLOWED_ORIGINS: config.allowedOrigins,
		ALLOWED_ORIGIN_SUFFIXES: config.allowedOriginSuffixes,
		RATE_LIMIT_REQUESTS: String(config.rateLimitRequests),
		RATE_LIMIT_WINDOW_SECONDS: String(config.rateLimitWindowSeconds)
	};

	const ctx = new NodeExecutionContext();
	const handleRequest = resolveFetchHandler(worker);

	const server = createServer((req, res) => {
		const origin = `http://${req.headers.host ?? `localhost:${config.port}`}`;
		void (async () => {
			try {
				const request = await toWebRequest(req, origin, config.maxRequestBodyBytes);
				const response = await handleRequest(request, env, ctx);
				await writeWebResponse(response, res);
			} catch (error) {
				const tooLarge = error instanceof RequestTooLargeError;
				if (!tooLarge) console.error(`${req.method} ${req.url} failed:`, error);
				if (!res.headersSent) {
					res.statusCode = tooLarge ? 413 : 500;
					res.setHeader('content-type', 'application/json');
					// The rest of the body is never read, so the connection cannot be
					// reused; saying so lets the client read the response before the
					// socket goes away, instead of seeing a reset.
					if (tooLarge) res.setHeader('connection', 'close');
				}
				const payload = JSON.stringify({ error: tooLarge ? 'Payload too large' : 'Internal server error' });
				res.end(payload, () => {
					if (tooLarge) req.destroy();
				});
			}
		})();
	});

	const close = async (): Promise<void> => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await ctx.drain();
		sqlite.close();
	};

	return { server, close, env };
}

/** Entry point: started directly, not when imported by tests. */
const invokedDirectly = process.argv[1] !== undefined && /server\.[cm]?[jt]s$/.test(process.argv[1]);

if (invokedDirectly) {
	const config = loadConfig();
	const { server, close } = createApiServer(config);

	server.listen(config.port, config.host, () => {
		console.log(`numerai api listening on http://${config.host}:${config.port}`);
		console.log(`  database: ${config.databasePath}`);
		console.log(`  allowed origins: ${config.allowedOrigins}`);
	});

	for (const signal of ['SIGINT', 'SIGTERM'] as const) {
		process.on(signal, () => {
			console.log(`\n${signal} received, shutting down`);
			void close().then(() => process.exit(0));
		});
	}
}
