import type { CapabilityArtifact } from '../artifact/schema.js';
import type { ArtifactStore } from '../artifact/store.js';
import { toToolDefinition, type ToolDefinition } from '../artifact/render.js';
import type { ScreenshotPolicy } from '../evidence/recorder.js';
import type { EscalationPort } from '../replay/escalation-port.js';
import { replay } from '../replay/engine.js';
import type { ReplayResult } from '../replay/result.js';
import type { Surface } from '../surface/types.js';

// Saved capabilities as a catalog an agent can call by name. The agent works
// entirely from the contract: a tool definition in, typed arguments across, one
// of four statuses back. It never sees a step or a screen.
//
// A draft isn't offered for unattended use unless it only reads, and a revoked
// capability isn't offered at all.

export interface InvocationContext {
  readonly tenantId: string;
  readonly variables: Readonly<Record<string, string>>;
  readonly evidenceRoot: string;
  /** Opens a fresh session for one call. */
  readonly openSurface: () => Promise<Surface>;
  readonly env?: NodeJS.ProcessEnv;
  readonly escalation?: EscalationPort;
  readonly screenshots?: ScreenshotPolicy;
  readonly riskyConfirmed?: boolean;
}

export interface CatalogEntry {
  readonly artifact: CapabilityArtifact;
  readonly tool: ToolDefinition;
  readonly invocableUnattended: boolean;
}

export class CapabilityCatalog {
  constructor(private readonly store: ArtifactStore) {}

  async entries(): Promise<CatalogEntry[]> {
    return (await this.store.list()).map((artifact) => {
      const tool = toToolDefinition(artifact);
      return { artifact, tool, invocableUnattended: artifact.approval.state === 'approved' || tool.risk === 'safe' };
    });
  }

  async toolDefinitions(options: { readonly includeDrafts?: boolean } = {}): Promise<ToolDefinition[]> {
    return (await this.entries())
      .filter((entry) => entry.artifact.approval.state !== 'revoked')
      .filter((entry) => options.includeDrafts === true || entry.invocableUnattended)
      .map((entry) => entry.tool);
  }

  async find(name: string): Promise<CapabilityArtifact | undefined> {
    return (await this.store.list()).find((artifact) => artifact.name === name || artifact.id === name);
  }

  async invoke(name: string, args: Readonly<Record<string, unknown>>, context: InvocationContext): Promise<ReplayResult> {
    const artifact = await this.find(name);
    if (!artifact) throw new Error(`no capability called "${name}"`);
    const surface = await context.openSurface();
    try {
      return await replay({
        artifact,
        inputs: args,
        surface,
        evidenceRoot: context.evidenceRoot,
        tenantId: context.tenantId,
        variables: context.variables,
        ...(context.env ? { env: context.env } : {}),
        ...(context.escalation ? { escalation: context.escalation } : {}),
        ...(context.screenshots ? { screenshots: context.screenshots } : {}),
        ...(context.riskyConfirmed === undefined ? {} : { riskyConfirmed: context.riskyConfirmed }),
      });
    } finally {
      await surface.dispose();
    }
  }
}

/**
 * What a calling agent should reason about: the answer, or why there isn't one,
 * and whether trying again could help. Only a timeout or a surface fault might
 * pass next time; a bad argument or a blocked step fails the same way forever.
 */
export function toAgentResult(result: ReplayResult): Record<string, unknown> {
  switch (result.status) {
    case 'success':
      return { status: 'success', ...result.outputs };
    case 'business_outcome':
      return {
        status: 'outcome',
        outcome: result.outcome,
        meaning: result.description,
        needsHuman: result.disposition === 'needs_human',
        ...result.outputs,
      };
    case 'escalated':
      return { status: 'escalated', reason: result.reason, interventionId: result.interventionId, retryable: false };
    case 'failed':
      return {
        status: 'error',
        category: result.error.category,
        message: result.error.message,
        retryable: ['step_timeout', 'surface_error'].includes(result.error.category),
      };
  }
}
