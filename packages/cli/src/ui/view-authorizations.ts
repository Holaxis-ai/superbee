import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  RegisteredViewAuthorizationSubject,
  ViewAuthorizationStore,
  ViewAuthorizationSubject,
} from "@superbee/ui-server";
import { credentialsDir } from "../credentials.js";
import { readUserStateFile, writeUserStateFileAtomic0600 } from "../user-state.js";

const STORE_DIR = "view-authorizations";

interface StoredAuthorization {
  bundle: string;
  subject: ViewAuthorizationSubject;
}

function stableRecord(bundle: string, subject: RegisteredViewAuthorizationSubject): StoredAuthorization {
  return {
    bundle,
    subject: {
      sourceKind: "registered",
      registryId: subject.registryId,
      contentVersion: subject.contentVersion,
      contentType: subject.contentType,
      capability: subject.capability,
      execution: subject.execution,
      policyVersion: subject.policyVersion,
    },
  };
}

function serialized(bundle: string, subject: ViewAuthorizationSubject): string {
  if (subject.sourceKind !== "registered") {
    throw new Error("transient View approvals are process-local and cannot be persisted");
  }
  const record = stableRecord(bundle, subject);
  // Preserve the original on-disk registered-View approval bytes across this source-identity
  // refactor. The discriminator is runtime-only for this established persistent format.
  const { sourceKind: _sourceKind, ...storedSubject } = record.subject;
  return JSON.stringify({ bundle: record.bundle, subject: storedSubject });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

/** Exact immutable disk contract accepted by the explicit one-shot state migration. */
export function assertMigratableViewAuthorization(name: string, raw: string): void {
  if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error("legacy View authorization has an unsupported name");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("legacy View authorization is not valid JSON");
  }
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["bundle", "subject"])
    || typeof value.bundle !== "string"
    || value.bundle.length === 0
    || !isRecord(value.subject)
  ) {
    throw new Error("legacy View authorization has an unsupported envelope");
  }
  const subject = value.subject;
  if (
    !hasExactKeys(subject, ["registryId", "contentVersion", "contentType", "capability", "execution", "policyVersion"])
    || typeof subject.registryId !== "string"
    || subject.registryId.length === 0
    || typeof subject.contentVersion !== "string"
    || subject.contentVersion.length === 0
    || subject.contentType !== "text/html; charset=utf-8"
    || !["none", "bundle-read", "bundle-propose"].includes(String(subject.capability))
    || subject.execution !== "active"
    || subject.policyVersion !== "active-view-v1"
  ) {
    throw new Error("legacy View authorization has an unsupported subject");
  }
  const canonical = JSON.stringify(value);
  if (raw !== `${canonical}\n` || name !== `${createHash("sha256").update(canonical).digest("hex")}.json`) {
    throw new Error("legacy View authorization does not match its immutable identity");
  }
}

function fileName(bundle: string, subject: ViewAuthorizationSubject): string {
  return `${createHash("sha256").update(serialized(bundle, subject)).digest("hex")}.json`;
}

/**
 * Exact-byte, local-only approval store. One immutable record per subject avoids a shared JSON
 * read/modify/write race when multiple local AgentState sessions approve Views concurrently.
 */
export class LocalViewAuthorizationStore implements ViewAuthorizationStore {
  private readonly bundleIdentity: string;
  private readonly home: string | undefined;

  constructor(bundleIdentity: string, home?: string) {
    this.bundleIdentity = bundleIdentity;
    this.home = home;
  }

  async isAuthorized(subject: ViewAuthorizationSubject): Promise<boolean> {
    if (subject.sourceKind !== "registered") return false;
    const expected = serialized(this.bundleIdentity, subject);
    try {
      const selectedHome = this.home ?? homedir();
      const raw = await readUserStateFile(
        selectedHome,
        join(credentialsDir(selectedHome), STORE_DIR, fileName(this.bundleIdentity, subject)),
        64 * 1024,
      );
      return raw.trimEnd() === expected;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async authorize(subject: ViewAuthorizationSubject): Promise<void> {
    if (subject.sourceKind !== "registered") {
      throw new Error("transient View approvals are process-local and cannot be persisted");
    }
    await writeUserStateFileAtomic0600(
      this.home ?? homedir(),
      join(credentialsDir(this.home), STORE_DIR),
      fileName(this.bundleIdentity, subject),
      `${serialized(this.bundleIdentity, subject)}\n`,
    );
  }
}
