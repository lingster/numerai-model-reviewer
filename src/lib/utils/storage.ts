/**
 * Utilities for managing saved charts and recent items in localStorage
 */
import { browser } from '$app/environment';
import type { SavedChart } from '$lib/types.js';

const STORAGE_KEY = 'numerai_saved_charts';
const RECENT_USER_MODELS_KEY = 'numerai_recent_user_models';
const RECENT_CHARTS_KEY = 'numerai_recent_charts';
const TOURNAMENT_KEY = 'numerai_selected_tournament';
const MAX_RECENT_ITEMS = 5;

/**
 * Tournament IDs and their names
 */
export const TOURNAMENTS = {
	CLASSIC: 8,
	SIGNALS: 11,
	CRYPTO: 12
} as const;

export type TournamentId = typeof TOURNAMENTS[keyof typeof TOURNAMENTS];

export interface TournamentInfo {
	id: TournamentId;
	name: string;
	theme: string;
}

export const TOURNAMENT_INFO: Record<TournamentId, TournamentInfo> = {
	[TOURNAMENTS.CLASSIC]: { id: TOURNAMENTS.CLASSIC, name: 'Classic', theme: 'theme-classic' },
	[TOURNAMENTS.SIGNALS]: { id: TOURNAMENTS.SIGNALS, name: 'Signals', theme: 'theme-signals' },
	[TOURNAMENTS.CRYPTO]: { id: TOURNAMENTS.CRYPTO, name: 'Crypto', theme: 'theme-crypto' }
};

/**
 * Get storage key for tournament-specific saved charts
 */
function getSavedChartsKey(tournament: TournamentId): string {
	return `${STORAGE_KEY}_t${tournament}`;
}

/**
 * Get the selected tournament from localStorage
 */
export function getSelectedTournament(): TournamentId {
	if (!browser) {
		return TOURNAMENTS.CLASSIC;
	}

	try {
		const stored = localStorage.getItem(TOURNAMENT_KEY);
		if (stored) {
			const parsed = parseInt(stored, 10);
			if (parsed === TOURNAMENTS.CLASSIC || parsed === TOURNAMENTS.SIGNALS || parsed === TOURNAMENTS.CRYPTO) {
				return parsed;
			}
		}
	} catch (error) {
		console.error('Error loading selected tournament:', error);
	}

	return TOURNAMENTS.CLASSIC;
}

/**
 * Save the selected tournament to localStorage
 */
export function setSelectedTournament(tournament: TournamentId): void {
	if (!browser) {
		return;
	}

	try {
		localStorage.setItem(TOURNAMENT_KEY, tournament.toString());
	} catch (error) {
		console.error('Error saving selected tournament:', error);
	}
}

/**
 * Represents a recent user/model search
 */
export interface RecentUserModel {
	user: string;
	model: string;
	timestamp: number;
}

/**
 * Represents a recent chart configuration
 */
export interface RecentChart {
	name: string;
	models: string[];
	startDate: string;
	endDate: string;
	timestamp: number;
}

/**
 * Get all saved charts from localStorage for a specific tournament
 */
export function getSavedCharts(tournament: TournamentId = TOURNAMENTS.CLASSIC): SavedChart[] {
	if (!browser) {
		return [];
	}

	try {
		const storageKey = getSavedChartsKey(tournament);
		const stored = localStorage.getItem(storageKey);
		if (stored) {
			const parsed = JSON.parse(stored);
			if (Array.isArray(parsed)) {
				return parsed;
			}
		}
	} catch (error) {
		console.error('Error loading saved charts:', error);
	}

	return [];
}

/**
 * Save a chart to localStorage for a specific tournament
 */
export function saveChart(chart: SavedChart, tournament: TournamentId = TOURNAMENTS.CLASSIC): void {
	if (!browser) {
		return;
	}

	try {
		const charts = getSavedCharts(tournament);

		// Check if chart with same ID exists and update it
		const existingIndex = charts.findIndex((c) => c.id === chart.id);
		if (existingIndex >= 0) {
			charts[existingIndex] = chart;
		} else {
			charts.push(chart);
		}

		const storageKey = getSavedChartsKey(tournament);
		localStorage.setItem(storageKey, JSON.stringify(charts));
	} catch (error) {
		console.error('Error saving chart:', error);
	}
}

/**
 * Delete a saved chart by ID for a specific tournament
 */
