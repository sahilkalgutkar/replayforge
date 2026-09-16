import type { CapabilityArtifact, ParamSpec, Risk } from './schema.js';

// Two views of the same contract: one for whatever calls the capability, one
// for the person approving it.

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
  readonly risk: Risk;
  readonly approval: string;
  readonly capability: { id: string; version: number; productId: string };
}

function jsonTypeOf(param: ParamSpec): Record<string, unknown> {
  const base: Record<string, unknown> = { description: param.description };
  if (param.type === 'enum') return { ...base, type: 'string', enum: param.enumValues ?? [] };
  if (param.pattern !== undefined) return { ...base, type: param.type, pattern: param.pattern };
  return { ...base, type: param.type };
}

export function highestRisk(artifact: CapabilityArtifact): Risk {
  const order: Record<Risk, number> = { safe: 0, sensitive: 1, irreversible: 2 };
  return artifact.steps.reduce<Risk>(
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
      properties: Object.fromEntries(artifact.inputs.map((param) => [param.name, jsonTypeOf(param)])),
      required: artifact.inputs.filter((param) => param.required).map((param) => param.name),
    },
    returns: Object.fromEntries(
      artifact.outputs.map((output) => [output.name, { type: output.type, description: output.description }]),
    ),
    // The declared outcomes go out with the definition on purpose. A caller that
    // can't see MEMBER_NOT_FOUND is a possible answer will treat it as an error.
    outcomes: artifact.outcomes.map((outcome) => ({
      name: outcome.name,
      description: outcome.description,
      disposition: outcome.disposition,
    })),
    risk: highestRisk(artifact),
    approval: artifact.approval.state,
    capability: { id: artifact.id, version: artifact.version, productId: artifact.app.productId },
  };
}

/** What it does, what it touches, and where it could hurt. */
export function summarize(artifact: CapabilityArtifact): string {
  const lines = [
    `${artifact.name} v${artifact.version} - ${artifact.title}`,
    `  product   ${artifact.app.productId} (recorded on tenant ${artifact.app.recordedOnTenant})`,
    `  approval  ${artifact.approval.state}`,
    `  risk      ${highestRisk(artifact)}`,
    `  inputs    ${artifact.inputs.map((p) => `${p.name}:${p.type}${p.required ? '' : '?'}`).join(', ') || 'none'}`,
    `  outputs   ${artifact.outputs.map((o) => `${o.name}:${o.type}`).join(', ') || 'none'}`,
    `  outcomes  ${artifact.outcomes.map((o) => o.name).join(', ') || 'none declared'}`,
    `  steps     ${artifact.steps.length}`,
  ];
  for (const step of artifact.steps) {
    const marker = step.risk === 'safe' ? ' ' : step.risk === 'sensitive' ? '!' : '!!';
    lines.push(`    ${marker.padEnd(3)}${step.id}  ${step.intent}`);
  }
  const tenants = Object.keys(artifact.tenantOverrides);
  if (tenants.length > 0) lines.push(`  overrides ${tenants.join(', ')}`);
  return lines.join('\n');
}
