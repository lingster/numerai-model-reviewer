/** Vite/Vitest `?raw` imports resolve to the file's text. */
declare module '*?raw' {
	const content: string;
	export default content;
}

/** Vite's import.meta.glob, as used by the test harness to load migrations. */
interface ImportMeta {
	glob(
		pattern: string,
		options: { query: '?raw'; import: 'default'; eager: true }
	): Record<string, unknown>;
}