export function deleteChart(chartId: string, tournament: TournamentId = TOURNAMENTS.CLASSIC): void {
	if (!browser) {
		return;
	}

	try {
		const charts = getSavedCharts(tournament);
		const filtered = charts.filter((c) => c.id !== chartId);
		const storageKey = getSavedChartsKey(tournament);
		localStorage.setItem(storageKey, JSON.stringify(filtered));
	} catch (error) {
		console.error('Error deleting chart:', error);
	}
}

/**
 * Get a specific saved chart by ID for a specific tournament
 */
export function getChartById(chartId: string, tournament: TournamentId = TOURNAMENTS.CLASSIC): SavedChart | null {
	const charts = getSavedCharts(tournament);
	return charts.find((c) => c.id === chartId) || null;
}

/**
 * Clear all saved charts for a specific tournament
 */
export function clearAllCharts(tournament: TournamentId = TOURNAMENTS.CLASSIC): void {
	if (!browser) {
		return;
	}

	const storageKey = getSavedChartsKey(tournament);
	localStorage.removeItem(storageKey);
}

/**
 * Get the 5 most recent user/model searches
 */
export function getRecentUserModels(): RecentUserModel[] {
	if (!browser) {
		return [];
	}

	try {
		const stored = localStorage.getItem(RECENT_USER_MODELS_KEY);
		if (stored) {
			const parsed = JSON.parse(stored);
			if (Array.isArray(parsed)) {
				return parsed.slice(0, MAX_RECENT_ITEMS);
			}
		}
	} catch (error) {
		console.error('Error loading recent user models:', error);
	}

	return [];
}

/**
 * Add a user/model combination to the recent list
 * Maintains only the 5 most recent unique combinations
 */
export function addRecentUserModel(user: string, model: string): void {
	if (!browser || !user || !model) {
		return;
	}

	try {
		const recents = getRecentUserModels();

		// Remove existing entry for the same user/model combination
		const filtered = recents.filter(
			(item) => !(item.user === user && item.model === model)
		);

		// Add new entry at the beginning
		const newEntry: RecentUserModel = {
			user,
			model,
			timestamp: Date.now()
		};

		const updated = [newEntry, ...filtered].slice(0, MAX_RECENT_ITEMS);
		localStorage.setItem(RECENT_USER_MODELS_KEY, JSON.stringify(updated));
	} catch (error) {
		console.error('Error saving recent user model:', error);
	}
}

/**
 * Get the 5 most recent chart configurations
 */
export function getRecentCharts(): RecentChart[] {
	if (!browser) {
		return [];
	}

	try {
		const stored = localStorage.getItem(RECENT_CHARTS_KEY);
		if (stored) {
			const parsed = JSON.parse(stored);
			if (Array.isArray(parsed)) {
				return parsed.slice(0, MAX_RECENT_ITEMS);
			}
		}
	} catch (error) {
		console.error('Error loading recent charts:', error);
	}

	return [];
}

/**
 * Add a chart configuration to the recent list
 * Maintains only the 5 most recent unique configurations
 */
export function addRecentChart(chart: {
	name?: string;
	models: string[];
	startDate: string;
	endDate: string;
}): void {
	if (!browser || !chart.models || chart.models.length === 0) {
		return;
	}

	try {
		const recents = getRecentCharts();

		// Create a unique key based on models (sorted for consistency)
		const modelKey = [...chart.models].sort().join(',');

		// Remove existing entry with the same models
		const filtered = recents.filter((item) => {
			const existingKey = [...item.models].sort().join(',');
			return existingKey !== modelKey;
		});

		// Add new entry at the beginning
		const newEntry: RecentChart = {
			name: chart.name || `${chart.models.length} models`,
			models: chart.models,
			startDate: chart.startDate,
			endDate: chart.endDate,
			timestamp: Date.now()
		};

		const updated = [newEntry, ...filtered].slice(0, MAX_RECENT_ITEMS);
		localStorage.setItem(RECENT_CHARTS_KEY, JSON.stringify(updated));
	} catch (error) {
		console.error('Error saving recent chart:', error);
	}
}

/**
 * Clear all recent user/model searches
 */
export function clearRecentUserModels(): void {
	if (!browser) {
		return;
	}

	localStorage.removeItem(RECENT_USER_MODELS_KEY);
}

/**
 * Clear all recent charts
 */
export function clearRecentCharts(): void {
	if (!browser) {
		return;
	}

	localStorage.removeItem(RECENT_CHARTS_KEY);
}
