import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { startOwnedProcess, type OwnedProcess, type OwnedProcessOptions, type OwnedProcessResult } from '@superbee/board-git';
import { currentExecutableRealPath } from '../../invocation.js';
import { CliError, type CliErrorCode } from '../../errors.js';
import { CLEANUP_MS, DEFAULT_TOTAL_MS, withTransfer, transferAdmission, clearTransferAdmission, type TransferOperation } from './transfer.js';
const capability = new AsyncLocalStorage<{
    started: number;
} | undefined>();
export function withFirstPartySync<T>(body: () => Promise<T>, started = Date.now()): Promise<T> { return capability.run({ started }, body); }
export function firstPartyStarted(): number | undefined { return capability.getStore()?.started; }
export function hasFirstPartySync(): boolean { return capability.getStore() !== undefined; }
export function withoutFirstPartySync<T>(body: () => Promise<T>): Promise<T> { return capability.run(undefined, body); }
const MAX_MESSAGE = 1024 * 1024;
const PROTOCOL = 'superbee-git-sync-v1';
const excluded = new Set(['--establish', '--migrate', '--show-incoming', '--inspect', '--resolve', '--doc', '--accept-deletes', '--restore-deletes', '--take-host-deletions', '--replace-links', '--help', '-h']);
export function isOrdinarySync(argv: readonly string[]): boolean { return !argv.some(arg => excluded.has(arg.split('=')[0]!)); }
function object(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function finite(v: unknown, max: number): v is number { return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= max; }
function bounded(v: unknown): boolean { try {
    return Buffer.byteLength(JSON.stringify(v)) <= MAX_MESSAGE;
}
catch {
    return false;
} }
export interface ExecutionRequest {
    operation: TransferOperation;
    options: OwnedProcessOptions;
}
export function validateExecutionRequest(value: unknown): asserts value is ExecutionRequest {
    if (!object(value) || !object(value.operation) || !object(value.options) || !bounded(value))
        throw Error('invalid execution request');
    const o = value.options, op = value.operation;
    if (!['gate', 'push'].includes(String(op.kind)) || !finite(o.timeoutMs, 7200000) || typeof o.cwd !== 'string' || !path.isAbsolute(o.cwd) || typeof o.file !== 'string' || o.file.length > 16384 || !Array.isArray(o.args) || o.args.length > 128 || o.args.some(x => typeof x !== 'string' || x.includes('\0') || x.length > 16384) || !object(o.env) || Object.values(o.env).some(x => x !== undefined && typeof x !== 'string') || o.ipc !== undefined || o.onMessage !== undefined || o.signal !== undefined)
        throw Error('invalid execution request');
    if (op.kind === 'gate' && (o.shell !== true || o.args.length !== 0))
        throw Error('invalid gate request');
    if (op.kind === 'push') {
        if (typeof op.candidate !== 'string' || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(op.candidate) || typeof op.branch !== 'string' || !/^(board|board-[a-z0-9-]+)$/.test(op.branch))
            throw Error('invalid push identity');
        const expected = ['-C', o.cwd, '-c', 'core.quotepath=off', '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'push', 'origin', `${op.candidate}:refs/heads/${op.branch}`];
        if (o.file !== 'git' || o.shell === true || JSON.stringify(o.args) !== JSON.stringify(expected))
            throw Error('invalid push invocation');
    }
}
interface WorkerOutcome {
    stdout: string;
    stderr: string;
    bypass?: boolean;
    root?: string;
    error?: {
        code: CliErrorCode;
        message: string;
        details?: Record<string, unknown>;
        help?: string;
        handled?: boolean;
    };
    admissions?: [
        string,
        string
    ][];
}
function validateOutcome(value: unknown): asserts value is WorkerOutcome {
    if (!object(value) || typeof value.stdout !== 'string' || typeof value.stderr !== 'string' || !bounded(value))
        throw Error('invalid worker result');
    if (value.error !== undefined && (!object(value.error) || typeof value.error.code !== 'string' || !Number.isInteger(new CliError(value.error.code as CliErrorCode, '').exitCode) || typeof value.error.message !== 'string'))
        throw Error('invalid worker error');
    if (value.admissions !== undefined && (!Array.isArray(value.admissions) || value.admissions.length > 4 || value.admissions.some(x => !Array.isArray(x) || x.length !== 2 || typeof x[0] !== 'string' || !path.isAbsolute(x[0]) || typeof x[1] !== 'string' || x[1].length > 128)))
        throw Error('invalid admission result');
}
export function throwWorkerError(outcome: WorkerOutcome): void { if (outcome.error)
    throw new CliError(outcome.error.code, outcome.error.message, outcome.error); }
/** Only first-party launchers opt in; arbitrary embedded runtime callbacks never cross IPC. */
export async function superviseGitSync(argv: string[], options: {
    background?: boolean;
    deadline?: number;
    started?: number;
} = {}): Promise<WorkerOutcome> {
    const executable = currentExecutableRealPath();
    if (!hasFirstPartySync() || !executable)
        throw new CliError('TRANSIENT', 'background Git sync needs foreground sync in this host', { details: { reason: 'foreground-required', retryable: false } });
    const started = options.started ?? capability.getStore()?.started ?? Date.now(), nonce = randomBytes(24).toString('hex'), operationId = randomUUID();
    let deadline = Math.min(options.deadline ?? Infinity, started + 30000), total = DEFAULT_TOTAL_MS, sequence = 0, terminal: WorkerOutcome | undefined;
    let current: OwnedProcess | undefined, worker: OwnedProcess, protocolFailure: string | undefined, phase = 'preparation';
    let root: string | undefined;
    let publication = false, candidate: string | undefined, branch: string | undefined, effective: number | undefined, received: NodeJS.Signals | undefined;
    let timer: NodeJS.Timeout | undefined;
    let stopping = false;
    const stop = () => { stopping = true; current?.stop(); worker?.stop(); };
    const arm = () => { clearTimeout(timer); timer = setTimeout(stop, Math.max(0, deadline - Date.now() - CLEANUP_MS)); };
    const onSignal = (signal: NodeJS.Signals) => { received = signal; stop(); };
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const signal of signals)
        process.on(signal, onSignal);
    const respond = (id: number, data: unknown) => worker.send({ protocol: PROTOCOL, nonce, id, data });
    const message = async (raw: unknown) => {
        if (stopping) return;
        try {
            if (!object(raw) || raw.protocol !== PROTOCOL || raw.nonce !== nonce || !finite(raw.id, 100) || raw.id !== sequence + 1 || !bounded(raw) || terminal || current)
                throw Error('invalid worker ordering');
            sequence = raw.id;
            if (raw.type === 'identity') {
                if (!options.background || root !== undefined || typeof raw.root !== 'string' || raw.root.length > 16384 || raw.root.includes('\0') || !path.isAbsolute(raw.root))
                    throw Error('invalid worker identity');
                root = raw.root;
                respond(raw.id, { ok: true });
            }
            else if (raw.type === 'policy') {
                if (!finite(raw.totalMs, 7200000))
                    throw Error('invalid policy');
                total = raw.totalMs;
                deadline = Math.min(options.deadline ?? Infinity, started + total);
                worker.setDeadline(deadline - CLEANUP_MS);
                arm();
                respond(raw.id, { ok: true });
            }
            else if (raw.type === 'execute') {
                if (options.background && root === undefined) throw Error('missing worker identity');
                validateExecutionRequest(raw.request);
                const { operation, options: request } = raw.request;
                phase = operation.kind;
                candidate = operation.candidate;
                branch = operation.branch;
                effective = Math.max(0, Math.min(request.timeoutMs, deadline - Date.now() - CLEANUP_MS));
                if (operation.kind === 'push' && effective > 0)
                    publication = true;
                current = startOwnedProcess({ ...request, timeoutMs: effective, cleanupMs: CLEANUP_MS, maxOutputBytes: 256 * 1024 });
                const result = await current.result;
                current = undefined;
                if (!result.cleanupConfirmed) {
                    protocolFailure = 'cleanup-unconfirmed';
                    stop();
                    return;
                }
                respond(raw.id, result);
                phase = 'preparation';
            }
            else if (raw.type === 'result') {
                validateOutcome(raw.outcome);
                if (options.background && raw.outcome.root !== root) throw Error('inconsistent worker identity');
                terminal = raw.outcome;
                if (terminal.error) terminal.error.details = {
                    ...terminal.error.details,
                    transfer_operation_id: terminal.error.details?.transfer_operation_id ?? operationId,
                };
                respond(raw.id, { ok: true });
            }
            else
                throw Error('invalid worker message');
        }
        catch (error) {
            protocolFailure = error instanceof Error ? error.message : 'invalid worker protocol';
            stop();
        }
    };
    try {
        worker = startOwnedProcess({ file: process.execPath, args: [...process.execArgv, executable, '__git-sync-v1'], cwd: process.cwd(), env: process.env, timeoutMs: Math.max(0, deadline - Date.now() - CLEANUP_MS), cleanupMs: CLEANUP_MS, ipc: true, onMessage: (raw) => { void message(raw); } });
        arm();
        worker.send({ protocol: PROTOCOL, nonce, type: 'initialize', argv, operationId, started, deadline: options.deadline ?? started + DEFAULT_TOTAL_MS, background: options.background === true });
        const result = await worker.result;
        current?.stop();
        const active = current ? await current.result : undefined;
        if (protocolFailure || !result.cleanupConfirmed || active && !active.cleanupConfirmed)
            throw new CliError('RUNTIME', 'sync process cleanup or worker protocol could not be confirmed; no further work was started', { details: { root, transfer_operation_id: operationId, reason: protocolFailure ?? 'cleanup-unconfirmed', cleanup_status: result.spawnError, exit_status: result.status, termination_signal: result.signal, cleanup_elapsed_ms: result.elapsedMs, publication: publication ? 'unconfirmed' : 'not-started' } });
        if (!terminal && !result.timedOut && !result.cancelled)
            throw new CliError('RUNTIME', 'sync worker exited before reporting its outcome', { details: { root, transfer_operation_id: operationId, reason: 'worker-exited', status: result.status, output_tail: result.stderr.slice(-2000), publication: publication ? 'unconfirmed' : 'not-started' } });
        if (result.timedOut || result.cancelled || !terminal) {
            throw new CliError('TRANSIENT', 'sync reached its deadline or was cancelled; local work is retained. Run foreground sync to continue.', { details: { root, transfer_operation_id: operationId, reason: received ? 'cancelled' : 'deadline-exceeded', phase, op: publication ? 'push' : 'sync', candidate_sha: candidate, branch, effective_timeout_ms: effective ?? Math.max(0, deadline - started - CLEANUP_MS), elapsed_ms: Date.now() - started, total_budget_ms: Math.min(total, deadline - started), publication: publication ? 'unconfirmed' : 'not-started', retryable: false } });
        }
        if (!terminal.error)
            for (const [root, id] of terminal.admissions ?? [])
                await clearTransferAdmission(root, id).catch(() => { });
        return terminal;
    }
    finally {
        clearTimeout(timer);
        for (const signal of signals)
            process.removeListener(signal, onSignal);
        if (received)
            process.kill(process.pid, received);
    }
}
/** Executable-only IPC entry; never entered by imports or environment variables. */
export async function runGitSyncWorker(): Promise<void> {
    if (!process.send || !process.connected)
        throw new Error('Git sync worker requires its parent IPC channel');
    let initialized = false, nonce = '', sequence = 0, pending: {
        id: number;
        resolve: (data: any) => void;
        reject: (error: Error) => void;
    } | undefined;
    const rpc = (type: string, data: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
        if (pending) {
            reject(Error('overlapping worker request'));
            return;
        }
        const id = ++sequence;
        pending = { id, resolve, reject };
        process.send!({ protocol: PROTOCOL, nonce, id, type, ...data });
    });
    const disconnect = () => { try {
        process.kill(-process.pid, 'SIGKILL');
    }
    catch {
        process.exit(1);
    } };
    process.on('disconnect', disconnect);
    await new Promise<void>((resolve, reject) => {
        const startup = setTimeout(() => reject(Error('worker initialization deadline exceeded')), 5000);
        const listener = async (raw: unknown) => {
            try {
                if (!object(raw) || raw.protocol !== PROTOCOL || !bounded(raw))
                    throw Error('invalid worker protocol');
                if (initialized) {
                    if (raw.nonce !== nonce || !pending || raw.id !== pending.id)
                        throw Error('invalid worker response');
                    const p = pending;
                    pending = undefined;
                    p.resolve(raw.data);
                    return;
                }
                if (raw.type !== 'initialize' || typeof raw.operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(raw.operationId) || typeof raw.nonce !== 'string' || !/^[0-9a-f]{48}$/.test(raw.nonce) || !Array.isArray(raw.argv) || raw.argv.length > 64 || raw.argv.some(x => typeof x !== 'string' || x.length > 16384) || !isOrdinarySync(raw.argv as string[]) || !finite(raw.started, Number.MAX_SAFE_INTEGER) || !finite(raw.deadline, Number.MAX_SAFE_INTEGER) || typeof raw.background !== 'boolean')
                    throw Error('invalid worker initialization');
                clearTimeout(startup);
                initialized = true;
                nonce = raw.nonce;
                const argv = raw.argv as string[], started = raw.started, deadline = raw.deadline, background = raw.background, operationId = raw.operationId;
                let stdout = '', stderr = '', root: string | undefined;
                const capture = (kind: 'stdout' | 'stderr', text: string) => { if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + Buffer.byteLength(text) > MAX_MESSAGE / 2)
                    throw Error('sync output exceeded limit'); if (kind === 'stdout')
                    stdout += text;
                else
                    stderr += text; };
                let outcome: WorkerOutcome = { stdout: '', stderr: '' };
                try {
                    const { hostedCheckoutFor } = await import('../../hosted/sync.js');
                    if (await hostedCheckoutFor(argv, homedir(), process.cwd()))
                        outcome.bypass = true;
                    else {
                        if (background) {
                            const { sharedGitBoardAt } = await import('../turn-end.js');
                            const dirIndex = argv.indexOf('--dir');
                            const dir = dirIndex < 0 ? undefined : argv[dirIndex + 1];
                            const board = await sharedGitBoardAt(dir);
                            root = board?.root;
                            // Acknowledged identity precedes admission, so parent-generated failures
                            // and terminal outcomes address the same board even without --dir.
                            if (root) await rpc('identity', { root });
                            const held = board ? await transferAdmission(board.root) : null;
                            if (!board) {
                                outcome = { stdout: '', stderr: '' };
                            }
                            else if (held !== null)
                                throw new CliError('TRANSIENT', 'this board needs foreground sync before another background upload', { details: { reason: 'foreground-required', root, transfer_operation_id: held, retryable: false } });
                            else if (!board.changed && board.lastFetch && Date.now() - Date.parse(board.lastFetch) < 300000) {
                                outcome = { stdout: '', stderr: '', root };
                            }
                            else
                                await run();
                        }
                        else
                            await run();
                    }
                }
                catch (error) {
                    const e = error instanceof CliError ? error : new CliError('RUNTIME', error instanceof Error ? error.message : String(error));
                    outcome.error = { code: e.code, message: e.message, details: e.details, help: e.help, handled: e.handled };
                }
                async function run() {
                    await withTransfer(async () => {
                        const { sync } = await import('../sync.js');
                        await sync(argv, { stdout: t => capture('stdout', t), stderr: t => capture('stderr', t) });
                        const { transferContext } = await import('./transfer.js');
                        outcome.admissions = [...transferContext()!.admissions];
                    }, { started, deadline, background, operationId, deferCompletion: true, execute: (options, operation) => rpc('execute', { request: { options, operation } }), configured: totalMs => rpc('policy', { totalMs }) });
                }
                outcome.stdout = stdout;
                outcome.stderr = stderr;
                outcome.root = root;
                await rpc('result', { outcome });
                process.removeListener('message', listener);
                process.removeListener('disconnect', disconnect);
                process.disconnect();
                resolve();
            }
            catch (error) {
                pending?.reject(error as Error);
                process.removeListener('message', listener);
                clearTimeout(startup);
                reject(error);
            }
        };
        process.on('message', listener);
    });
}
