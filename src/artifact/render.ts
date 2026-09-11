import type { CapabilityArtifact, ParamSpec } from './schema.js';

/**
 * Two renderings of the same contract: one for the agent that calls the
 * capability, one for the human who approves it.
 *
 * The agent-facing form is a JSON Schema tool definition, because that is what
 * a function-calling model consumes. It deliberately advertises the declared
 * outcomes and the risk class alongside the parameters — a caller that cannot
 * see that MEMBER_NOT_FOUND is a possible answer will write code that treats it
 * as an error, which is the failure mode the whole schema exists to prevent.
 */

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input_schema: {
    readonly type: 'object';
    readonly properties: Record<string, unknown>;
    readonly required: string[];
  };
  readonly returns: Record<string, { type: string; description: string }>;
  readonly outcomes: Array<{ name: string; description: string; disposition: string }>;
  readonly risk: string;
  readonly approval: string;
  readonly capability: { id: string; version: number; productId: string };
}

function jsonTypeOf(param: ParamSpec): Record<string, unknown> {
  const base: Record<string, unknown> = { description: param.description };
  if (param.type === 'enum') {
    return { ...base, type: 'string', enum: param.enumValues ?? [] };
  }
  if (param.pattern !== undefined) return { ...base, type: param.type, pattern: param.pattern };
  return { ...base, type: param.type };
}

export function highestRisk(artifact: CapabilityArtifact): 'safe' | 'sensitive' | 'irreversible' {
  const order = { safe: 0, sensitive: 1, irreversible: 2 } as const;
  return artifact.steps.reduce<'safe' | 'sensitive' | 'irreversible'>(
    (worst, step) => (order[step.risk] > order[worst] ? step.risk : worst),
    'safe',
  );
}

export function toToolDefinition(artifact: CapabilityArtifact): ToolDefinition {
  return {
    name: artifact.name,
    description: artifact.description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(artifact.inputs.map((p) => [p.name, jsonTypeOf(p)])),
      required: artifact.inputs.filter((p) => p.required).map((p) => p.name),
    },
    returns: Object.fromEntries(
      artifact.outputs.map((o) => [o.name, { type: o.type, description: o.description }]),
    ),
    outcomes: artifact.outcomes.map((o) => ({
      name: o.name,
      description: o.description,
      disposition: o.disposition,
    })),
    risk: highestRisk(artifact),
    approval: artifact.approval.state,
    capability: {
      id: artifact.id,
      version: artifact.version,
      productId: artifact.app.productId,
    },
  };
}

/** A reviewer's view: what it does, what it touches, and where it can hurt. */
export function summarize(artifact: CapabilityArtifact): string {
  const lines: string[] = [];
  lines.push(`${artifact.name} v${artifact.version} — ${artifact.title}`);
  lines.push(`  product   ${artifact.app.productId} (recorded on tenant ${artifact.app.recordedOnTenant})`);
  lines.push(`  approval  ${artifact.approval.state}`);
  lines.push(`  risk      ${highestRisk(artifact)}`);
  lines.push(
    `  inputs    ${artifact.inputs.map((p) => `${p.name}:${p.type}${p.required ? '' : '?'}`).join(', ') || 'none'}`,
  );
  lines.push(
    `  outputs   ${artifact.outputs.map((o) => `${o.name}:${o.type}`).join(', ') || 'none'}`,
  );
  lines.push(`  outcomes  ${artifact.outcomes.map((o) => o.name).join(', ') || 'none declared'}`);
  lines.push(`  steps     ${artifact.steps.length}`);
  for (const step of artifact.steps) {
    const marker = step.risk === 'safe' ? ' ' : step.risk === 'sensitive' ? '!' : '!!';
    lines.push(`    ${marker.padEnd(3)}${step.id}  ${step.intent}`);
  }
  const tenants = Object.keys(artifact.tenantOverrides);
  if (tenants.length > 0) lines.push(`  overrides ${tenants.join(', ')}`);
  return lines.join('\n');
}
