import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { capabilityArtifactSchema, type CapabilityArtifact } from './schema.js';
import { assertValid } from './validate.js';

/**
 * Versioned, file-backed artifact storage.
 *
 * Every save writes a new immutable version rather than mutating in place. An
 * artifact is an approved production capability that an agent may invoke
 * unattended; silently editing the thing a reviewer signed off on is not a
 * storage detail, it is a control failure. Re-recording produces v2 and leaves
 * v1 where it was, so a replay can be pinned and an approval means something.
 *
 * A directory of JSON files is the right amount of machinery for this project.
 * The interface is narrow enough that a database or object store slots in
 * behind it later without anything above changing.
 */
export interface ArtifactStore {
  save(artifact: Omit<CapabilityArtifact, 'version'> & { version?: number }): Promise<CapabilityArtifact>;
  load(id: string, version?: number): Promise<CapabilityArtifact>;
  versions(id: string): Promise<number[]>;
  list(): Promise<CapabilityArtifact[]>;
}

export class FileArtifactStore implements ArtifactStore {
  constructor(private readonly root: string) {}

  private pathFor(id: string, version: number): string {
    return join(this.root, id, `v${version}.json`);
  }

  async versions(id: string): Promise<number[]> {
    try {
      const files = await readdir(join(this.root, id));
      return files
        .map((file) => /^v(\d+)\.json$/.exec(file)?.[1])
        .filter((n): n is string => n !== undefined)
        .map(Number)
        .sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  async save(
    artifact: Omit<CapabilityArtifact, 'version'> & { version?: number },
  ): Promise<CapabilityArtifact> {
    const existing = await this.versions(artifact.id);
    const nextVersion = (existing.at(-1) ?? 0) + 1;
    const parsed = assertValid(
      capabilityArtifactSchema.parse({ ...artifact, version: nextVersion }),
    );
    const path = this.pathFor(parsed.id, parsed.version);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    return parsed;
  }

  async load(id: string, version?: number): Promise<CapabilityArtifact> {
    const available = await this.versions(id);
    const wanted = version ?? available.at(-1);
    if (wanted === undefined) throw new Error(`no artifact stored for "${id}"`);
    if (!available.includes(wanted)) {
      throw new Error(
        `artifact "${id}" has no version ${wanted} (stored: ${available.join(', ') || 'none'})`,
      );
    }
    const raw = await readFile(this.pathFor(id, wanted), 'utf8');
    return capabilityArtifactSchema.parse(JSON.parse(raw));
  }

  async list(): Promise<CapabilityArtifact[]> {
    let ids: string[];
    try {
      ids = (await readdir(this.root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    const loaded = await Promise.all(
      ids.map(async (id) => {
        try {
          return await this.load(id);
        } catch {
          return undefined;
        }
      }),
    );
    return loaded
      .filter((a): a is CapabilityArtifact => a !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
