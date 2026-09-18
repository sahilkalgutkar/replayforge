import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSurface } from '../../src/surface/browser/playwright-surface.js';
import { replay, type ReplayOptions } from '../../src/replay/engine.js';
import type { ReplayResult } from '../../src/replay/result.js';
import type { CapabilityArtifact } from '../../src/artifact/schema.js';
import { startTarget, type TargetHarness } from './target-server.js';
import { sampleArtifact } from './sample-artifact.js';

// Starts the demo app and a browser, and replays a capability against them.

export interface ReplayHarness {
  readonly target: TargetHarness;
  readonly surface: BrowserSurface;
  readonly run: (options?: Partial<ReplayOptions>) => Promise<ReplayResult>;
  /** Arms a fault on the browser's own session, so it lands on the run. */
  readonly inject: (mode: string, count?: number) => Promise<void>;
  readonly close: () => Promise<void>;
}

export const TEST_ENV = {
  MERIDIAN_USERNAME: 'teller01',
  MERIDIAN_PASSWORD: 'demo-pass-01',
} as unknown as NodeJS.ProcessEnv;

export async function startReplayHarness(
  options: { tenantId?: string; artifact?: CapabilityArtifact; slowMs?: number } = {},
): Promise<ReplayHarness> {
  const target = await startTarget({ tenantId: options.tenantId ?? 'base', slowMs: options.slowMs ?? 200 });
  const surface = await BrowserSurface.launch({ targetId: 'replay-test' });
  const evidenceRoot = await mkdtemp(join(tmpdir(), 'replayforge-run-'));
  const artifact = options.artifact ?? sampleArtifact();

  return {
    target,
    surface,
    inject: async (mode, count = 1) => {
      await surface.perform({ kind: 'navigate', url: `${target.baseUrl}/` });
      await surface.page.evaluate(
        async ([url, m, c]) => {
          await fetch(url as string, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ mode: m as string, count: String(c) }).toString(),
          });
        },
        [`${target.baseUrl}/_test/inject`, mode, count] as const,
      );
    },
    run: (overrides = {}) =>
      replay({
        artifact,
        inputs: { memberNumber: '10021' },
        surface,
        evidenceRoot,
        variables: { baseUrl: target.baseUrl },
        env: TEST_ENV,
        screenshots: 'never',
        ...overrides,
      }),
    close: async () => {
      await surface.dispose();
      await target.close();
      await rm(evidenceRoot, { recursive: true, force: true });
    },
  };
}
