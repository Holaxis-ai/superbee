import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { runGit, runOwnedProcess, type OwnedProcessOptions, type OwnedProcessResult } from '@superbee/board-git';
import { CliError } from '../../errors.js';
import { credentialsDir } from '../../credentials.js';
import { readUserStateFile, writeUserStateFileAtomic0600, ensureUserStateRoot } from '../../user-state.js';
import { withCliFilesystemMutationLock } from '../../filesystem-runtime.js';
export const DEFAULT_PUSH_MS = 600000;
export const DEFAULT_TOTAL_MS = 1500000;
export const CLEANUP_MS = 2000;
export const PUSH_TIMEOUT_KEY = 'superbee.syncPushTimeoutSeconds';
export const TOTAL_TIMEOUT_KEY = 'superbee.syncTimeoutSeconds';
export interface TransferOperation {
    kind: 'gate' | 'push';
    candidate?: string;
    branch?: string;
}
export interface TransferContext {
    deferCompletion?: boolean;
    started: number;
    deadline: number;
    pushMs: number;
    background: boolean;
    operationId: string;
    execute?: (options: OwnedProcessOptions, operation: TransferOperation) => Promise<OwnedProcessResult>;
    configured?: (totalMs: number) => Promise<void>;
    admissions: Map<string, string>;
}
const context = new AsyncLocalStorage<TransferContext>();
export function transferContext(): TransferContext | undefined { return context.getStore(); }
export function withTransfer<T>(body: () => Promise<T>, overrides: Partial<TransferContext> = {}): Promise<T> {
    if (context.getStore())
        return body();
    const started = Date.now();
    return context.run({ started, deadline: started + DEFAULT_TOTAL_MS, pushMs: DEFAULT_PUSH_MS, background: false, operationId: randomUUID(), admissions: new Map(), ...overrides }, body);
}
export function parseTransferSeconds(key: string, raw: string | undefined, fallback: number, maximum: number): number {
    if (raw === undefined)
        return fallback * 1000;
    if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > maximum)
        throw new CliError('USAGE', `${key} must be an integer from 1 to ${maximum} seconds`, { details: { key, value: raw } });
    return Number(raw) * 1000;
}
export function phaseBudget(deadline: number, cap: number, now = Date.now()): number { return Math.max(0, Math.min(cap, deadline - now - CLEANUP_MS)); }
function readPolicy(dir: string, key: string, fallback: number, max: number): number {
    const r = runGit(dir, ['config', '--get', key]);
    if (r.status !== 0 && r.status !== 1)
        throw new CliError('USAGE', `could not read ${key}`, { details: { key } });
    return parseTransferSeconds(key, r.status === 1 ? undefined : r.stdout.trim(), fallback, max);
}
export async function configureTransfer(dir: string): Promise<void> {
    const c = context.getStore();
    if (!c)
        return;
    const push = readPolicy(dir, PUSH_TIMEOUT_KEY, 600, 3600), total = readPolicy(dir, TOTAL_TIMEOUT_KEY, 1500, 7200);
    c.pushMs = push;
    c.deadline = Math.min(c.background ? c.deadline : Infinity, c.started + total);
    await c.configured?.(total);
    assertTransferBudget('preparation');
}
export function deadlineError(phase: string, extra: Record<string, unknown> = {}): CliError {
    const c = context.getStore();
    return new CliError('TRANSIENT', 'sync reached its time budget; local work is retained. Publication is unconfirmed if a push started. Run foreground sync to continue.', { details: { reason: 'deadline-exceeded', phase, retryable: false, ...(c ? { elapsed_ms: Date.now() - c.started, total_budget_ms: c.deadline - c.started } : {}), ...extra } });
}
export function assertTransferBudget(phase: string): void { const c = context.getStore(); if (c && phaseBudget(c.deadline, Infinity) <= 0)
    throw deadlineError(phase); }
export async function executeTransfer(options: OwnedProcessOptions, operation: TransferOperation): Promise<OwnedProcessResult> {
    const c = context.getStore();
    const effective = c ? phaseBudget(c.deadline, options.timeoutMs) : options.timeoutMs;
    if (effective <= 0)
        throw deadlineError(operation.kind, { candidate_sha: operation.candidate, branch: operation.branch, publication: 'not-started' });
    const result = await (c?.execute ?? ((o) => runOwnedProcess(o)))({ ...options, timeoutMs: effective, cleanupMs: CLEANUP_MS }, operation);
    if (!result.cleanupConfirmed)
        throw new CliError('RUNTIME', 'sync could not confirm process cleanup; no further operation was started', { details: { reason: 'cleanup-unconfirmed', phase: operation.kind, publication: operation.kind === 'push' ? 'unconfirmed' : 'not-started' } });
    if (result.timedOut && operation.kind === 'gate' && (c?.background || effective < options.timeoutMs))
        throw deadlineError('gate');
    return result;
}
function markerPath(home: string, root: string): {
    dir: string;
    name: string;
} { return { dir: path.join(credentialsDir(home), 'turn-end'), name: `${createHash('sha256').update(root).digest('hex').slice(0, 32)}-transfer.json` }; }
async function readMarker(home: string, root: string): Promise<string | null> {
    const p = markerPath(home, root);
    const data = await readUserStateFile(home, path.join(p.dir, p.name), 4096).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return null; throw error; });
    if (data === null)
        return null;
    const parsed = JSON.parse(data);
    if (parsed.operation === null)
        return null;
    if (typeof parsed.operation !== 'string')
        throw Error('invalid transfer marker');
    return parsed.operation;
}
export async function transferAdmission(root: string, home = homedir()): Promise<string | null> { return readMarker(home, root); }
export async function foregroundRequired(root: string, home = homedir()): Promise<boolean> { return (await transferAdmission(root, home)) !== null; }
/** Admission is persisted before execution; failed/crashed attempts leave background work held. */
export async function admitTransfer(root: string, home = homedir()): Promise<void> {
    const c = context.getStore();
    if (!c || c.admissions.has(root))
        return;
    const p = markerPath(home, root);
    try {
        await ensureUserStateRoot(home);
        await withCliFilesystemMutationLock(path.join(p.dir, p.name), async () => {
            const held = c.background ? await readMarker(home, root) : null;
            if (held !== null)
                throw new CliError('TRANSIENT', 'this board needs foreground sync before another background upload', { details: { reason: 'foreground-required', root, transfer_operation_id: held, retryable: false } });
            await writeUserStateFileAtomic0600(home, p.dir, p.name, JSON.stringify({ operation: c.operationId }));
            c.admissions.set(root, c.operationId);
        }, { waitMs: 0 });
    }
    catch (error) {
        if (error instanceof CliError)
            throw error;
        if (c.background)
            throw new CliError('TRANSIENT', 'background sync could not persist its foreground handoff; run foreground sync', { details: { reason: 'foreground-required', root, transfer_operation_id: c.operationId, retryable: false } });
        // Foreground work does not depend on optional hook state being writable.
    }
}
export async function completeTransfer(home = homedir()): Promise<void> {
    const c = context.getStore();
    if (!c || c.deferCompletion)
        return;
    for (const [root, id] of c.admissions) {
        await clearTransferAdmission(root, id, home).catch(() => { });
    }
}
export async function clearTransferAdmission(root: string, id: string, home = homedir()): Promise<void> {
    const p = markerPath(home, root);
    await withCliFilesystemMutationLock(path.join(p.dir, p.name), async () => {
        if (await readMarker(home, root) === id)
            await writeUserStateFileAtomic0600(home, p.dir, p.name, JSON.stringify({ operation: null }));
    }, { waitMs: 0 });
}
