import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { capabilityArtifactSchema, type CapabilityArtifact } from './schema.js';
import { assertValid } from './validate.js';

// Versioned storage. Every save writes a new version instead of changing one in
// place: once something is approved for unattended use, quietly editing the file
// a reviewer signed off on isn't a storage detail.
//
// A directory of JSON files is enough here, and the interface is small enough
// that a database could sit behind it later.

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
        .filter((value): value is string => value !== undefined)
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
    const version = (existing.at(-1) ?? 0) + 1;
    const parsed = assertValid(capabilityArtifactSchema.parse({ ...artifact, version }));
    const path = this.pathFor(parsed.id, parsed.version);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    return parsed;
  }

  async load(id: string, version?: number): Promise<CapabilityArtifact> {
    const available = await this.versions(id);
    const wanted = version ?? available.at(-1);
    if (wanted === undefined) throw new Error(`nothing stored for "${id}"`);
    if (!available.includes(wanted)) {
      throw new Error(`"${id}" has no version ${wanted} (stored: ${available.join(', ') || 'none'})`);
    }
    return capabilityArtifactSchema.parse(JSON.parse(await readFile(this.pathFor(id, wanted), 'utf8')));
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
      .filter((artifact): artifact is CapabilityArtifact => artifact !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
