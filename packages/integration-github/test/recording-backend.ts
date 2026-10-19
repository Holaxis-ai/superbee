import {MemoryBackend} from "@superbee/core/memory-backend";
import type {ConceptId, DeleteOptions, OkfDocument, Version, WriteOptions} from "@superbee/core";
/** A MemoryBackend that records every write and delete. */
export class RecordingBackend extends MemoryBackend {
  writes: ConceptId[] = [];
  deletes: ConceptId[] = [];
  override async write(id: ConceptId, doc: OkfDocument, options?: WriteOptions): Promise<Version> {
    const version = await super.write(id, doc, options);
    this.writes.push(id);
    return version;
  }
  override async delete(id: ConceptId, options?: DeleteOptions): Promise<boolean> {
    this.deletes.push(id);
    return super.delete(id, options);
  }
}
