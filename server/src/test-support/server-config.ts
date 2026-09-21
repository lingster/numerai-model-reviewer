/** A ServerConfig for tests: a throwaway database, the real schema and migrations. */
import { resolve } from 'node:path';
import type { ServerConfig } from '../config.js';

export const TEST_ORIGIN = 'http://localhost:5173';

export function testConfig(databasePath: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
	return {
		host: '127.0.0.1',
		port: 0, // any free port
		databasePath,
		schemaPath: resolve('../worker/src/schema.sql'),
		migrationsPath: resolve('../worker/migrations'),
		applySchema: true,
		numeraiApiUrl: 'https://api-tournament.numer.ai/graphql',
		numeraiPublicKey: '',
		numeraiSecretKey: '',
		allowedOrigins: TEST_ORIGIN,
		allowedOriginSuffixes: '',
		rateLimitRequests: 1000,
		rateLimitWindowSeconds: 60,
		maxRequestBodyBytes: 1_048_576,
		...overrides
	};
}
