import type { Assertion, CapabilityArtifact, Step, ValueSource } from './schema.js';

/**
 * Referential checks the type system cannot make.
 *
 * Zod proves the file is shaped like an artifact. This proves it is coherent:
 * that every declared output is actually produced by a step, that every
 * parameter a step consumes is declared for the caller, that a tenant override
 * patches steps that exist. These are exactly the errors that otherwise surface
 * as a confusing mid-replay failure against a live banking screen, which is the
 * worst possible place to discover them.
 */

export interface ValidationIssue {
  readonly severity: 'error' | 'warning';
  readonly path: string;
  readonly message: string;
}

const TEMPLATE_REFERENCE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export function paramsReferencedBy(source: ValueSource): string[] {
  if (source.kind === 'param') return [source.name];
  if (source.kind === 'template') {
    return [...source.template.matchAll(TEMPLATE_REFERENCE)].map((m) => m[1] as string);
  }
  return [];
}

function valueSourcesOf(step: Step): ValueSource[] {
  const { action } = step;
  switch (action.kind) {
    case 'navigate':
      return [action.url];
    case 'type':
    case 'select':
      return [action.value];
    default:
      return [];
  }
}

function targetsIn(assertion: Assertion): number {
  switch (assertion.kind) {
    case 'all':
    case 'any':
      return assertion.of.reduce((sum, inner) => sum + targetsIn(inner), 0);
    case 'not':
      return targetsIn(assertion.of);
    default:
      return 1;
  }
}

export function validateArtifact(artifact: CapabilityArtifact): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const error = (path: string, message: string): void => {
    issues.push({ severity: 'error', path, message });
  };
  const warn = (path: string, message: string): void => {
    issues.push({ severity: 'warning', path, message });
  };

  // Step identity.
  const stepIds = new Set<string>();
  for (const [index, step] of artifact.steps.entries()) {
    if (stepIds.has(step.id)) error(`steps[${index}].id`, `duplicate step id "${step.id}"`);
    stepIds.add(step.id);
  }

  // Inputs consumed vs declared.
  const declaredParams = new Set([
    ...artifact.inputs.map((p) => p.name),
    ...artifact.app.bindingVariables,
  ]);
  const declaredSecrets = new Set(artifact.secrets.map((s) => s.ref));
  for (const [index, step] of artifact.steps.entries()) {
    for (const source of valueSourcesOf(step)) {
      if (source.kind === 'secret' && !declaredSecrets.has(source.ref)) {
        error(`steps[${index}]`, `step "${step.id}" uses secret "${source.ref}" which is not declared`);
      }
      for (const name of paramsReferencedBy(source)) {
        if (!declaredParams.has(name)) {
          error(
            `steps[${index}]`,
            `step "${step.id}" uses parameter "${name}" which is declared neither in inputs nor in app.bindingVariables`,
          );
        }
      }
    }
  }
  for (const name of paramsReferencedBy({ kind: 'template', template: artifact.app.entryUrl })) {
    if (!declaredParams.has(name)) {
      error(
        'app.entryUrl',
        `entry URL uses "${name}" which is declared neither in inputs nor in app.bindingVariables`,
      );
    }
  }

  // Outputs produced vs declared.
  const produced = new Set(
    artifact.steps.flatMap((step) => (step.action.kind === 'read' ? [step.action.into] : [])),
  );
  for (const [index, output] of artifact.outputs.entries()) {
    if (!produced.has(output.from)) {
      error(
        `outputs[${index}].from`,
        `output "${output.name}" reads key "${output.from}" which no step produces`,
      );
    }
  }
  for (const key of produced) {
    if (!artifact.outputs.some((o) => o.from === key)) {
      warn('outputs', `step reads into "${key}" but no output declares it, so the caller never sees it`);
    }
  }

  // Unused declarations are a review smell rather than a defect.
  const usedParams = new Set(
    artifact.steps.flatMap((step) => valueSourcesOf(step).flatMap(paramsReferencedBy)),
  );
  for (const name of paramsReferencedBy({ kind: 'template', template: artifact.app.entryUrl })) {
    usedParams.add(name);
  }
  for (const param of artifact.inputs) {
    if (!usedParams.has(param.name)) {
      warn('inputs', `parameter "${param.name}" is declared but no step uses it`);
    }
  }

  // Outcomes.
  const outcomeNames = new Set<string>();
  for (const [index, outcome] of artifact.outcomes.entries()) {
    if (outcomeNames.has(outcome.name)) {
      error(`outcomes[${index}].name`, `duplicate outcome name "${outcome.name}"`);
    }
    outcomeNames.add(outcome.name);
    if (targetsIn(outcome.when) === 0) {
      error(`outcomes[${index}].when`, `outcome "${outcome.name}" has an empty detection assertion`);
    }
  }

  // Risk against policy.
  for (const [index, step] of artifact.steps.entries()) {
    if (!artifact.policy.allowedActions.includes(step.action.kind)) {
      error(
        `steps[${index}].action`,
        `step "${step.id}" performs "${step.action.kind}" which this capability's policy does not allow`,
      );
    }
    if (step.risk !== 'safe' && step.checkpoint === undefined) {
      warn(
        `steps[${index}].checkpoint`,
        `step "${step.id}" is ${step.risk} but asserts nothing afterwards, so a silent failure would look like success`,
      );
    }
  }

  // Tenant overrides must patch something real.
  for (const [tenantId, override] of Object.entries(artifact.tenantOverrides)) {
    if (override.tenantId !== tenantId) {
      error(`tenantOverrides.${tenantId}`, `override is filed under "${tenantId}" but declares tenant "${override.tenantId}"`);
    }
    for (const stepId of Object.keys(override.steps)) {
      if (!stepIds.has(stepId)) {
        error(`tenantOverrides.${tenantId}.steps.${stepId}`, `patches step "${stepId}" which does not exist`);
      }
    }
    for (const [index, extra] of override.extraSteps.entries()) {
      if (!stepIds.has(extra.afterStepId)) {
        error(
          `tenantOverrides.${tenantId}.extraSteps[${index}]`,
          `inserts after step "${extra.afterStepId}" which does not exist`,
        );
      }
    }
  }

  if (artifact.approval.state === 'approved' && artifact.approval.approvedBy === undefined) {
    error('approval', 'an approved artifact must record who approved it');
  }

  return issues;
}

export function assertValid(artifact: CapabilityArtifact): CapabilityArtifact {
  const errors = validateArtifact(artifact).filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      `artifact ${artifact.id} v${artifact.version} is not coherent:\n` +
        errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n'),
    );
  }
  return artifact;
}
