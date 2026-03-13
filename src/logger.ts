/**
 * ContextZero — Structured Logger
 *
 * Structured JSON logging for all ContextZero subsystems. Supports child loggers
 * with context propagation, timed operations, and configurable log levels.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

interface LogEntry {
    timestamp: string;
    level: LogLevel;
    subsystem: string;
    message: string;
    data?: Record<string, unknown>;
    duration_ms?: number;
    error?: string;
    stack?: string;
}

export class Logger {
    private subsystem: string;
    private minLevel: LogLevel;
    public readonly context: Record<string, unknown>;
    private static readonly LEVEL_ORDER: Record<LogLevel, number> = {
        debug: 0, info: 1, warn: 2, error: 3, fatal: 4,
    };

    constructor(subsystem: string, minLevel?: LogLevel, context?: Record<string, unknown>) {
        this.subsystem = subsystem;
        this.minLevel = minLevel || (process.env['LOG_LEVEL'] as LogLevel) || 'info';
        this.context = context || {};
    }

    /**
     * Create a child logger with additional context fields.
     * The child inherits the parent's subsystem, log level, and context,
     * with the new context fields merged in (overriding on conflict).
     */
    public child(extraContext: Record<string, unknown>): Logger {
        return new Logger(
            this.subsystem,
            this.minLevel,
            { ...this.context, ...extraContext }
        );
    }

    private shouldLog(level: LogLevel): boolean {
        return Logger.LEVEL_ORDER[level] >= Logger.LEVEL_ORDER[this.minLevel];
    }

    private mergeContext(data?: Record<string, unknown>): Record<string, unknown> | undefined {
        if (Object.keys(this.context).length === 0) return data;
        if (!data) return { ...this.context };
        return { ...this.context, ...data };
    }

    private emit(entry: LogEntry): void {
        if (!this.shouldLog(entry.level)) return;
        const output = JSON.stringify(entry);
        switch (entry.level) {
            case 'error':
            case 'fatal':
                process.stderr.write(output + '\n');
                break;
            default:
                process.stdout.write(output + '\n');
                break;
        }
    }

    public debug(message: string, data?: Record<string, unknown>): void {
        this.emit({ timestamp: new Date().toISOString(), level: 'debug', subsystem: this.subsystem, message, data: this.mergeContext(data) });
    }

    public info(message: string, data?: Record<string, unknown>): void {
        this.emit({ timestamp: new Date().toISOString(), level: 'info', subsystem: this.subsystem, message, data: this.mergeContext(data) });
    }

    public warn(message: string, data?: Record<string, unknown>): void {
        this.emit({ timestamp: new Date().toISOString(), level: 'warn', subsystem: this.subsystem, message, data: this.mergeContext(data) });
    }

    public error(message: string, err?: Error | unknown, data?: Record<string, unknown>): void {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        this.emit({ timestamp: new Date().toISOString(), level: 'error', subsystem: this.subsystem, message, error: errorMessage, stack, data: this.mergeContext(data) });
    }

    public fatal(message: string, err?: Error | unknown, data?: Record<string, unknown>): void {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        this.emit({ timestamp: new Date().toISOString(), level: 'fatal', subsystem: this.subsystem, message, error: errorMessage, stack, data: this.mergeContext(data) });
    }

    public startTimer(operationName: string, data?: Record<string, unknown>): (resultData?: Record<string, unknown>) => void {
        const start = Date.now();
        this.debug(`${operationName} started`, data);
        return (resultData?: Record<string, unknown>) => {
            const duration_ms = Date.now() - start;
            this.info(`${operationName} completed`, { ...data, ...resultData, duration_ms });
        };
    }
}
