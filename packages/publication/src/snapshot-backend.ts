import type {
  BlobKey,
  ConceptId,
  DeleteOptions,
  Frontmatter,
  HeadResult,
  OkfDocument,
  QueryFilter,
  ReadBlobResult,
  ReadResult,
  ReservedFilename,
  ReservedReadResult,
  StorageBackend,
  Version,
  VersionInfo,
  WriteOptions,
} from "@superbee/core";

import { PublicationError } from "./errors.js";
import type { PublicationSnapshotHandleV1, PublicationSnapshotV1 } from "./types.js";

function absent(id: string): NodeJS.ErrnoException {
  const error = new Error(`publication snapshot object '${id}' does not exist`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

function readonly(): never {
  throw new PublicationError("CAPABILITY_UNAVAILABLE", "publication snapshots are read-only");
}

function frontmatter(value: Record<string, unknown>): Frontmatter {
  return { ...value } as Frontmatter;
}

/** Read-only adapter used only to reuse the canonical core and View bridge semantics. */
export class PublicationSnapshotBackend implements StorageBackend {
  private readonly documents = new Map<string, PublicationSnapshotV1["documents"][number]>();
  private readonly reserved = new Map<string, PublicationSnapshotV1["reserved"][number]>();
  private readonly blobs = new Map<string, PublicationSnapshotV1["blobs"][number]>();

  constructor(private readonly snapshot: PublicationSnapshotHandleV1) {
    for (const row of snapshot.manifest.documents) this.documents.set(row.id, row);
    for (const row of snapshot.manifest.reserved) this.reserved.set(`${row.dir}\0${row.name}`, row);
    for (const row of snapshot.manifest.blobs) this.blobs.set(row.key, row);
  }

  async read(id: ConceptId): Promise<ReadResult> {
    const row = this.documents.get(id);
    if (!row) throw absent(id);
    return {
      doc: { id, frontmatter: frontmatter(row.frontmatter), body: row.body },
      version: row.version,
    };
  }

  async readMany(ids: ConceptId[]): Promise<ReadResult[]> {
    return Promise.all(ids.map((id) => this.read(id)));
  }

  async write(_id: ConceptId, _doc: OkfDocument, _options?: WriteOptions): Promise<Version> {
    return readonly();
  }

  async delete(_id: ConceptId, _options?: DeleteOptions): Promise<boolean> {
    return readonly();
  }

  async exists(id: ConceptId): Promise<boolean> {
    return this.documents.has(id);
  }

  async list(prefix = ""): Promise<ConceptId[]> {
    return [...this.documents.keys()].filter((id) => id.startsWith(prefix)).sort();
  }

  async versions(id: ConceptId): Promise<VersionInfo[]> {
    const row = this.documents.get(id);
    return row
      ? [{ version: row.version, actor: "publication-snapshot", timestamp: "1970-01-01T00:00:00.000Z" }]
      : [];
  }

  async queryHeads(filter: QueryFilter = {}): Promise<HeadResult[]> {
    const ids = await this.list(filter.prefix ?? "");
    return ids
      .map((id) => this.documents.get(id)!)
      .filter((row) => filter.type === undefined || row.frontmatter.type === filter.type)
      .map((row) => ({ id: row.id, frontmatter: frontmatter(row.frontmatter), version: row.version }));
  }

  async readReserved(dir: string, name: ReservedFilename): Promise<ReservedReadResult | null> {
    const row = this.reserved.get(`${dir}\0${name}`);
    if (!row) return null;
    const bytes = await this.snapshot.readObject(row.object);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new PublicationError("INVALID_SNAPSHOT", "a reserved snapshot object is not UTF-8", {
        subject: dir ? `${dir}/${name}` : name,
        cause: error,
      });
    }
    return { content, version: row.version };
  }

  async writeReserved(
    _dir: string,
    _name: ReservedFilename,
    _content: string,
    _options?: WriteOptions,
  ): Promise<Version> {
    return readonly();
  }

  async readBlob(key: BlobKey): Promise<ReadBlobResult | null> {
    const row = this.blobs.get(key);
    if (!row) return null;
    return {
      bytes: await this.snapshot.readObject(row.object),
      contentType: row.contentType,
      version: row.version,
    };
  }

  async writeBlob(
    _key: BlobKey,
    _bytes: Uint8Array,
    _contentType?: string,
    _options?: WriteOptions,
  ): Promise<Version> {
    return readonly();
  }

  async existsBlob(key: BlobKey): Promise<boolean> {
    return this.blobs.has(key);
  }

  async listBlobs(prefix = ""): Promise<BlobKey[]> {
    return [...this.blobs.keys()].filter((key) => key.startsWith(prefix)).sort();
  }

  async deleteBlob(_key: BlobKey, _options?: DeleteOptions): Promise<boolean> {
    return readonly();
  }

  capabilities(): { history: boolean; enforced_cas: boolean; blobs: boolean; projections: boolean; backlinks: boolean } {
    return { history: false, enforced_cas: false, blobs: true, projections: true, backlinks: false };
  }
}
