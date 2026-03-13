import { Logger } from '../logger';

describe('Logger', () => {
    let output: string[];
    const originalWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;

    beforeEach(() => {
        output = [];
        process.stdout.write = ((chunk: string) => {
            output.push(chunk);
            return true;
        }) as typeof process.stdout.write;
        process.stderr.write = ((chunk: string) => {
            output.push(chunk);
            return true;
        }) as typeof process.stderr.write;
    });

    afterEach(() => {
        process.stdout.write = originalWrite;
        process.stderr.write = originalStderrWrite;
    });

    test('emits structured JSON with correct fields', () => {
        const log = new Logger('test-subsystem', 'debug');
        log.info('hello world', { key: 'value' });

        expect(output.length).toBe(1);
        const entry = JSON.parse(output[0]!);
        expect(entry.level).toBe('info');
        expect(entry.subsystem).toBe('test-subsystem');
        expect(entry.message).toBe('hello world');
        expect(entry.data.key).toBe('value');
        expect(entry.timestamp).toBeDefined();
    });

    test('respects minimum log level', () => {
        const log = new Logger('test', 'warn');
        log.debug('should be suppressed');
        log.info('should be suppressed');
        log.warn('should appear');

        expect(output.length).toBe(1);
        const entry = JSON.parse(output[0]!);
        expect(entry.level).toBe('warn');
    });

    test('error level includes error message and stack', () => {
        const log = new Logger('test', 'debug');
        const err = new Error('test error');
        log.error('something failed', err);

        const entry = JSON.parse(output[0]!);
        expect(entry.level).toBe('error');
        expect(entry.error).toBe('test error');
        expect(entry.stack).toBeDefined();
    });

    test('startTimer returns duration in completion log', () => {
        const log = new Logger('test', 'debug');
        const done = log.startTimer('operation');

        // Simulate some work
        done({ result: 'ok' });

        // Should have start + completion logs
        expect(output.length).toBe(2);
        const completion = JSON.parse(output[1]!);
        expect(completion.data.duration_ms).toBeGreaterThanOrEqual(0);
        expect(completion.data.result).toBe('ok');
    });

    test('routes error and fatal to stderr', () => {
        const stdoutCalls: string[] = [];
        const stderrCalls: string[] = [];

        process.stdout.write = ((chunk: string) => {
            stdoutCalls.push(chunk);
            return true;
        }) as typeof process.stdout.write;
        process.stderr.write = ((chunk: string) => {
            stderrCalls.push(chunk);
            return true;
        }) as typeof process.stderr.write;

        const log = new Logger('test', 'debug');
        log.info('info msg');
        log.error('error msg');
        log.fatal('fatal msg');

        expect(stdoutCalls.length).toBe(1);
        expect(stderrCalls.length).toBe(2);
    });
});
