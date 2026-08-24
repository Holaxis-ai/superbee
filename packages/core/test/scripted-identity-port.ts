/**
 * Scripted double of `FilesystemIdentityPort` for protocol trace proofs: an in-memory tree with
 * an optional aliasing lookup (case and normalization folded, spelling preserved as written,
 * like case-insensitive APFS), a call trace, per-call hooks, and outright overrides. Tests bind
 * it through the protocol functions' port parameter only; production never sees it.
 */
import path from "node:path";

import type {
  EntryKind,
  FilesystemIdentityPort,
  IdentityDescriptor,
  ListedEntry,
  ProbeResult,
  ReadWitness,
} from "../src/filesystem-identity.js";

export interface ScriptedNode {
  kind: EntryKind;
  ino: number;
  bytes: Buffer;
  children: Map<string, ScriptedNode>;
}

const DEV = 1;

function errno(code: string, syscall: string, target: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: ${syscall} '${target}'`) as NodeJS.ErrnoException;
  err.code = code;
  err.syscall = syscall;
  err.path = target;
  return err;
}

function fold(name: string): string {
  return name.normalize("NFD").toLowerCase();
}

type Override = (args: string[], base: () => Promise<unknown>) => Promise<unknown>;

export class ScriptedPort implements FilesystemIdentityPort {
  readonly trace: string[] = [];
  readonly root: ScriptedNode = { kind: "directory", ino: 1, bytes: Buffer.alloc(0), children: new Map() };
  aliasing: boolean;
  #nextIno = 100;
  readonly #counts = new Map<string, number>();
  readonly #hooks: Array<{ op: string; nth: number; fn: () => void }> = [];
  readonly #overrides = new Map<string, Override>();

  constructor(options: { aliasing?: boolean } = {}) {
    this.aliasing = options.aliasing ?? false;
  }

  // ── scripting surface ──────────────────────────────────────────────────────

  /** Run `fn` right after the `nth` (1-based) call of `op` returns. */
  after(op: string, nth: number, fn: () => void): void {
    this.#hooks.push({ op, nth, fn });
  }

  /** Replace `op` wholesale; `base` runs the tree-backed behavior. */
  override(op: string, fn: Override): void {
    this.#overrides.set(op, fn);
  }

  calls(op: string): number {
    return this.#counts.get(op) ?? 0;
  }

  /** Trace lines whose operation is one of `ops`. */
  ops(...ops: string[]): string[] {
    return this.trace.filter((line) => ops.includes(line.slice(0, line.indexOf("("))));
  }

  mkdirp(target: string): ScriptedNode {
    let node = this.root;
    for (const segment of this.#segments(target)) {
      let child = node.children.get(segment);
      if (child === undefined) {
        child = { kind: "directory", ino: this.#nextIno++, bytes: Buffer.alloc(0), children: new Map() };
        node.children.set(segment, child);
      }
      node = child;
    }
    return node;
  }

  file(target: string, bytes: string | Buffer, ino?: number): ScriptedNode {
    const parent = this.mkdirp(path.dirname(target));
    const node: ScriptedNode = {
      kind: "file",
      ino: ino ?? this.#nextIno++,
      bytes: typeof bytes === "string" ? Buffer.from(bytes) : bytes,
      children: new Map(),
    };
    parent.children.set(path.basename(target), node);
    return node;
  }

  /** Exact lookup (never folded), or `null`. */
  node(target: string): ScriptedNode | null {
    return this.#resolve(target, false);
  }

  /** Rename an entry in place (same node, new spelling), like a case-only `mv`. */
  respell(target: string, newName: string): void {
    const parent = this.#resolve(path.dirname(target), false);
    const node = parent?.children.get(path.basename(target));
    if (parent === null || parent === undefined || node === undefined) throw new Error(`no entry ${target}`);
    parent.children.delete(path.basename(target));
    parent.children.set(newName, node);
  }

  remove(target: string): void {
    const parent = this.#resolve(path.dirname(target), false);
    if (parent === null) throw new Error(`no parent for ${target}`);
    parent.children.delete(path.basename(target));
  }

  // ── port ───────────────────────────────────────────────────────────────────

  probe(target: string): Promise<ProbeResult | null> {
    return this.#call("probe", [target], async () => {
      const node = this.#resolve(target, this.aliasing);
      return node === null ? null : { kind: node.kind, dev: DEV, ino: node.ino };
    });
  }

  entries(dir: string): Promise<ListedEntry[] | null> {
    return this.#call("entries", [dir], async () => {
      const node = this.#resolve(dir, this.aliasing);
      if (node === null || node.kind !== "directory") return null;
      return [...node.children].map(([name, child]) => ({ name, kind: child.kind, dev: DEV, ino: child.ino }));
    });
  }

  readFile(target: string): Promise<ReadWitness> {
    return this.#call("readFile", [target], async () => {
      const node = this.#resolve(target, this.aliasing);
      if (node === null) throw errno("ENOENT", "open", target);
      if (node.kind === "directory") throw errno("EISDIR", "read", target);
      return { bytes: node.bytes, dev: DEV, ino: node.ino };
    });
  }

  stat(target: string): Promise<{ mtime: Date }> {
    return this.#call("stat", [target], async () => {
      if (this.#resolve(target, this.aliasing) === null) throw errno("ENOENT", "stat", target);
      return { mtime: new Date(0) };
    });
  }

  mkdir(dir: string): Promise<"created" | "exists"> {
    return this.#call("mkdir", [dir], async () => {
      const parent = this.#resolve(path.dirname(dir), this.aliasing);
      if (parent === null || parent.kind !== "directory") throw errno("ENOENT", "mkdir", dir);
      if (this.#child(parent, path.basename(dir), this.aliasing) !== undefined) return "exists";
      parent.children.set(path.basename(dir), {
        kind: "directory",
        ino: this.#nextIno++,
        bytes: Buffer.alloc(0),
        children: new Map(),
      });
      return "created";
    });
  }

  writeTemp(dir: string, name: string, bytes: Uint8Array): Promise<void> {
    return this.#call("writeTemp", [dir, name], async () => {
      const parent = this.#resolve(dir, this.aliasing);
      if (parent === null || parent.kind !== "directory") throw errno("ENOENT", "open", path.join(dir, name));
      parent.children.set(name, { kind: "file", ino: this.#nextIno++, bytes: Buffer.from(bytes), children: new Map() });
    });
  }

  rename(from: string, to: string): Promise<void> {
    return this.#call("rename", [from, to], async () => {
      const source = this.#resolve(path.dirname(from), this.aliasing);
      const node = source?.children.get(path.basename(from));
      if (source === null || source === undefined || node === undefined) throw errno("ENOENT", "rename", from);
      const destination = this.#resolve(path.dirname(to), this.aliasing);
      if (destination === null || destination.kind !== "directory") throw errno("ENOENT", "rename", to);
      source.children.delete(path.basename(from));
      destination.children.set(path.basename(to), node);
    });
  }

  unlink(target: string): Promise<void> {
    return this.#call("unlink", [target], async () => {
      const parent = this.#resolve(path.dirname(target), this.aliasing);
      const name = this.#childName(parent, path.basename(target), this.aliasing);
      if (parent === null || name === undefined) throw errno("ENOENT", "unlink", target);
      parent.children.delete(name);
    });
  }

  claim(key: string, _identity: IdentityDescriptor): Promise<() => Promise<void>> {
    return this.#call("claim", [key], async () => async () => {
      this.trace.push(`release(${key})`);
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  #segments(target: string): string[] {
    return path.resolve(target).split(path.sep).filter((segment) => segment !== "");
  }

  #childName(parent: ScriptedNode | null, name: string, aliasing: boolean): string | undefined {
    if (parent === null) return undefined;
    if (parent.children.has(name)) return name;
    if (!aliasing) return undefined;
    return [...parent.children.keys()].find((candidate) => fold(candidate) === fold(name));
  }

  #child(parent: ScriptedNode, name: string, aliasing: boolean): ScriptedNode | undefined {
    const found = this.#childName(parent, name, aliasing);
    return found === undefined ? undefined : parent.children.get(found);
  }

  #resolve(target: string, aliasing: boolean): ScriptedNode | null {
    let node = this.root;
    for (const segment of this.#segments(target)) {
      if (node.kind !== "directory") return null;
      const child = this.#child(node, segment, aliasing);
      if (child === undefined) return null;
      node = child;
    }
    return node;
  }

  async #call<T>(op: string, args: string[], base: () => Promise<T>): Promise<T> {
    this.trace.push(`${op}(${args.join(", ")})`);
    const override = this.#overrides.get(op);
    const result = (override === undefined ? await base() : await override(args, base)) as T;
    const count = (this.#counts.get(op) ?? 0) + 1;
    this.#counts.set(op, count);
    for (const hook of this.#hooks) if (hook.op === op && hook.nth === count) hook.fn();
    return result;
  }
}
