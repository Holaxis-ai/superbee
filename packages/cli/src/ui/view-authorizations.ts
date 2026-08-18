import { createHash } from "node:crypto";
import { join } from "node:path";
import type {
  RegisteredViewAuthorizationSubject,
  ViewAuthorizationStore,
  ViewAuthorizationSubject,
} from "@superbee/ui-server";
import {
  legacyUserStateDir,
  readUserStateText,
  userStateDir,
  writeFileAtomic0600,
} from "../user-state.js";

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
      const name = fileName(this.bundleIdentity, subject);
      const selected = await readUserStateText(
        join(userStateDir(this.home), STORE_DIR, name),
        join(legacyUserStateDir(this.home), STORE_DIR, name),
      );
      return selected?.content.trimEnd() === expected;
    } catch (error) {
      throw error;
    }
  }

  async authorize(subject: ViewAuthorizationSubject): Promise<void> {
    if (subject.sourceKind !== "registered") {
      throw new Error("transient View approvals are process-local and cannot be persisted");
    }
    await writeFileAtomic0600(
      join(userStateDir(this.home), STORE_DIR),
      fileName(this.bundleIdentity, subject),
      `${serialized(this.bundleIdentity, subject)}\n`,
      { rootDir: userStateDir(this.home) },
    );
  }
}
