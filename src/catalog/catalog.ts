import type { CapabilityArtifact } from '../artifact/schema.js';
import type { ArtifactStore } from '../artifact/store.js';
import { toToolDefinition, type ToolDefinition } from '../artifact/render.js';
import type { EscalationPort } from '../replay/escalation-port.js';
import { replay } from '../replay/engine.js';
import type { ReplayResult } from '../replay/result.js';
import type { Surface } from '../surface/types.js';
import type { ScreenshotPolicy } from '../evidence/recorder.js';

/**
 * The agent-facing surface: saved capabilities as a catalog of callable tools.
 *
 * The point of this layer is that a calling agent works entirely in the
 * contract. It reads a tool definition, passes typed arguments, and receives
 * one of four statuses. It never sees a step, a target or a screen — which is
 * what makes the whole record-once idea worth having, because the agent's
 * reasoning does not have to include the UI.
 *
 * The catalog also enforces the one rule an agent must not be able to talk its
 * way past: an unapproved capability is not offered for unattended invocation.
 */

export interface InvocationContext {
  readonly tenantId: string;
  /** Per-tenant deployment values, e.g. the institution's hostname. */
  readonly variables: Readonly<Record<string, string>>;
  readonly evidenceRoot: string;
  /** Opens a fresh session for one invocation. */
  readonly openSurface: () => Promise<Surface>;
  readonly env?: NodeJS.ProcessEnv;
  readonly escalation?: EscalationPort;
  readonly screenshots?: ScreenshotPolicy;
  readonly riskyConfirmed?: boolean;
  readonly runId?: string;
}

export interface CatalogEntry {
  readonly artifact: CapabilityArtifact;
  readonly tool: ToolDefinition;
  /** False when this capability may not be invoked without a person watching. */
  readonly invocableUnattended: boolean;
}

export class CapabilityCatalog {
  constructor(private readonly store: ArtifactStore) {}

  async entries(): Promise<CatalogEntry[]> {
    const artifacts = await this.store.list();
    return artifacts.map((artifact) => {
      const tool = toToolDefinition(artifact);
      return {
        artifact,
        tool,
        invocableUnattended: artifact.approval.state === 'approved' || tool.risk === 'safe',
      };
    });
  }

  /**
   * Tool definitions for a calling model. Revoked capabilities are omitted
   * entirely — a model should not be reasoning about whether to call something
   * that has been withdrawn.
   */
  async toolDefinitions(options: { readonly includeDrafts?: boolean } = {}): Promise<ToolDefinition[]> {
    const entries = await this.entries();
    return entries
      .filter((entry) => entry.artifact.approval.state !== 'revoked')
      .filter((entry) => options.includeDrafts === true || entry.invocableUnattended)
      .map((entry) => entry.tool);
  }

  async find(name: string): Promise<CapabilityArtifact | undefined> {
    const artifacts = await this.store.list();
    return artifacts.find((artifact) => artifact.name === name || artifact.id === name);
  }

  async invoke(
    name: string,
    args: Readonly<Record<string, unknown>>,
    context: InvocationContext,
  ): Promise<ReplayResult> {
    const artifact = await this.find(name);
    if (!artifact) throw new Error(`no capability named "${name}" in this catalog`);

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
        ...(context.runId ? { runId: context.runId } : {}),
      });
    } finally {
      await surface.dispose();
    }
  }
}

/**
 * Reduces a replay result to what a calling agent should reason about. It gets
 * the answer or the reason there isn't one, and nothing about screens or steps.
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
      return {
        status: 'escalated',
        reason: result.reason,
        interventionId: result.interventionId,
        retryable: false,
      };
    case 'failed':
      return {
        status: 'error',
        category: result.error.category,
        message: result.error.message,
        // Only a transient class is worth another attempt; a bad argument or a
        // blocked action will fail the same way every time.
        retryable: ['step_timeout', 'surface_error'].includes(result.error.category),
      };
  }
}
