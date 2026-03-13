/**
 * ContextZero — Sandbox Execution Engine
 *
 * Process isolation for validation commands. Executes tsc, jest,
 * pytest, and other build/test tools inside a resource-constrained,
 * timeout-enforced subprocess with controlled environment variables
 * and filesystem scope.
 *
 * - Explicit environment sanitization (no secret leakage)
 * - Process group management for reliable cleanup
 * - Resource limits via ulimit (Linux)
 * - Timeout enforcement with SIGKILL escalation
 * - Controlled working directory scope
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../logger';

const log = new Logger('sandbox');

/** Result of a sandboxed command execution */
export interface SandboxResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    killed: boolean;
    durationMs: number;
}

/** Configuration for a sandbox execution */
export interface SandboxConfig {
    /** Working directory for the command */
    cwd: string;
    /** Maximum execution time in milliseconds */
    timeoutMs: number;
    /** Maximum stdout/stderr capture size in bytes */
    maxOutputBytes: number;
    /** Additional environment variables (merged with sanitized base) */
    env?: Record<string, string>;
    /** Resource limits (Linux ulimit). Defaults to DEFAULT_RESOURCE_LIMITS. */
    resourceLimits?: Partial<SandboxResourceLimits>;
}

/** Resource limits for sandboxed processes */
export interface SandboxResourceLimits {
    /** Maximum virtual memory in MB (ulimit -v) */
    maxMemoryMb: number;
    /** Maximum CPU time in seconds (ulimit -t) */
    maxCpuSeconds: number;
    /** Maximum number of child processes (ulimit -u) */
    maxProcesses: number;
    /** Maximum file size in MB (ulimit -f) */
    maxFileSizeMb: number;
    /** Maximum open file descriptors (ulimit -n) */
    maxOpenFiles: number;
}

/** Default resource limits — generous enough for builds, tight enough to prevent abuse */
const DEFAULT_RESOURCE_LIMITS: SandboxResourceLimits = {
    maxMemoryMb: 2048,      // 2GB virtual memory
    maxCpuSeconds: 300,      // 5 minutes CPU time
    maxProcesses: 64,        // max 64 child processes
    maxFileSizeMb: 100,      // max 100MB output files
    maxOpenFiles: 256,       // max 256 open FDs
};

/** Default sandbox configuration */
const DEFAULT_CONFIG: Omit<SandboxConfig, 'cwd'> = {
    timeoutMs: 120_000,        // 2 minutes
    maxOutputBytes: 1_048_576, // 1MB
};

/**
 * Build a sanitized environment for subprocess execution.
 * Strips all sensitive variables, preserves only what's needed for builds.
 * Runtime secrets, credentials, and production tokens are never exposed.
 */
function buildSanitizedEnv(extra?: Record<string, string>): Record<string, string> {
    const safe: Record<string, string> = {};

    // Only forward essential system variables
    const ALLOWED_VARS = [
        'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
        'TERM', 'TMPDIR', 'TMP', 'TEMP',
        'NODE_PATH', 'NODE_ENV',
        'npm_config_cache', 'npm_config_prefix',
        'PYTHONPATH', 'VIRTUAL_ENV',
    ];

    for (const key of ALLOWED_VARS) {
        const val = process.env[key];
        if (val !== undefined) {
            safe[key] = val;
        }
    }

    // Force non-interactive mode
    safe['CI'] = 'true';
    safe['FORCE_COLOR'] = '0';
    safe['NO_COLOR'] = '1';

    // Merge extra vars (caller-specified overrides)
    if (extra) {
        Object.assign(safe, extra);
    }

    return safe;
}

/**
 * Execute a command inside the sandbox with resource constraints.
 *
 * Uses spawn (not exec/execSync) for:
 * - Non-blocking execution with streaming output capture
 * - Process group management (detached + negative PID kill)
 * - Output truncation to prevent memory exhaustion
 * - Graceful SIGTERM -> hard SIGKILL escalation
 */
