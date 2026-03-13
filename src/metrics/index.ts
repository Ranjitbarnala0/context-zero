/**
 * ContextZero — Prometheus Metrics (Native Text Exposition Format)
 *
 * Production-grade metrics module with zero external dependencies.
 * Exposes counters, histograms, and gauges in Prometheus text format.
 *
 * Wave 5 — Section 5.1: Prometheus Metrics Endpoint
 */

import { Request, Response, NextFunction } from 'express';

// ────────── Counter ──────────

interface CounterValue {
    value: number;
}

const counters: Map<string, CounterValue> = new Map();

const COUNTER_DEFS: Record<string, string> = {
    scg_requests_total: 'Total number of HTTP requests received',
    scg_errors_total: 'Total number of errors encountered',
    scg_auth_failures_total: 'Total number of authentication failures',
};

function counterKey(name: string, labels?: Record<string, string>): string {
    if (!labels || Object.keys(labels).length === 0) return name;
    const sorted = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    const labelStr = sorted.map(([k, v]) => `${k}="${v}"`).join(',');
    return `${name}{${labelStr}}`;
}

export function incrementCounter(name: string, labels?: Record<string, string>): void {
    const key = counterKey(name, labels);
    const existing = counters.get(key);
    if (existing) {
        existing.value++;
    } else {
        counters.set(key, { value: 1 });
    }
}

// ────────── Histogram ──────────

interface HistogramData {
    buckets: number[];
    bucketCounts: number[];
    sum: number;
    count: number;
}

const histograms: Map<string, HistogramData> = new Map();

const HISTOGRAM_DEFS: Record<string, { help: string; buckets: number[] }> = {
    scg_request_duration_seconds: {
        help: 'Duration of HTTP requests in seconds',
        buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    },
    scg_query_duration_seconds: {
        help: 'Duration of database queries in seconds',
        buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    },
};

function histogramKey(name: string, labels?: Record<string, string>): string {
    if (!labels || Object.keys(labels).length === 0) return name;
    const sorted = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    const labelStr = sorted.map(([k, v]) => `${k}="${v}"`).join(',');
    return `${name}{${labelStr}}`;
}

export function observeHistogram(name: string, value: number, labels?: Record<string, string>): void {
    const def = HISTOGRAM_DEFS[name];
    if (!def) return;

    const key = histogramKey(name, labels);
    let data = histograms.get(key);
    if (!data) {
        data = {
            buckets: def.buckets,
            bucketCounts: new Array(def.buckets.length).fill(0),
            sum: 0,
            count: 0,
        };
        histograms.set(key, data);
    }

    data.sum += value;
    data.count++;
    for (let i = 0; i < data.buckets.length; i++) {
        if (value <= data.buckets[i]!) {
            data.bucketCounts[i]!++;
            break;  // Only count in the first (smallest) matching bucket
        }
    }
}

// ────────── Gauge ──────────

const gauges: Map<string, number> = new Map();

const GAUGE_DEFS: Record<string, string> = {
    scg_db_pool_total: 'Total number of connections in the database pool',
    scg_db_pool_idle: 'Number of idle connections in the database pool',
    scg_db_pool_waiting: 'Number of clients waiting for a database connection',
};

export function setGauge(name: string, value: number): void {
    gauges.set(name, value);
}

// ────────── Render ──────────

function renderCounters(): string {
    // Group output: emit HELP/TYPE then all keys for that counter
    const byBase = new Map<string, string[]>();
    for (const [key, entry] of counters) {
        const baseName = key.includes('{') ? key.slice(0, key.indexOf('{')) : key;
        if (!byBase.has(baseName)) byBase.set(baseName, []);
        byBase.get(baseName)!.push(`${key} ${entry.value}`);
    }

    const result: string[] = [];
    for (const [baseName, vals] of byBase) {
        if (COUNTER_DEFS[baseName]) {
            result.push(`# HELP ${baseName} ${COUNTER_DEFS[baseName]}`);
            result.push(`# TYPE ${baseName} counter`);
        }
        result.push(...vals);
    }

    return result.join('\n');
}

function renderHistograms(): string {
    const result: string[] = [];
    const byBase = new Map<string, Array<{ key: string; data: HistogramData }>>();

    for (const [key, data] of histograms) {
        const baseName = key.includes('{') ? key.slice(0, key.indexOf('{')) : key;
        if (!byBase.has(baseName)) byBase.set(baseName, []);
        byBase.get(baseName)!.push({ key, data });
    }

    for (const [baseName, entries] of byBase) {
        const def = HISTOGRAM_DEFS[baseName];
        if (def) {
            result.push(`# HELP ${baseName} ${def.help}`);
            result.push(`# TYPE ${baseName} histogram`);
        }

        for (const { key, data } of entries) {
            // Extract labels from key if present
            const labelsStr = key.includes('{') ? key.slice(key.indexOf('{') + 1, key.indexOf('}')) : '';
            const labelPrefix = labelsStr ? `${labelsStr},` : '';

            let cumulative = 0;
            for (let i = 0; i < data.buckets.length; i++) {
                cumulative += data.bucketCounts[i]!;
                result.push(`${baseName}_bucket{${labelPrefix}le="${data.buckets[i]!}"} ${cumulative}`);
            }
            result.push(`${baseName}_bucket{${labelPrefix}le="+Inf"} ${data.count}`);
            result.push(`${baseName}_sum${labelsStr ? `{${labelsStr}}` : ''} ${data.sum}`);
            result.push(`${baseName}_count${labelsStr ? `{${labelsStr}}` : ''} ${data.count}`);
        }
    }

    return result.join('\n');
}

function renderGauges(): string {
    const result: string[] = [];

    for (const [name, value] of gauges) {
        if (GAUGE_DEFS[name]) {
            result.push(`# HELP ${name} ${GAUGE_DEFS[name]}`);
            result.push(`# TYPE ${name} gauge`);
        }
        result.push(`${name} ${value}`);
    }

    return result.join('\n');
}

export function renderMetrics(): string {
    const sections: string[] = [];

    const c = renderCounters();
    if (c) sections.push(c);

    const h = renderHistograms();
    if (h) sections.push(h);

    const g = renderGauges();
    if (g) sections.push(g);

    return sections.join('\n\n') + '\n';
}

// ────────── Express Middleware ──────────

/**
 * Middleware that tracks request count and duration for each request.
 * Increments scg_requests_total and observes scg_request_duration_seconds.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();

    res.on('finish', () => {
        const durationNs = Number(process.hrtime.bigint() - start);
        const durationSec = durationNs / 1e9;

        const labels = {
            method: req.method,
            path: req.route?.path || req.path,
            status: String(res.statusCode),
        };

        incrementCounter('scg_requests_total', labels);
        observeHistogram('scg_request_duration_seconds', durationSec, labels);

        if (res.statusCode >= 500) {
            incrementCounter('scg_errors_total');
        }
        if (res.statusCode === 401 || res.statusCode === 403) {
            incrementCounter('scg_auth_failures_total');
        }
    });

    next();
}
