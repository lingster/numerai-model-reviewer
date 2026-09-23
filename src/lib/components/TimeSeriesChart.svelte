<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { browser } from '$app/environment';
	import { LayerCake, Svg } from 'layercake';
	import { scaleTime, scaleLinear, type ScaleTime, type ScaleLinear } from 'd3-scale';
	import { line, curveMonotoneX } from 'd3-shape';
	import type { ModelPerformance, ChartMetric, ModelSeries, ChartDataPoint } from '$lib/types.js';
	import { invertVisibility, setAllVisible } from '$lib/utils/series-visibility.js';
	import { focusedSeriesColor, orderForFocus, toggleFocus } from '$lib/utils/series-focus.js';
	import { getDefaultFormulaForTournament } from '$lib/rankings-api.js';
	import { TOURNAMENTS } from '$lib/utils/storage.js';
	import {
		SCORE_ALPHA_WEIGHT,
		SCORE_MPC_WEIGHT,
		SIGNALS_METRIC_SETS,
		NEUTRAL_SCORES_FROM_ROUND,
		computeChartScore,
		resolveScoringMode,
		scoringModesFor,
		hasNoNeutralData,
		getMetricSetDefinition,
		type ChartScoringMode
	} from '$lib/utils/scoring.js';

	// Alpha/MPC and Neutral labels for the score-formula controls below come
	// from the shared metric sets (scoring.ts) so they can't drift from the
	// rankings page's own labels for the same pairs.
	const alphaMpcCorrLabel = SIGNALS_METRIC_SETS.alpha_mpc.corrLabel;
	const alphaMpcMmcLabel = SIGNALS_METRIC_SETS.alpha_mpc.mmcLabel;
	const neutralCorrLabel = SIGNALS_METRIC_SETS.neutral.corrLabel;
	const neutralMmcLabel = SIGNALS_METRIC_SETS.neutral.mmcLabel;

	// Props
	let {
		modelPerformance = [],
		startDate = '',
		endDate = ''
	}: {
		modelPerformance: ModelPerformance[];
		startDate: string;
		endDate: string;
	} = $props();

	// Color palette for models - distinct from metric colors. Paired with
	// dashPatterns below: colour cycles every 20 models and dash every 8, so a
	// model's (colour, dash) pair only repeats after 40.
	const modelColorPalette = [
		'#1e90ff', // dodger blue
		'#dc143c', // crimson
		'#00ced1', // dark turquoise
		'#ff69b4', // hot pink
		'#32cd32', // lime green
		'#ffa500', // orange
		'#9370db', // medium purple
		'#20b2aa', // light sea green
		'#ff6347', // tomato
		'#ba55d3', // medium orchid
		'#3cb371', // medium sea green
		'#ff8c00', // dark orange
		'#9400d3', // dark violet
		'#00fa9a', // medium spring green
		'#ff1493', // deep pink
		'#4169e1', // royal blue
		'#8a2be2', // blue violet
		'#00bfff', // deep sky blue
		'#adff2f', // green yellow
		'#ff4500'  // orange red
	];

	// Line dash patterns to distinguish lines with the same color
	const dashPatterns = [
		'none',           // solid
		'5,5',            // dashed
		'2,2',            // dotted
		'8,4,2,4',        // dash-dot
		'10,2',           // long dash
		'2,4',            // loose dot
		'6,3,2,3',        // medium-dash-dot
		'4,8'             // short spaced
	];

	// Available metrics with labels and axis assignment
	const metricConfig: Record<ChartMetric, { label: string; axis: 'left' | 'right'; color: string }> = {
		corr20: { label: 'Corr20', axis: 'left', color: '#4daf4a' },
		corr60: { label: 'Corr60', axis: 'left', color: '#377eb8' },
		mmc: { label: 'MMC', axis: 'left', color: '#e41a1c' },
		mmc60: { label: 'MMC60', axis: 'left', color: '#ff7f00' },
		fnc: { label: 'FNC', axis: 'left', color: '#984ea3' },
		payout: { label: 'Payout', axis: 'right', color: '#a65628' },
		// New Numerai scoring (Signals): alpha/mpc (today's payout pair) and
		// ncorr/nmmc (the neutral pair Numerai pays on from 2026-09-25). Labels
		// come from SIGNALS_METRIC_SETS so they can't drift from scoring.ts.
		alpha: { label: alphaMpcCorrLabel, axis: 'left', color: '#00c0d0' },
		mpc: { label: alphaMpcMmcLabel, axis: 'left', color: '#ffb300' },
		ncorr: { label: neutralCorrLabel, axis: 'left', color: '#c0ca33' },
		nmmc: { label: neutralMmcLabel, axis: 'left', color: '#5c6bc0' },
		score: { label: 'Score', axis: 'left', color: '#e91e63' }
	};

	// Every metric, and the two axis groups, derived from metricConfig so that
	// adding or removing a metric there is the only edit required.
	const ALL_METRICS = Object.keys(metricConfig) as ChartMetric[];
	const LEFT_METRICS = ALL_METRICS.filter(m => metricConfig[m].axis === 'left');
	const RIGHT_METRICS = ALL_METRICS.filter(m => metricConfig[m].axis === 'right');

	// Metrics shown in each scoring mode. Classic switched its scoring target from
	// the 20-day to the 60-day window on 28 Aug, so Corr60/MMC60 are the default
	// pair; the 20-day series stay available as individual toggles.
	const CLASSIC_METRICS: ChartMetric[] = ['corr60', 'mmc60'];
	const ALPHA_MPC_METRICS: ChartMetric[] = ['alpha', 'mpc', 'score'];
	const NEUTRAL_METRICS: ChartMetric[] = ['ncorr', 'nmmc', 'score'];
	// Metrics that only apply to Signals — hidden from the generic metric-toggle
	// row entirely unless hasNewMetrics (below) says this data is Signals.
	const SIGNALS_ONLY_METRICS: ChartMetric[] = ['alpha', 'mpc', 'ncorr', 'nmmc'];

	// State for metric toggles - default to the Classic (60-day) pair.
	let activeMetrics = $state<Set<ChartMetric>>(new Set(CLASSIC_METRICS));

	// Which scoring mode is selected: 'classic' has no weighted score of its
	// own, so its Score (when toggled on) and the weight editor below both fall
	// back to the alpha_mpc pair, matching this chart's long-standing default.
	let scoringMode = $state<ChartScoringMode>('classic');


	// Calculated score weights — default to the active mode's Numerai Signals
	// weights (0.3*alpha + 0.8*mpc, or 0.5*ncorr + 2*nmmc for neutral).
	// Adjustable so the score can track future scoring-rule changes.
	let scoreCorrWeight = $state(SCORE_ALPHA_WEIGHT);
	let scoreMmcWeight = $state(SCORE_MPC_WEIGHT);

	// Labels for whichever pair currently drives the Score metric and its
	// weight editor — the pair the selected mode actually scores on, so the
	// editor never shows one pair's numbers scoring another.
	const activeScoreLabels = $derived(
		scoringMode === 'neutral'
			? SIGNALS_METRIC_SETS.neutral
			: scoringMode === 'classic'
				? { corrLabel: metricConfig.corr60.label, mmcLabel: metricConfig.mmc60.label }
				: SIGNALS_METRIC_SETS.alpha_mpc
	);

	// State for model visibility
	let modelVisibility = $state<Map<string, boolean>>(new Map());
	// The model singled out by clicking one of its points, and what was visible
	// before that — see focusModel.
	let focusedModelId = $state<string | null>(null);
	let visibilityBeforeFocus: Map<string, boolean> | null = null;

	// Toggle unresolved rounds
	let showUnresolved = $state(false);

	// Toggle cumulative chart view
	let showCumulative = $state(false);

	// Toggle line colors: metric colors (default) vs model colors
	let useMetricColors = $state(true);

	const CHART_PREFS_KEY = 'numerai_chart_preferences';
	let prefsLoaded = $state(false);

	// Tooltip state
	let tooltipData = $state<{
		visible: boolean;
		x: number;
		y: number;
		align: 'left' | 'center' | 'right';
		modelName: string;
		username: string;
		roundNumber: number;
		date: Date;
		resolved: boolean;
		/** The metric whose line the pointer is on — highlighted in the list below. */
		hoveredMetric: ChartMetric;
		metrics: Record<string, number | null>;
	} | null>(null);

	// Raw data table expanded state
	let showRawData = $state(false);

	// Zoom/Brush state
	let zoomedDomain = $state<[Date, Date] | null>(null);
	let isDragging = $state(false);
	let dragStart = $state<number | null>(null);
	let dragEnd = $state<number | null>(null);
	let dragCursorY = $state<number>(0);

	// Brush dimensions
	const brushHeight = 60;
	const brushMarginTop = 10;

	// Initialize model visibility when performance data changes
	$effect(() => {
		const newVisibility = new Map<string, boolean>();
		// Use untrack to read modelVisibility without creating a dependency
		// This prevents an infinite loop where writing to modelVisibility triggers the effect again
		const currentVisibility = untrack(() => modelVisibility);
		modelPerformance.forEach((model) => {
			newVisibility.set(model.modelId, currentVisibility.get(model.modelId) ?? true);
		});
		modelVisibility = newVisibility;
	});

	// Extended model series type with dash pattern
	interface ExtendedModelSeries extends ModelSeries {
		dashPattern: string;
	}

	function toNumber(value: unknown): number | null {
		if (value === null || value === undefined) return null;
		const num = typeof value === 'number' ? value : Number(value);
		return Number.isFinite(num) ? num : null;
	}

	function parseDateInput(value: string, mode: 'start' | 'end'): Date | null {
		if (!value) return null;
		const iso = mode === 'end'
			? `${value}T23:59:59.999Z`
			: `${value}T00:00:00.000Z`;
		const parsed = new Date(iso);
		return Number.isNaN(parsed.getTime()) ? null : parsed;
	}

	// Convert model performance to chart series data
	const chartSeries = $derived.by(() => {
		const parsedStartDate = parseDateInput(startDate, 'start');
		const parsedEndDate = parseDateInput(endDate, 'end');
		const series: ExtendedModelSeries[] = [];

		modelPerformance.forEach((model, index) => {
			const data: ChartDataPoint[] = model.rounds
				.filter(round => {
					// Filter by resolved status - but keep rounds with actual data even if not officially resolved
					if (!showUnresolved && !round.roundResolved) {
						// Only filter out if there's no actual performance data
						// mmc60 is deliberately excluded: it is a trailing average derived
						// from earlier rounds, so it is non-null even for a round that has
						// no scores of its own and would wrongly keep empty rounds here.
						const hasMetric = round.correlation !== null
							|| round.mmc !== null
							|| round.corr60 !== null
							|| round.fnc !== null
							|| round.payout !== null
							|| round.alpha != null
							|| round.mpc != null
							|| round.neutralCorr != null
							|| round.neutralMmc != null;
						if (!hasMetric) return false;
					}

					// Filter by date range
					if (round.roundOpenTime) {
						const roundDate = new Date(round.roundOpenTime);
						if (parsedStartDate && roundDate < parsedStartDate) return false;
						if (parsedEndDate && roundDate > parsedEndDate) return false;
					}
					return true;
				})
				.map(round => {
					const alpha = toNumber(round.alpha);
					const mpc = toNumber(round.mpc);
					const ncorr = toNumber(round.neutralCorr);
					const nmmc = toNumber(round.neutralMmc);
					// Weighted score for whichever mode is selected; null only when
					// both of that mode's components are absent.
					const score = computeChartScore(
						scoringMode,
						{ alpha, mpc, ncorr, nmmc, corr60: toNumber(round.corr60), mmc60: toNumber(round.mmc60) },
						scoreCorrWeight,
						scoreMmcWeight
					);
					return {
						roundNumber: round.roundNumber,
						date: round.roundOpenTime ? new Date(round.roundOpenTime) : new Date(),
						resolved: round.roundResolved ?? false,
						corr20: toNumber(round.correlation),
						corr60: toNumber(round.corr60),
						mmc: toNumber(round.mmc),
						mmc60: toNumber(round.mmc60),
						fnc: toNumber(round.fnc),
						payout: toNumber(round.payout),
						alpha,
						mpc,
						ncorr,
						nmmc,
						score
					};
				})
				.sort((a, b) => a.date.getTime() - b.date.getTime());

			series.push({
				modelId: model.modelId,
				modelName: model.modelName,
				username: model.username,
				color: modelColorPalette[index % modelColorPalette.length],
				dashPattern: dashPatterns[index % dashPatterns.length],
				visible: modelVisibility.get(model.modelId) ?? true,
				data
			});
		});

		return series;
	});

	const chartSeriesDisplay = $derived.by(() => {
		if (!showCumulative) return chartSeries;

		return chartSeries.map(series => {
			// Running total per metric, null until that metric's first finite value —
			// so a metric with no data yet stays absent rather than plotting as 0.
			const runningTotals = Object.fromEntries(
				ALL_METRICS.map(m => [m, null])
			) as Record<ChartMetric, number | null>;

			const data = series.data.map(point => {
				const nextPoint: ChartDataPoint = { ...point };

				ALL_METRICS.forEach(metric => {
					const value = point[metric];
					if (typeof value === 'number' && Number.isFinite(value)) {
						runningTotals[metric] = (runningTotals[metric] ?? 0) + value;
					}

					nextPoint[metric] = runningTotals[metric];
				});

				return nextPoint;
			});

			return { ...series, data };
		});
	});

	// Get all data points for scale calculation
	const allDataPoints = $derived.by(() => {
		return chartSeriesDisplay
			.filter(s => s.visible)
			.flatMap(s => s.data);
	});

	// New scoring (alpha/mpc) is only present for Signals models — used to gate
	// the Classic/New/Neutral toggle and the score-weight controls. Neutral
	// scores ride along on the same gate rather than a tournament prop, so
	// they only appear where the existing Alpha/MPC set does.
	const hasNewMetrics = $derived(
		allDataPoints.some(p => p.alpha !== null || p.mpc !== null)
	);
	// Which modes this data offers, and their labels. Signals is not scored on
	// corr60/mmc60, so Classic is not offered there — see scoringModesFor.
	const scoringModes = $derived(scoringModesFor(hasNewMetrics));
	const scoringModeLabels: Record<ChartScoringMode, string> = {
		classic: 'Classic (Corr60/MMC60)',
		alpha_mpc: `New (${alphaMpcCorrLabel}/${alphaMpcMmcLabel})`,
		neutral: `Neutral (${neutralCorrLabel}/${neutralMmcLabel})`
	};

	// Selecting models of another tournament changes which modes exist; never
	// leave the chart on one its toggle no longer shows.
	$effect(() => {
		const resolved = resolveScoringMode(scoringMode, hasNewMetrics);
		if (resolved !== scoringMode) setScoringMode(resolved);
	});

	// Empty-data honesty: only warn when Neutral is selected AND the visible
	// range genuinely has no neutral values (rather than assuming from the
	// round-number cutoff, which the chart's zoomed/date-filtered view may not
	// reflect).
	const showNeutralDataHint = $derived(
		scoringMode === 'neutral' && hasNoNeutralData(allDataPoints)
	);

	// True when any right-axis metric is active — gates the whole right axis.
	const hasRightAxis = $derived(RIGHT_METRICS.some(m => activeMetrics.has(m)));

	// Calculate domains for left and right axes
	const leftAxisDomain = $derived.by(() => {
		const activeLeftMetrics = LEFT_METRICS.filter(m => activeMetrics.has(m));

		if (activeLeftMetrics.length === 0 || allDataPoints.length === 0) {
			return [-0.05, 0.05];
		}

		let min = Infinity;
		let max = -Infinity;

		allDataPoints.forEach(point => {
			activeLeftMetrics.forEach(metric => {
				const value = point[metric];
				if (typeof value === 'number' && Number.isFinite(value)) {
					min = Math.min(min, value);
					max = Math.max(max, value);
				}
			});
		});

		if (min === Infinity) return [-0.05, 0.05];

		const padding = (max - min) * 0.1 || 0.01;
		return [min - padding, max + padding];
	});

	const rightAxisDomain = $derived.by(() => {
		const activeRightMetrics = RIGHT_METRICS.filter(m => activeMetrics.has(m));

		if (activeRightMetrics.length === 0 || allDataPoints.length === 0) {
			return [0, 1];
		}

		let min = Infinity;
		let max = -Infinity;

		allDataPoints.forEach(point => {
			activeRightMetrics.forEach(metric => {
				const value = point[metric];
				if (typeof value === 'number' && Number.isFinite(value)) {
					min = Math.min(min, value);
					max = Math.max(max, value);
				}
			});
		});

		if (min === Infinity) return [0, 1];

		const padding = (max - min) * 0.1 || 0.1;
		return [min - padding, max + padding];
	});

	// Full X domain (time) - used for brush overview
	const fullXDomainDates = $derived.by(() => {
		const parsedStartDate = parseDateInput(startDate, 'start');
		const parsedEndDate = parseDateInput(endDate, 'end');

		if (allDataPoints.length === 0) {
			const now = new Date();
			const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
			return [
				parsedStartDate ?? monthAgo,
				parsedEndDate ?? now
			] as [Date, Date];
		}

		const dates = allDataPoints.map(d => d.date);
		const dataStart = new Date(Math.min(...dates.map(d => d.getTime())));
		const dataEnd = new Date(Math.max(...dates.map(d => d.getTime())));
		const domainStart = parsedStartDate ?? dataStart;
		const domainEnd = parsedEndDate ?? dataEnd;

		if (domainStart.getTime() > domainEnd.getTime()) {
			return [dataStart, dataEnd] as [Date, Date];
		}

		return [domainStart, domainEnd] as [Date, Date];
	});

	// X domain (time) - uses zoomed domain when active
	const xDomainDates = $derived.by(() => {
		if (zoomedDomain) {
			return zoomedDomain;
		}
		return fullXDomainDates;
	});

	// X accessor function with explicit type
	function getX(d: ChartDataPoint): Date {
		return d.date;
	}

	// Unresolved round regions for background highlighting
	const unresolvedRegions = $derived.by(() => {
		if (!showUnresolved) return [];

		const regions: { start: Date; end: Date }[] = [];
		const unresolvedPoints = allDataPoints.filter(p => !p.resolved);

		if (unresolvedPoints.length === 0) return [];

		// Group consecutive unresolved rounds
		let currentStart: Date | null = null;
		let currentEnd: Date | null = null;

		const sortedPoints = [...unresolvedPoints].sort((a, b) => a.date.getTime() - b.date.getTime());

		sortedPoints.forEach((point, i) => {
			if (!currentStart) {
				currentStart = point.date;
				currentEnd = point.date;
			} else {
				const daysDiff = (point.date.getTime() - currentEnd!.getTime()) / (24 * 60 * 60 * 1000);
				if (daysDiff <= 7) {
					currentEnd = point.date;
				} else {
					regions.push({ start: currentStart, end: currentEnd! });
					currentStart = point.date;
					currentEnd = point.date;
				}
			}

			if (i === sortedPoints.length - 1 && currentStart) {
				regions.push({ start: currentStart, end: currentEnd! });
			}
		});

		return regions;
	});

	// Switch the active metric set between Classic (corr60/mmc60), New
	// (alpha/mpc/score) and Neutral (ncorr/nmmc/score). Switching into a
	// Signals metric set also resets the score weights to that set's defaults
	// (mirrors getDefaultFormulaForTournament on the rankings page), so the
	// weight editor never silently shows one pair's numbers scoring another.
	function setScoringMode(mode: ChartScoringMode) {
		activeMetrics = new Set<ChartMetric>(
			mode === 'classic' ? CLASSIC_METRICS : mode === 'neutral' ? NEUTRAL_METRICS : ALPHA_MPC_METRICS
		);
		scoringMode = mode;
		const weights =
			mode === 'classic'
				? getDefaultFormulaForTournament(TOURNAMENTS.CLASSIC)
				: getMetricSetDefinition(mode);
		scoreCorrWeight = weights.corrWeight;
		scoreMmcWeight = weights.mmcWeight;
	}

	// Toggle metric
	function toggleMetric(metric: ChartMetric) {
		const newSet = new Set(activeMetrics);
		if (newSet.has(metric)) {
			newSet.delete(metric);
		} else {
			newSet.add(metric);
		}
		activeMetrics = newSet;
	}

	// Toggle model visibility
	function toggleModel(modelId: string) {
		const newMap = new Map(modelVisibility);
		newMap.set(modelId, !newMap.get(modelId));
		modelVisibility = newMap;
	}

	// Bulk visibility, shared with the rankings chart (series-visibility.ts) and
	// converted here because this chart keeps its state in a Map. Fifty models is
	// a normal selection; picking a few of them should not be fifty clicks.
	const modelIds = $derived(chartSeries.map((s) => s.modelId));
	// Painting order for the plot: the focused model last, so the greyed lines
	// cannot overdraw the one being studied.
	const seriesInDrawOrder = $derived(
		orderForFocus(
			chartSeriesDisplay.filter((s) => s.visible),
			focusedModelId,
			(s) => s.modelId
		)
	);
	const shownCount = $derived(chartSeries.filter((s) => s.visible).length);

	function setAllModels(visible: boolean) {
		modelVisibility = new Map(Object.entries(setAllVisible(modelIds, visible)));
	}

	function invertModels() {
		modelVisibility = new Map(
			Object.entries(invertVisibility(modelIds, Object.fromEntries(modelVisibility)))
		);
	}

	// Format number for tooltip
	function formatValue(value: number | null | undefined): string {
		if (value === null || value === undefined || typeof value !== 'number' || isNaN(value)) return 'N/A';
		return value.toFixed(4);
	}

	// Format date for display
	function formatDate(date: Date): string {
		return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
	}

	function getLineColor(series: ExtendedModelSeries, metric: ChartMetric): string {
		const base = useMetricColors ? metricConfig[metric].color : series.color;
		// One place decides colour, so focusing greys the lines and their points
		// together without either forgetting.
		return focusedSeriesColor(base, series.modelId, focusedModelId);
	}

	/**
	 * Clicking a point singles that model out; clicking it again puts the chart
	 * back as it was. The visible set is remembered on the way in, so legend
	 * changes made while focused do not survive the trip back — what returns is
	 * what the person was looking at before.
	 */
	function focusModel(modelId: string) {
		const next = toggleFocus(focusedModelId, modelId);
		if (next === null) {
			if (visibilityBeforeFocus) modelVisibility = new Map(visibilityBeforeFocus);
			visibilityBeforeFocus = null;
		} else if (focusedModelId === null) {
			visibilityBeforeFocus = new Map(modelVisibility);
		}
		focusedModelId = next;
	}

	// Tooltip handlers
	function showTooltip(
		event: MouseEvent,
		series: ExtendedModelSeries,
		point: ChartDataPoint,
		hoveredMetric: ChartMetric
	) {
		if (!chartContainer) return;
		const containerRect = chartContainer.getBoundingClientRect();
		const rawX = event.clientX - containerRect.left;
		const rawY = event.clientY - containerRect.top - 10;
		const edgeThreshold = 140;
		const tooltipPadding = 12;
		const align = rawX < edgeThreshold
			? 'left'
			: rawX > chartWidth - edgeThreshold
				? 'right'
				: 'center';

		const x = align === 'left'
			? Math.min(rawX + tooltipPadding, chartWidth - tooltipPadding)
			: align === 'right'
				? Math.max(rawX - tooltipPadding, tooltipPadding)
				: rawX;

		tooltipData = {
			visible: true,
			x,
			y: rawY,
			align,
			modelName: series.modelName,
			username: series.username,
			roundNumber: point.roundNumber,
			date: point.date,
			resolved: point.resolved,
			// Which line the pointer is actually on, so the tooltip can say which of
			// its rows the reader came for.
			hoveredMetric,
			metrics: Object.fromEntries(ALL_METRICS.map(m => [m, point[m]]))
		};
	}

	function hideTooltip() {
		tooltipData = null;
	}

	// Brush interaction handlers
	function handleBrushMouseDown(event: MouseEvent) {
		if (!chartContainer) return;
		const rect = chartContainer.getBoundingClientRect();
		const x = event.clientX - rect.left;
		isDragging = true;
		dragStart = x;
		dragEnd = x;
	}

	function handleBrushMouseMove(event: MouseEvent) {
		if (!isDragging || !chartContainer) return;
		const rect = chartContainer.getBoundingClientRect();
		const x = Math.max(marginLeft, Math.min(event.clientX - rect.left, chartWidth - marginRight));
		dragEnd = x;
		dragCursorY = event.clientY - rect.top;
	}

	function handleBrushMouseUp() {
		if (!isDragging || dragStart === null || dragEnd === null) {
			isDragging = false;
			return;
		}

		const startX = Math.min(dragStart, dragEnd);
		const endX = Math.max(dragStart, dragEnd);

		// Only zoom if selection is meaningful (more than 10 pixels)
		if (endX - startX > 10) {
			// Create a temporary scale for inversion
			const tempScale = scaleTime()
				.domain(fullXDomainDates)
				.range([marginLeft, chartWidth - marginRight]);
			const startDate = tempScale.invert(startX);
			const endDate = tempScale.invert(endX);
			zoomedDomain = [startDate, endDate];
		}

		isDragging = false;
		dragStart = null;
		dragEnd = null;
	}

	function resetZoom() {
		zoomedDomain = null;
	}

	// Find the closest round info for a given x position
	function getRoundInfoAtX(xPos: number): { roundNumber: number; date: Date } | null {
		if (allDataPoints.length === 0) return null;

		const tempScale = scaleTime()
			.domain(fullXDomainDates)
			.range([marginLeft, chartWidth - marginRight]);

		const targetDate = tempScale.invert(xPos);
		const targetTime = targetDate.getTime();

		// Find the closest data point
		let closest = allDataPoints[0];
		let closestDiff = Math.abs(closest.date.getTime() - targetTime);

		for (const point of allDataPoints) {
			const diff = Math.abs(point.date.getTime() - targetTime);
			if (diff < closestDiff) {
				closest = point;
				closestDiff = diff;
			}
		}

		return { roundNumber: closest.roundNumber, date: closest.date };
	}

	// Format short date for tooltip
	function formatShortDate(date: Date): string {
		return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
	}

	// Derived drag tooltip info
	const dragTooltipInfo = $derived.by(() => {
		if (!isDragging || dragStart === null || dragEnd === null) return null;

		const startInfo = getRoundInfoAtX(Math.min(dragStart, dragEnd));
		const endInfo = getRoundInfoAtX(Math.max(dragStart, dragEnd));

		if (!startInfo || !endInfo) return null;

		return {
			startRound: startInfo.roundNumber,
			startDate: startInfo.date,
			endRound: endInfo.roundNumber,
			endDate: endInfo.date,
			x: Math.max(dragStart, dragEnd),
			y: dragCursorY
		};
	});

	// Calculate X axis ticks (round numbers)
	const xAxisTicks = $derived.by(() => {
		if (allDataPoints.length === 0) return [];

		// Get unique round numbers sorted
		const rounds = [...new Set(allDataPoints.map(d => d.roundNumber))].sort((a, b) => a - b);

		// Show at most 10 ticks
		const maxTicks = 10;
		if (rounds.length <= maxTicks) return rounds;

		// Sample evenly
		const step = Math.ceil(rounds.length / maxTicks);
		return rounds.filter((_, i) => i % step === 0 || i === rounds.length - 1);
	});

	// Calculate Y axis ticks for left axis
	const leftAxisTicks = $derived.by(() => {
		const [min, max] = leftAxisDomain;
		const range = max - min;
		const tickCount = 5;
		const step = range / (tickCount - 1);
		const ticks: number[] = [];
		for (let i = 0; i < tickCount; i++) {
			ticks.push(min + step * i);
		}
		return ticks;
	});

	// Calculate Y axis ticks for right axis
	const rightAxisTicks = $derived.by(() => {
		const [min, max] = rightAxisDomain;
		const range = max - min;
		const tickCount = 5;
		const step = range / (tickCount - 1);
		const ticks: number[] = [];
		for (let i = 0; i < tickCount; i++) {
			ticks.push(min + step * i);
		}
		return ticks;
	});

	// Get all raw data for the expandable table
	const rawTableData = $derived.by(() => {
		const data: Array<ChartDataPoint & { modelName: string; username: string }> = [];

		chartSeries.filter(series => series.visible).forEach(series => {
			series.data.forEach(point => {
				data.push({ modelName: series.modelName, username: series.username, ...point });
			});
		});

		// Sort by round number descending, then by model name
		return data.sort((a, b) => {
			if (b.roundNumber !== a.roundNumber) return b.roundNumber - a.roundNumber;
			return a.modelName.localeCompare(b.modelName);
		});
	});

	// Chart dimensions
	const chartHeight = 450;
	const marginTop = 30;
	const marginBottom = 70;

	let chartContainer: HTMLDivElement | null = $state(null);
	let chartWidth = $state(800);

	// Shrink the side gutters on narrow (mobile) viewports so the plot uses the
	// full width instead of losing 140px to the fixed 70px axis margins.
	const isNarrow = $derived(chartWidth < 640);
	const marginRight = $derived(isNarrow ? 44 : 70);
	const marginLeft = $derived(isNarrow ? 44 : 70);

	// Brush scale for the overview area (must be after chartWidth/margin definitions)
	const brushScale = $derived(
		scaleTime()
			.domain(fullXDomainDates)
			.range([marginLeft, chartWidth - marginRight])
	);

	// Brush Y scale for mini chart
	const brushYScale = $derived(
		scaleLinear()
			.domain(leftAxisDomain)
			.range([brushHeight, 5])
	);

	// Calculate brush selection rectangle position
	const brushSelectionRect = $derived.by(() => {
		if (!zoomedDomain) return null;

		const x1 = brushScale(zoomedDomain[0]);
		const x2 = brushScale(zoomedDomain[1]);

		return {
			x: Math.min(x1, x2),
			width: Math.abs(x2 - x1)
		};
	});

	onMount(() => {
		if (browser) {
			try {
				const stored = localStorage.getItem(CHART_PREFS_KEY);
				if (stored) {
					const parsed = JSON.parse(stored) as {
						showCumulative?: boolean;
						showUnresolved?: boolean;
						useMetricColors?: boolean;
					};

					if (typeof parsed.showCumulative === 'boolean') {
						showCumulative = parsed.showCumulative;
					}

					if (typeof parsed.showUnresolved === 'boolean') {
						showUnresolved = parsed.showUnresolved;
					}

					if (typeof parsed.useMetricColors === 'boolean') {
						useMetricColors = parsed.useMetricColors;
					}
				}
			} catch (error) {
				console.error('Error loading chart preferences:', error);
			}
		}

		prefsLoaded = true;

		if (!chartContainer || typeof ResizeObserver === 'undefined') return;

		const observer = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (!entry) return;
			const width = entry.contentRect.width;
			if (width > 0) {
				chartWidth = Math.max(320, Math.floor(width));
			}
		});

		observer.observe(chartContainer);
		return () => observer.disconnect();
	});

	$effect(() => {
		if (!browser || !prefsLoaded) return;

		try {
			localStorage.setItem(
				CHART_PREFS_KEY,
				JSON.stringify({
					showCumulative,
					showUnresolved,
					useMetricColors
				})
			);
		} catch (error) {
			console.error('Error saving chart preferences:', error);
		}
	});