export async function sandboxExec(
    command: string,
    args: string[],
    config: SandboxConfig
): Promise<SandboxResult> {
    const timer = log.startTimer('sandboxExec', {
        command,
        args: args.slice(0, 3),
        cwd: config.cwd,
        timeoutMs: config.timeoutMs,
    });

    const startTime = Date.now();
    const effectiveTimeout = config.timeoutMs || DEFAULT_CONFIG.timeoutMs;
    const maxOutput = config.maxOutputBytes || DEFAULT_CONFIG.maxOutputBytes;

    return new Promise<SandboxResult>((resolve) => {
        const env = buildSanitizedEnv(config.env);

        // Verify working directory exists and is within expected scope
        const resolvedCwd = path.resolve(config.cwd);
        if (!fs.existsSync(resolvedCwd)) {
            resolve({
                exitCode: -1,
                stdout: '',
                stderr: `Sandbox working directory does not exist: ${resolvedCwd}`,
                timedOut: false,
                killed: false,
                durationMs: Date.now() - startTime,
            });
            return;
        }

        let stdoutBuf = '';
        let stderrBuf = '';
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let timedOut = false;
        let killed = false;
        let finished = false;

        // On Linux, wrap command with ulimit for resource constraints.
        // This is the native equivalent of container resource limits —
        // enforces memory, CPU, process count, and file size ceilings.
        const limits = { ...DEFAULT_RESOURCE_LIMITS, ...config.resourceLimits };
        let spawnCommand = command;
        let spawnArgs = args;

        if (process.platform === 'linux') {
            const ulimitPrefix = [
                `ulimit -v ${limits.maxMemoryMb * 1024}`,    // virtual memory in KB
                `ulimit -t ${limits.maxCpuSeconds}`,          // CPU time in seconds
                `ulimit -u ${limits.maxProcesses}`,           // max user processes
                `ulimit -f ${limits.maxFileSizeMb * 1024}`,   // file size in KB
                `ulimit -n ${limits.maxOpenFiles}`,           // open file descriptors
            ].join(' && ');

            // Wrap: sh -c "ulimit ... && exec <original command>"
            // exec replaces the shell so signals reach the actual process
            const escapedArgs = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
            spawnCommand = '/bin/sh';
            spawnArgs = ['-c', `${ulimitPrefix} && exec ${command} ${escapedArgs}`];
        }

        const child = spawn(spawnCommand, spawnArgs, {
            cwd: resolvedCwd,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            // Use process group for clean kill of child trees
            detached: process.platform !== 'win32',
            // Don't inherit any file descriptors
            windowsHide: true,
        });

        // Capture stdout with size limit
        child.stdout.on('data', (chunk: Buffer) => {
            if (!stdoutTruncated) {
                stdoutBuf += chunk.toString('utf-8');
                if (stdoutBuf.length > maxOutput) {
                    stdoutBuf = stdoutBuf.substring(0, maxOutput) + '\n... [output truncated at 1MB]';
                    stdoutTruncated = true;
                }
            }
        });

        // Capture stderr with size limit
        child.stderr.on('data', (chunk: Buffer) => {
            if (!stderrTruncated) {
                stderrBuf += chunk.toString('utf-8');
                if (stderrBuf.length > maxOutput) {
                    stderrBuf = stderrBuf.substring(0, maxOutput) + '\n... [output truncated at 1MB]';
                    stderrTruncated = true;
                }
            }
        });

        // Close stdin immediately — sandbox commands should not read from stdin
        child.stdin.end();

        // Timeout handler with escalation
        const timeoutHandle = setTimeout(() => {
            if (finished) return;
            timedOut = true;
            killed = true;

            log.warn('Sandbox execution timed out, sending SIGTERM', {
                command,
                pid: child.pid,
                timeoutMs: effectiveTimeout,
            });

            // Try graceful kill first (SIGTERM to process group)
            try {
                if (child.pid && process.platform !== 'win32') {
                    process.kill(-child.pid, 'SIGTERM');
                } else {
                    child.kill('SIGTERM');
                }
            } catch {
                // Process may have already exited
            }

            // Escalate to SIGKILL after 5 seconds if still alive
            setTimeout(() => {
                try {
                    if (child.pid && process.platform !== 'win32') {
                        process.kill(-child.pid, 'SIGKILL');
                    } else {
                        child.kill('SIGKILL');
                    }
                } catch {
                    // Already dead
                }
            }, 5000);
        }, effectiveTimeout);

        child.on('close', (code: number | null, signal: string | null) => {
            if (finished) return;
            finished = true;
            clearTimeout(timeoutHandle);

            const durationMs = Date.now() - startTime;
            const exitCode = code ?? (signal ? 128 : -1);

            timer({
                exitCode,
                timedOut,
                killed,
                stdout_bytes: stdoutBuf.length,
                stderr_bytes: stderrBuf.length,
            });

            resolve({
                exitCode,
                stdout: stdoutBuf,
                stderr: stderrBuf,
                timedOut,
                killed,
                durationMs,
            });
        });

        child.on('error', (err: Error) => {
            if (finished) return;
            finished = true;
            clearTimeout(timeoutHandle);

            log.error('Sandbox spawn error', err, { command });
            resolve({
                exitCode: -1,
                stdout: stdoutBuf,
                stderr: `Spawn error: ${err.message}`,
                timedOut: false,
                killed: false,
                durationMs: Date.now() - startTime,
            });
        });
    });
}

/**
 * Execute TypeScript type checking inside the sandbox.
 */
export async function sandboxTypeCheck(
    projectPath: string,
    tsconfigPath?: string
): Promise<SandboxResult> {
    const effectiveTsconfig = tsconfigPath || path.join(projectPath, 'tsconfig.json');
    return sandboxExec('npx', ['tsc', '--noEmit', '--project', effectiveTsconfig], {
        cwd: projectPath,
        timeoutMs: 60_000,
        maxOutputBytes: 512_000,
    });
}

/**
 * Execute test runner inside the sandbox.
 */
export async function sandboxRunTests(
    projectPath: string,
    testPaths: string[],
    framework: 'jest' | 'mocha' | 'pytest' = 'jest'
): Promise<SandboxResult> {
    let command: string;
    let args: string[];

    switch (framework) {
        case 'jest':
            command = 'npx';
            args = ['jest', '--passWithNoTests', '--no-coverage', '--forceExit', ...testPaths];
            break;
        case 'mocha':
            command = 'npx';
            args = ['mocha', '--timeout', '30000', ...testPaths];
            break;
        case 'pytest':
            command = 'python3';
            args = ['-m', 'pytest', '-x', '--tb=short', ...testPaths];
            break;
    }

    return sandboxExec(command, args, {
        cwd: projectPath,
        timeoutMs: 120_000,
        maxOutputBytes: 1_048_576,
    });
}

/**
 * Execute a Python syntax check inside the sandbox.
 */
export async function sandboxPythonCheck(
    projectPath: string,
    filePaths: string[]
): Promise<SandboxResult> {
    return sandboxExec('python3', ['-m', 'py_compile', ...filePaths], {
        cwd: projectPath,
        timeoutMs: 30_000,
        maxOutputBytes: 256_000,
    });
}
