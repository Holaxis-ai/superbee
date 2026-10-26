import { spawn, type ChildProcess, type Serializable } from 'node:child_process';
/** POSIX process-group ownership, not a sandbox for programs that deliberately daemonize. */
export interface OwnedProcessOptions {
    file: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    cleanupMs?: number;
    maxOutputBytes?: number;
    shell?: boolean;
    signal?: AbortSignal;
    ipc?: boolean;
    onMessage?: (message: unknown) => void;
}
export interface OwnedProcessResult {
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    cancelled: boolean;
    cleanupConfirmed: boolean;
    elapsedMs: number;
    spawnError?: string;
}
export interface OwnedProcess {
    result: Promise<OwnedProcessResult>;
    send(message: unknown): void;
    stop(): void;
    setDeadline(deadline: number): void;
}
/** Kill on exit, rather than close: a descendant can retain the leader's output descriptors. */
export function startOwnedProcess(options: OwnedProcessOptions): OwnedProcess {
    const started = Date.now();
    let child: ChildProcess | undefined, timer: NodeJS.Timeout | undefined, cleanup: NodeJS.Timeout | undefined, probe: NodeJS.Timeout | undefined;
    let timedOut = false, cancelled = false, finished = false, status: number | null = null, signal: NodeJS.Signals | null = null;
    let closed = false, groupAbsent = false;
    let cleanupError: string | undefined;
    let spawnError: string | undefined, stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
    const maximum = options.maxOutputBytes ?? 256 * 1024;
    let resolve!: (result: OwnedProcessResult) => void;
    const result = new Promise<OwnedProcessResult>(r => { resolve = r; });
    const kill = () => { if (!groupAbsent && child?.pid !== undefined) {
        try {
            process.kill(-child.pid, 'SIGKILL');
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
                cleanupError = 'GROUP_CLEANUP:' + String((error as NodeJS.ErrnoException).code);
        }
    } };
    const finish = (confirmed: boolean) => {
        if (finished)
            return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(cleanup);
        clearTimeout(probe);
        options.signal?.removeEventListener('abort', abort);
        resolve({ status, signal, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), timedOut, cancelled, cleanupConfirmed: confirmed, elapsedMs: Date.now() - started, ...((spawnError ?? (!confirmed ? cleanupError : undefined)) ? { spawnError: spawnError ?? cleanupError } : {}) });
    };
    const observeGroup = () => {
        if (finished) return;
        // On Darwin a zombie-only group can temporarily return EPERM. Only ESRCH
        // establishes absence; stream close and successful SIGKILL do not.
        if (!groupAbsent && child?.pid !== undefined) {
            try { process.kill(-child.pid, 0); }
            catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === 'ESRCH') groupAbsent = true;
                else cleanupError = 'GROUP_CLEANUP:' + String(code);
            }
        }
        if (closed && groupAbsent) finish(true);
        else if (!probe) probe = setTimeout(() => { probe = undefined; observeGroup(); }, 10);
    };
    const terminate = () => {
        if (finished) return;
        kill();
        if (!cleanup)
            cleanup = setTimeout(() => {
                child?.stdout?.destroy(); child?.stderr?.destroy();
                if (child?.connected) child.disconnect();
                finish(false);
            }, options.cleanupMs ?? 2000);
        observeGroup();
    };
    const abort = () => { cancelled = true; terminate(); };
    const setDeadline = (deadline: number) => {
        clearTimeout(timer);
        if (finished)
            return;
        if (!Number.isFinite(deadline) || deadline <= Date.now()) {
            timedOut = true;
            if (child)
                terminate();
            else
                finish(true);
            return;
        }
        timer = setTimeout(() => { timedOut = true; terminate(); }, Math.min(2147483647, deadline - Date.now()));
    };
    const handle: OwnedProcess = { result, stop: abort, setDeadline, send: (message) => { if (child?.connected && !finished)
            child.send(message as Serializable, () => { }); } };
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
        timedOut = true;
        finish(true);
        return handle;
    }
    if (options.signal?.aborted) {
        cancelled = true;
        finish(true);
        return handle;
    }
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
        child = spawn(options.file, options.args, { cwd: options.cwd, env: options.env, shell: options.shell ?? false, detached: true, stdio: options.ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
    }
    catch (error) {
        spawnError = (error as NodeJS.ErrnoException).code ?? 'SPAWN';
        finish(true);
        return handle;
    }
    const append = (previous: Buffer, chunk: Buffer) => { const joined = Buffer.concat([previous, chunk]); return joined.length > maximum ? joined.subarray(joined.length - maximum) : joined; };
    child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on('message', (message) => options.onMessage?.(message));
    child.on('error', (error: NodeJS.ErrnoException) => { spawnError = error.code ?? 'SPAWN'; terminate(); if (child?.pid === undefined)
        finish(true); });
    child.on('exit', (code, sig) => { status = code; signal = sig; clearTimeout(timer); terminate(); });
    child.on('close', (code, sig) => { status = code; signal = sig; closed = true; if (child?.pid === undefined) finish(true); else terminate(); });
    setDeadline(started + options.timeoutMs);
    return handle;
}
/** Direct callers retain normal terminal signal semantics after owned descendants are stopped. */
export async function runOwnedProcess(options: OwnedProcessOptions): Promise<OwnedProcessResult> {
    const controller = new AbortController();
    let received: NodeJS.Signals | undefined;
    const onSignal = (signal: NodeJS.Signals) => { received = signal; controller.abort(); };
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const signal of signals)
        process.on(signal, onSignal);
    try {
        return await startOwnedProcess({ ...options, signal: options.signal?.aborted ? options.signal : controller.signal }).result;
    }
    finally {
        for (const signal of signals)
            process.removeListener(signal, onSignal);
        options.signal?.removeEventListener('abort', abort);
        if (received)
            process.kill(process.pid, received);
    }
}
