/**
 * Server configuration from the environment.
 *
 * The names mirror the worker's wrangler.toml vars and secrets, so the same
 * values configure either deployment.
 */

import { resolve } from 'node:path';

export interface ServerConfig {
	host: string;
	port: number;
	/** SQLite file holding what D1 holds today. */
	databasePath: string;
	/** worker/src/schema.sql — applied at startup so a fresh volume works. */
	schemaPath: string;
	/** worker/migrations — applied after the schema, in filename order. */
	migrationsPath: string;
	applySchema: boolean;
	numeraiApiUrl: string;
	numeraiPublicKey: string;
	numeraiSecretKey: string;
	allowedOrigins: string;
	allowedOriginSuffixes: string;
	rateLimitRequests: number;
	rateLimitWindowSeconds: number;
}

const str = (name: string, fallback: string): string => process.env[name]?.trim() || fallback;

const int = (name: string, fallback: number): number => {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) throw new RangeError(`${name} must be an integer, got ${raw}`);
	return parsed;
};

export function loadConfig(): ServerConfig {
	const config: ServerConfig = {
		host: str('HOST', '0.0.0.0'),
		port: int('PORT', 8787),
		databasePath: resolve(str('DATABASE_PATH', './data/numerai-cache.sqlite')),
		schemaPath: resolve(str('SCHEMA_PATH', '../worker/src/schema.sql')),
		migrationsPath: resolve(str('MIGRATIONS_PATH', '../worker/migrations')),
		applySchema: str('APPLY_SCHEMA', 'true') !== 'false',
		numeraiApiUrl: str('NUMERAI_API_URL', 'https://api-tournament.numer.ai/graphql'),
		numeraiPublicKey: str('NUMERAI_PUBLIC_KEY', ''),
		numeraiSecretKey: str('NUMERAI_SECRET_KEY', ''),
		allowedOrigins: str('ALLOWED_ORIGINS', 'http://localhost:5173'),
		allowedOriginSuffixes: str('ALLOWED_ORIGIN_SUFFIXES', ''),
		rateLimitRequests: int('RATE_LIMIT_REQUESTS', 100),
		rateLimitWindowSeconds: int('RATE_LIMIT_WINDOW_SECONDS', 60)
	};

	// Signals and Crypto reach Numerai with credentials; Classic mostly does not.
	// Warn rather than fail: the rankings endpoints serve stored data regardless.
	if (!config.numeraiPublicKey || !config.numeraiSecretKey) {
		console.warn(
			'NUMERAI_PUBLIC_KEY / NUMERAI_SECRET_KEY are unset — endpoints that call Numerai live may fail'
		);
	}
	return config;
}