</script>

<!-- Signed numeric cell used by every metric column of the raw-data table (DRY):
     green when positive, red when negative, muted when the value is missing. -->
{#snippet metricCell(value: number | null)}
	<td
		class="px-4 py-2 text-sm text-right font-mono {value !== null
			? value > 0
				? 'text-green-400'
				: value < 0
					? 'text-red-400'
					: 'retro-text-primary'
			: 'retro-text-secondary'}">{formatValue(value)}</td>
{/snippet}

<div class="time-series-chart">
	<!-- Model Legend (Interactive) - Now on top -->
	{#if chartSeries.length > 0}
		<div class="mb-4">
			<span class="text-sm font-medium retro-text-primary mr-2">
				Models ({shownCount}/{chartSeries.length}):
			</span>
			<div class="mr-2 inline-flex overflow-hidden rounded-md border-2 border-[var(--retro-primary)] align-middle">
				{#each [{ label: 'All', run: () => setAllModels(true) }, { label: 'None', run: () => setAllModels(false) }, { label: 'Invert', run: invertModels }] as action}
					<button
						onclick={action.run}
						class="px-2.5 py-1 text-xs font-medium transition-colors"
						style="color: var(--retro-text-primary);"
					>
						{action.label}
					</button>
				{/each}
			</div>
			<div class="inline-flex flex-wrap gap-2">
				{#each chartSeries as series}
					<button
						onclick={() => toggleModel(series.modelId)}
						class="px-3 py-1 text-sm rounded-md border-2 transition-all flex items-center gap-2 whitespace-nowrap"
						style="border-color: {series.color}; {series.visible ? `background-color: ${series.color}20;` : 'opacity: 0.4;'}"
					>
						<!-- Line pattern indicator -->
						<svg width="20" height="10" class="flex-shrink-0">
							<line
								x1="0" y1="5" x2="20" y2="5"
								stroke={series.color}
								stroke-width="2"
								stroke-dasharray={series.dashPattern}
							/>
						</svg>
						<span class="retro-text-primary">{series.modelName}</span>
						<span class="text-xs retro-text-secondary">({series.username})</span>
					</button>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Scoring mode toggle + score weights. Shown for every tournament: Classic
	     scores on corr60/mmc60, Signals on alpha/mpc or the neutral pair. -->
	{#if chartSeries.length > 0}
		<div class="mb-4 rounded-md border-2 border-[var(--retro-primary)] p-3">
			<div class="flex flex-wrap items-center gap-4">
				<span class="text-sm font-medium retro-text-primary">Scoring:</span>
				<div class="inline-flex overflow-hidden rounded-md border-2 border-[var(--retro-primary)]">
					{#each scoringModes as mode}
						<button
							onclick={() => setScoringMode(mode)}
							class="px-3 py-1 text-sm font-medium transition-colors"
							style={scoringMode === mode
								? 'background-color: var(--retro-primary); color: white;'
								: 'color: var(--retro-text-primary);'}
						>
							{scoringModeLabels[mode]}
						</button>
					{/each}
				</div>

				<div class="flex items-center gap-2">
					<span class="text-sm retro-text-secondary">Score =</span>
					<input
						type="number"
						step="0.1"
						bind:value={scoreCorrWeight}
						aria-label="{activeScoreLabels.corrLabel} weight"
						class="retro-input w-16 rounded px-2 py-1 text-sm"
					/>
					<span class="text-sm retro-text-secondary">× {activeScoreLabels.corrLabel} +</span>
					<input
						type="number"
						step="0.1"
						bind:value={scoreMmcWeight}
						aria-label="{activeScoreLabels.mmcLabel} weight"
						class="retro-input w-16 rounded px-2 py-1 text-sm"
					/>
					<span class="text-sm retro-text-secondary">× {activeScoreLabels.mmcLabel}</span>
				</div>
			</div>
			{#if showNeutralDataHint}
				<p class="mt-2 text-xs retro-text-warning">
					Neutral scores start at round {NEUTRAL_SCORES_FROM_ROUND} — none of the selected range has neutral data yet.
				</p>
			{/if}
		</div>
	{/if}

	<!-- Metric Toggle Buttons -->
	<div class="mb-4">
		<span class="text-sm font-medium retro-text-primary mr-2">Metrics:</span>
		<div class="inline-flex flex-wrap gap-2">
			{#each Object.entries(metricConfig) as [metric, config]}
				{#if hasNewMetrics || !SIGNALS_ONLY_METRICS.includes(metric as ChartMetric)}
					<button
						onclick={() => toggleMetric(metric as ChartMetric)}
						class="px-3 py-1 text-sm rounded-md border-2 transition-colors"
						class:active={activeMetrics.has(metric as ChartMetric)}
						style="--metric-color: {config.color}; border-color: {config.color}; {activeMetrics.has(metric as ChartMetric) ? `background-color: ${config.color}; color: white;` : 'color: var(--retro-text-primary);'}"
					>
						{config.label}
						{#if config.axis === 'right'}
							<span class="text-xs opacity-70">(R)</span>
						{/if}
					</button>
				{/if}
			{/each}
		</div>
		<div class="mt-2 flex flex-wrap items-center gap-4">
			<div class="flex items-center gap-2">
				<label for="toggle-cumulative" class="text-sm retro-text-primary cursor-pointer">
					Cumulative over time
				</label>
				<input
					id="toggle-cumulative"
					type="checkbox"
					bind:checked={showCumulative}
					class="h-4 w-4 rounded border-[var(--retro-light-grey)] text-[var(--retro-crimson)] focus:ring-[var(--retro-crimson)]"
				/>
			</div>
			<div class="flex items-center gap-2">
				<label for="toggle-unresolved" class="text-sm retro-text-primary cursor-pointer">
					Show unresolved rounds
				</label>
				<input
					id="toggle-unresolved"
					type="checkbox"
					bind:checked={showUnresolved}
					class="h-4 w-4 rounded border-[var(--retro-light-grey)] text-[var(--retro-crimson)] focus:ring-[var(--retro-crimson)]"
				/>
			</div>
			<div class="flex items-center gap-2">
				<label for="toggle-line-colors" class="text-sm retro-text-primary cursor-pointer">
					Color lines by metric
				</label>
				<input
					id="toggle-line-colors"
					type="checkbox"
					bind:checked={useMetricColors}
					class="h-4 w-4 rounded border-[var(--retro-light-grey)] text-[var(--retro-crimson)] focus:ring-[var(--retro-crimson)]"
				/>
			</div>
		</div>
	</div>

	<!-- Chart Container -->
	{#if allDataPoints.length > 0}
		{@const yScaleLeft = scaleLinear().domain(leftAxisDomain).range([chartHeight - marginBottom, marginTop])}
		{@const yScaleRight = scaleLinear().domain(rightAxisDomain).range([chartHeight - marginBottom, marginTop])}
		{@const xScale = scaleTime().domain(xDomainDates).range([marginLeft, chartWidth - marginRight])}

		<div
			class="chart-container relative p-2 md:p-8"
			style="height: {chartHeight}px;"
			bind:this={chartContainer}
		>
			<!-- Tooltip -->
			{#if tooltipData?.visible}
				<div
					class="tooltip absolute pointer-events-none p-1 md:p-8"
					style="left: {tooltipData.x}px; top: {tooltipData.y}px; z-index: 9999; transform: {tooltipData.align === 'left' ? 'translate(0, -100%)' : tooltipData.align === 'right' ? 'translate(-100%, -100%)' : 'translate(-50%, -100%)'};"
				>
					<div class="rounded-lg shadow-xl p1 md:p-8 text-sm min-w-48" style="background-color: #111111; border: 2px solid #666666;">
						<div class="font-semibold text-white mb-1">{tooltipData.modelName}</div>
						<div class="text-gray-400 text-xs mb-2">by {tooltipData.username}</div>
						<div class="border-t border-gray-700 pt-2 space-y-1">
							<div class="flex justify-between">
								<span class="text-gray-400">Round:</span>
								<span class="text-white font-mono">{tooltipData.roundNumber}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-gray-400">Date:</span>
								<span class="text-white font-mono text-xs">{formatDate(tooltipData.date)}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-gray-400">Status:</span>
								<span class="{tooltipData.resolved ? 'text-green-400' : 'text-yellow-400'}">{tooltipData.resolved ? 'Resolved' : 'Pending'}</span>
							</div>
							<div class="border-t border-gray-700 pt-1 mt-1">
								{#each Object.entries(tooltipData.metrics) as [metric, value]}
									{#if value !== null}
										{@const hovered = metric === tooltipData.hoveredMetric}
										<!-- The row for the line under the pointer is the one the reader
										     came for; the rest are context. -->
										<div class="flex justify-between {hovered ? 'rounded-sm bg-white/10 px-1 -mx-1' : ''}">
											<span class="{hovered ? 'font-semibold text-white' : 'text-gray-400'}">{metric}:</span>
											<span
												class="font-mono {hovered ? 'font-semibold ' : ''}{value > 0
													? 'text-green-400'
													: value < 0
														? 'text-red-400'
														: 'text-white'}">{formatValue(value)}</span
											>
										</div>
									{/if}
								{/each}
							</div>
						</div>
					</div>
				</div>
			{/if}

				<!-- padding={{ top: marginTop, right: marginRight, bottom: marginBottom, left: marginLeft }} -->
			<LayerCake
				x={getX}
				xScale={scaleTime()}
				xDomain={[xDomainDates[0].getTime(), xDomainDates[1].getTime()]}
				data={allDataPoints}
			>
				<Svg>
					<!-- ClipPath to constrain chart elements within bounds -->
					<defs>
						<clipPath id="chart-clip">
							<rect
								x={marginLeft}
								y={marginTop}
								width={chartWidth - marginLeft - marginRight}
								height={chartHeight - marginTop - marginBottom}
							/>
						</clipPath>
					</defs>

					<!-- Unresolved regions background -->
					{#if showUnresolved && unresolvedRegions.length > 0}
						{#each unresolvedRegions as region}
							<rect
								x={xScale(region.start)}
								y={marginTop}
								width={Math.max(0, xScale(region.end) - xScale(region.start) + 10)}
								height={chartHeight - marginTop - marginBottom}
								fill="rgba(255, 193, 7, 0.15)"
								stroke="rgba(255, 193, 7, 0.3)"
								stroke-width="1"
								stroke-dasharray="4,4"
							/>
						{/each}
					{/if}

					<!-- Horizontal Grid lines -->
					<g class="grid-lines">
						{#each leftAxisTicks as tick}
							<line
								x1={marginLeft}
								x2={chartWidth - marginRight}
								y1={yScaleLeft(tick)}
								y2={yScaleLeft(tick)}
								stroke="var(--retro-light-grey)"
								stroke-opacity="0.2"
								stroke-dasharray="2,2"
							/>
						{/each}
					</g>

					<!-- Zero line - always visible when 0 is in range -->
					{#if leftAxisDomain[0] <= 0 && leftAxisDomain[1] >= 0}
						<line
							x1={marginLeft}
							x2={chartWidth - marginRight}
							y1={yScaleLeft(0)}
							y2={yScaleLeft(0)}
							stroke="#888888"
							stroke-opacity="0.8"
							stroke-width="1.5"
						/>
					{/if}

					<!-- Left Y-Axis line -->
					<line
						x1={marginLeft}
						y1={marginTop}
						x2={marginLeft}
						y2={chartHeight - marginBottom}
						stroke="var(--retro-light-grey)"
						stroke-width="1"
					/>

					<!-- Right Y-Axis line (only if right metrics active) -->
					{#if hasRightAxis}
						<line
							x1={chartWidth - marginRight}
							y1={marginTop}
							x2={chartWidth - marginRight}
							y2={chartHeight - marginBottom}
							stroke="var(--retro-light-grey)"
							stroke-width="1"
						/>
					{/if}

					<!-- X-Axis line -->
					<line
						x1={marginLeft}
						y1={chartHeight - marginBottom}
						x2={chartWidth - marginRight}
						y2={chartHeight - marginBottom}
						stroke="var(--retro-light-grey)"
						stroke-width="1"
					/>

					<!-- Left Y-Axis ticks and labels -->
					{#each leftAxisTicks as tick}
						<line
							x1={marginLeft - 5}
							y1={yScaleLeft(tick)}
							x2={marginLeft}
							y2={yScaleLeft(tick)}
							stroke="var(--retro-light-grey)"
							stroke-width="1"
						/>
						<text
							x={marginLeft - 8}
							y={yScaleLeft(tick)}
							text-anchor="end"
							dominant-baseline="middle"
							class="fill-current retro-text-secondary"
							font-size="10"
						>
							{tick.toFixed(3)}
						</text>
					{/each}

					<!-- Right Y-Axis ticks and labels (only if right metrics active) -->
					{#if hasRightAxis}
						{#each rightAxisTicks as tick}
							<line
								x1={chartWidth - marginRight}
								y1={yScaleRight(tick)}
								x2={chartWidth - marginRight + 5}
								y2={yScaleRight(tick)}
								stroke="var(--retro-light-grey)"
								stroke-width="1"
							/>
							<text
								x={chartWidth - marginRight + 8}
								y={yScaleRight(tick)}
								text-anchor="start"
								dominant-baseline="middle"
								class="fill-current retro-text-secondary"
								font-size="10"
							>
								{tick.toFixed(2)}
							</text>
						{/each}
					{/if}

					<!-- X-Axis ticks and round labels with dates -->
					{#each xAxisTicks as roundNum}
						{@const point = allDataPoints.find(d => d.roundNumber === roundNum)}
						{#if point}
							<line
								x1={xScale(point.date)}
								y1={chartHeight - marginBottom}
								x2={xScale(point.date)}
								y2={chartHeight - marginBottom + 5}
								stroke="var(--retro-light-grey)"
								stroke-width="1"
							/>
							<text
								x={xScale(point.date)}
								y={chartHeight - marginBottom + 16}
								text-anchor="middle"
								class="fill-current retro-text-secondary"
								font-size="10"
							>
								{roundNum}
							</text>
							<text
								x={xScale(point.date)}
								y={chartHeight - marginBottom + 28}
								text-anchor="middle"
								class="fill-current retro-text-secondary"
								font-size="8"
								opacity="0.7"
							>
								{formatShortDate(point.date)}
							</text>
						{/if}
					{/each}

					<!-- Lines for each model and metric combination (clipped to chart area) -->
					<g clip-path="url(#chart-clip)">
						{#each seriesInDrawOrder as series}
							{#each [...activeMetrics] as metric}
								{@const isRightAxis = metricConfig[metric].axis === 'right'}
								{@const yScale = isRightAxis ? yScaleRight : yScaleLeft}
								{@const validData = series.data.filter(d => {
									if (typeof d[metric] !== 'number' || !Number.isFinite(d[metric] as number)) return false;
									// Filter to zoomed domain with padding for line continuity
									if (zoomedDomain) {
										const padding = (zoomedDomain[1].getTime() - zoomedDomain[0].getTime()) * 0.1;
										const minTime = zoomedDomain[0].getTime() - padding;
										const maxTime = zoomedDomain[1].getTime() + padding;
										return d.date.getTime() >= minTime && d.date.getTime() <= maxTime;
									}
									return true;
								})}
								{@const lineGenerator = line<ChartDataPoint>()
									.x(d => xScale(d.date))
									.y(d => yScale(d[metric] ?? 0))
									.curve(curveMonotoneX)}

								{#if validData.length > 1}
									<path
										d={lineGenerator(validData) ?? ''}
										fill="none"
										stroke={getLineColor(series, metric)}
										stroke-width="2.5"
										stroke-opacity="0.9"
										stroke-dasharray={series.dashPattern}
									/>
								{/if}

								<!-- Data points with hover -->
								{#each validData as point}
									<!-- A point is a control now: clicking (or Enter/Space on it) focuses
									     its model, so it carries the button role and keyboard handling. -->
									<circle
										cx={xScale(point.date)}
										cy={yScale(point[metric] ?? 0)}
										r={point.resolved ? 4 : 6}
										fill={point.resolved ? getLineColor(series, metric) : 'transparent'}
										stroke={getLineColor(series, metric)}
										stroke-width={point.resolved ? 1 : 2}
										class="cursor-pointer transition-all hover:r-6"
										role="button"
										tabindex="0"
										aria-label="{focusedModelId === series.modelId
											? 'Stop focusing'
											: 'Focus'} {series.modelName} — round {point.roundNumber}: {metric} = {formatValue(
											point[metric]
										)}"
										onmouseenter={(e) => showTooltip(e, series, point, metric)}
										onmouseleave={hideTooltip}
										onclick={() => focusModel(series.modelId)}
										onkeydown={(e) => {
											if (e.key === 'Enter' || e.key === ' ') {
												e.preventDefault();
												focusModel(series.modelId);
											}
										}}
									/>
								{/each}
							{/each}
						{/each}
					</g>

					<!-- Axis labels as SVG text elements -->
					<!-- Left Y-Axis label -->
					<text
						x={marginLeft / 2 - 5}
						y={chartHeight / 2}
						text-anchor="middle"
						dominant-baseline="middle"
						transform="rotate(-90, {marginLeft / 2 - 5}, {chartHeight / 2})"
						class="fill-current retro-text-secondary axis-label"
						font-size="11"
					>
						Corr / MMC / FNC
					</text>

					<!-- Right Y-Axis label (only if right metrics active) -->
					{#if hasRightAxis}
						<text
							x={chartWidth - marginRight / 2 + 5}
							y={chartHeight / 2}
							text-anchor="middle"
							dominant-baseline="middle"
							transform="rotate(90, {chartWidth - marginRight / 2 + 5}, {chartHeight / 2})"
							class="fill-current retro-text-secondary axis-label"
							font-size="11"
						>
							Payout
						</text>
					{/if}

					<!-- X-Axis label -->
					<text
						x={chartWidth / 2}
						y={chartHeight - 5}
						text-anchor="middle"
						dominant-baseline="middle"
						class="fill-current retro-text-secondary axis-label"
						font-size="11"
					>
						Round / Date
					</text>
				</Svg>
			</LayerCake>
		</div>

		<!-- Brush/Zoom Area -->
		<div class="mt-2 relative">
			<div class="flex items-center justify-between mb-1">
				<span class="text-xs retro-text-secondary">Drag to zoom into a time range</span>
				{#if zoomedDomain}
					<button
						onclick={resetZoom}
						class="px-2 py-1 text-xs rounded border border-[var(--retro-crimson)] retro-text-primary hover:bg-[var(--retro-crimson)] hover:text-white transition-colors"
					>
						Reset Zoom
					</button>
				{/if}
			</div>
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<svg
				width={chartWidth}
				height={brushHeight + brushMarginTop}
				class="cursor-crosshair"
				onmousedown={handleBrushMouseDown}
				onmousemove={handleBrushMouseMove}
				onmouseup={handleBrushMouseUp}
				onmouseleave={handleBrushMouseUp}
			>
				<!-- Background -->
				<rect
					x={marginLeft}
					y={brushMarginTop}
					width={chartWidth - marginLeft - marginRight}
					height={brushHeight}
					fill="var(--retro-bg-secondary)"
					stroke="var(--retro-light-grey)"
					stroke-width="1"
				/>

				<!-- Mini chart lines for overview -->
				{#each seriesInDrawOrder as series}
					{#each [...activeMetrics].filter(m => metricConfig[m].axis === 'left') as metric}
						{@const validData = series.data.filter(d => typeof d[metric] === 'number' && Number.isFinite(d[metric] as number))}
						{@const brushLineGenerator = line<ChartDataPoint>()
							.x(d => brushScale(d.date))
							.y(d => brushYScale(d[metric] ?? 0) + brushMarginTop)
							.curve(curveMonotoneX)}

						{#if validData.length > 1}
							<path
								d={brushLineGenerator(validData) ?? ''}
								fill="none"
								stroke={getLineColor(series, metric)}
								stroke-width="1"
								stroke-opacity="0.6"
							/>
						{/if}
					{/each}
				{/each}

				<!-- Current selection highlight (when zoomed) -->
				{#if brushSelectionRect}
					<rect
						x={brushSelectionRect.x}
						y={brushMarginTop}
						width={brushSelectionRect.width}
						height={brushHeight}
						fill="var(--retro-crimson)"
						fill-opacity="0.2"
						stroke="var(--retro-crimson)"
						stroke-width="2"
					/>
				{/if}

				<!-- Drag selection preview -->
				{#if isDragging && dragStart !== null && dragEnd !== null}
					<rect
						x={Math.min(dragStart, dragEnd)}
						y={brushMarginTop}
						width={Math.abs(dragEnd - dragStart)}
						height={brushHeight}
						fill="var(--retro-accent)"
						fill-opacity="0.3"
						stroke="var(--retro-accent)"
						stroke-width="1"
						stroke-dasharray="4,2"
					/>
				{/if}

				<!-- Left/Right non-selected areas (dimmed) when zoomed -->
				{#if brushSelectionRect}
					<rect
						x={marginLeft}
						y={brushMarginTop}
						width={brushSelectionRect.x - marginLeft}
						height={brushHeight}
						fill="var(--retro-bg-primary)"
						fill-opacity="0.5"
					/>
					<rect
						x={brushSelectionRect.x + brushSelectionRect.width}
						y={brushMarginTop}
						width={chartWidth - marginRight - brushSelectionRect.x - brushSelectionRect.width}
						height={brushHeight}
						fill="var(--retro-bg-primary)"
						fill-opacity="0.5"
					/>
				{/if}
			</svg>

			<!-- Drag tooltip showing round range -->
			{#if dragTooltipInfo}
				<div
					class="absolute pointer-events-none bg-gray-900/95 border border-[var(--retro-accent)] rounded px-3 py-2 text-xs shadow-lg z-50"
					style="left: {Math.min(dragTooltipInfo.x + 10, chartWidth - 200)}px; top: {dragTooltipInfo.y - 60}px;"
				>
					<div class="text-[var(--retro-accent)] font-medium mb-1">Selection Range</div>
					<div class="flex items-center gap-2 text-white">
						<span>Round {dragTooltipInfo.startRound} ({formatShortDate(dragTooltipInfo.startDate)})</span>
						<span class="text-gray-400">→</span>
						<span>Round {dragTooltipInfo.endRound} ({formatShortDate(dragTooltipInfo.endDate)})</span>
					</div>
				</div>
			{/if}
		</div>

		<!-- Legend for unresolved indicator -->
		{#if showUnresolved}
			<div class="mt-2 flex items-center gap-4 text-xs retro-text-secondary">
				<div class="flex items-center gap-1">
					<span class="inline-block w-4 h-4 rounded" style="background-color: rgba(255, 193, 7, 0.15); border: 1px dashed rgba(255, 193, 7, 0.5);"></span>
					<span>Unresolved rounds</span>
				</div>
				<div class="flex items-center gap-1">
					<span class="inline-block w-3 h-3 rounded-full border-2 border-current"></span>
					<span>Pending data point</span>
				</div>
			</div>
		{/if}

		<!-- Expandable Raw Data Table -->
		<div class="mt-6">
			<button
				onclick={() => showRawData = !showRawData}
				class="flex items-center gap-2 text-sm font-medium retro-text-primary hover:retro-text-accent transition-colors"
			>
				<svg
					class="w-4 h-4"
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					{#if showRawData}
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 9l7 7 7-7" />
					{:else}
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
					{/if}
				</svg>
				{showRawData ? 'Hide' : 'Show'} Raw Data Table ({rawTableData.length} data points)
			</button>

			{#if showRawData}
				<div class="mt-4 overflow-x-auto border border-[var(--retro-light-grey)] rounded-lg">
					<table class="min-w-full divide-y divide-[var(--retro-light-grey)]">
						<thead class="retro-bg-secondary">
							<tr>
								<th class="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">Model</th>
								<th class="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">User</th>
								<th class="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">Round</th>
								<th class="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">Date</th>
								<th class="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">Status</th>
								<th class="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider retro-text-primary">MMC</th>
								<th class="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider retro-text-primary">MMC60</th>
								<th class="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider retro-text-primary">Corr20</th>
								<th class="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider retro-text-primary">Corr60</th>
								<th class="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider retro-text-primary">FNC</th>
								{#if hasNewMetrics}
									<th class="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider retro-text-primary">Alpha</th>
									<th class="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider retro-text-primary">MPC</th>
									<th class="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider retro-text-primary">Score</th>
								{/if}
								<th class="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider retro-text-primary">Payout</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-[var(--retro-light-grey)] retro-bg-primary">
							{#each rawTableData as row}
								<tr class="hover:retro-bg-secondary transition-colors {row.resolved ? '' : 'pending-row'}">
									<td class="px-4 py-2 text-sm font-medium retro-text-primary whitespace-nowrap">{row.modelName}</td>
									<td class="px-4 py-2 text-sm retro-text-secondary whitespace-nowrap">{row.username}</td>
									<td class="px-4 py-2 text-sm retro-text-primary font-mono">{row.roundNumber}</td>
									<td class="px-4 py-2 text-sm retro-text-secondary whitespace-nowrap">{formatDate(row.date)}</td>
									<td class="px-4 py-2 text-sm">
										<span class="px-2 py-0.5 rounded text-xs {row.resolved ? 'bg-green-900/30 text-green-400' : 'bg-yellow-900/30 text-yellow-400'}">
											{row.resolved ? 'Resolved' : 'Pending'}
										</span>
									</td>
									{@render metricCell(row.mmc)}
									{@render metricCell(row.mmc60)}
									{@render metricCell(row.corr20)}
									{@render metricCell(row.corr60)}
									{@render metricCell(row.fnc)}
									{#if hasNewMetrics}
										{@render metricCell(row.alpha)}
										{@render metricCell(row.mpc)}
										{@render metricCell(row.score)}
									{/if}
									{@render metricCell(row.payout)}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	{:else}
		<div class="flex items-center justify-center h-64 retro-bg-secondary rounded-lg">
			<p class="retro-text-secondary">No data available for the selected date range</p>
		</div>
	{/if}
</div>

<style>
	.chart-container {
		background: var(--retro-bg-primary);
		border: 2px solid var(--retro-light-grey);
		border-radius: 0.5rem;
		width: 100%;
		overflow: visible;
	}

	.chart-container :global(svg) {
		width: 100%;
		height: 100%;
		overflow: visible;
	}

	.chart-container :global(svg text) {
		fill: var(--retro-text);
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
	}

	/* Ensure any HTML overlay layers don't block SVG interactions */
	.chart-container :global(.layercake-layout-html) {
		pointer-events: none;
	}

	.axis-label {
		font-weight: 500;
		pointer-events: none;
	}

	button.active {
		font-weight: 600;
	}

	.tooltip {
		animation: fadeIn 0.15s ease-out;
	}

	@keyframes fadeIn {
		from {
			opacity: 0;
			transform: translate(-50%, -100%) translateY(5px);
		}
		to {
			opacity: 1;
			transform: translate(-50%, -100%) translateY(0);
		}
	}

	/* Data point hover effect */
	.time-series-chart :global(circle) {
		transition: r 0.15s ease-out;
	}

	.time-series-chart :global(circle:hover) {
		r: 7;
	}

	.pending-row {
		background: rgba(255, 193, 7, 0.15);
	}
</style>
