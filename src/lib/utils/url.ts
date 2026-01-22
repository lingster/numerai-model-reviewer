/**
 * URL manipulation utilities for shareable chart links
 */
import { browser } from '$app/environment';
import { replaceState } from '$app/navigation';

export interface ChartParams {
	models: string[];
	startDate?: string;
	endDate?: string;
	name?: string;
}

/**
 * Update the current URL with chart parameters (without page reload)
 */
export function updateUrlWithChart(params: ChartParams): void {
	if (!browser) {
		return;
	}

	const url = new URL(window.location.href);

	// Set models parameter
	if (params.models.length > 0) {
		url.searchParams.set('models', params.models.join(','));
	} else {
		url.searchParams.delete('models');
	}

	// Set date range parameters
	if (params.startDate) {
		url.searchParams.set('startDate', params.startDate);
	} else {
		url.searchParams.delete('startDate');
	}

	if (params.endDate) {
		url.searchParams.set('endDate', params.endDate);
	} else {
		url.searchParams.delete('endDate');
	}

	// Set chart name parameter
	if (params.name) {
		url.searchParams.set('name', params.name);
	} else {
		url.searchParams.delete('name');
	}

	// Update URL without reload
	replaceState(url.toString(), {});
}

/**
 * Generate a shareable URL for the current chart configuration
 */
export function generateShareableUrl(params: ChartParams): string {
	if (!browser) {
		return '';
	}

	const url = new URL(window.location.origin + window.location.pathname);

	// Add models parameter
	if (params.models.length > 0) {
		url.searchParams.set('models', params.models.join(','));
	}

	// Add date range parameters
	if (params.startDate) {
		url.searchParams.set('startDate', params.startDate);
	}

	if (params.endDate) {
		url.searchParams.set('endDate', params.endDate);
	}

	// Add chart name parameter
	if (params.name) {
		url.searchParams.set('name', params.name);
	}

	return url.toString();
}

/**
 * Parse chart parameters from the current URL
 */
export function parseUrlParams(): ChartParams | null {
	if (!browser) {
		return null;
	}

	const url = new URL(window.location.href);
	const modelsParam = url.searchParams.get('models');

	if (!modelsParam) {
		return null;
	}

	return {
		models: modelsParam.split(',').map((id) => id.trim()).filter(Boolean),
		startDate: url.searchParams.get('startDate') || undefined,
		endDate: url.searchParams.get('endDate') || undefined,
		name: url.searchParams.get('name') || undefined
	};
}

/**
 * Clear all URL parameters
 */
export function clearUrlParams(): void {
	if (!browser) {
		return;
	}

	const url = new URL(window.location.origin + window.location.pathname);
	replaceState(url.toString(), {});
}

/**
 * Get a specific URL parameter
 */
export function getUrlParam(key: string): string | null {
	if (!browser) {
		return null;
	}

	const url = new URL(window.location.href);
	return url.searchParams.get(key);
}

/**
 * Set a specific URL parameter
 */
export function setUrlParam(key: string, value: string): void {
	if (!browser) {
		return;
	}

	const url = new URL(window.location.href);
	url.searchParams.set(key, value);
	window.history.replaceState({}, '', url.toString());
}
