import type { Assertion, CapabilityArtifact, Step, ValueSource } from './schema.js';

// Checks the type system can't make: that every declared output is actually
// produced, every parameter a step uses is declared for the caller, and every
// tenant override patches a step that exists. These are the errors that would
// otherwise turn up half way through a run against a live screen.

export interface ValidationIssue {
  readonly severity: 'error' | 'warning';
  readonly path: string;
  readonly message: string;
}

const TEMPLATE_REFERENCE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export function paramsReferencedBy(source: ValueSource): string[] {
  if (source.kind === 'param') return [source.name];
  if (source.kind === 'template') {
    return [...source.template.matchAll(TEMPLATE_REFERENCE)].map((match) => match[1] as string);
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

function assertionCount(assertion: Assertion): number {
  switch (assertion.kind) {
    case 'all':
    case 'any':
      return assertion.of.reduce((total, inner) => total + assertionCount(inner), 0);
    case 'not':
      return assertionCount(assertion.of);
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

  const stepIds = new Set<string>();
  for (const [index, step] of artifact.steps.entries()) {
    if (stepIds.has(step.id)) error(`steps[${index}].id`, `duplicate step id "${step.id}"`);
    stepIds.add(step.id);
  }

  const declaredParams = new Set([
    ...artifact.inputs.map((input) => input.name),
    ...artifact.app.bindingVariables,
  ]);
  const declaredSecrets = new Set(artifact.secrets.map((secret) => secret.ref));

  for (const [index, step] of artifact.steps.entries()) {
    for (const source of valueSourcesOf(step)) {
      if (source.kind === 'secret' && !declaredSecrets.has(source.ref)) {
        error(`steps[${index}]`, `step "${step.id}" uses secret "${source.ref}", which isn't declared`);
      }
      for (const name of paramsReferencedBy(source)) {
        if (!declaredParams.has(name)) {
          error(
            `steps[${index}]`,
            `step "${step.id}" uses "${name}", which is declared neither in inputs nor in app.bindingVariables`,
          );
        }
      }
    }
  }
  for (const name of paramsReferencedBy({ kind: 'template', template: artifact.app.entryUrl })) {
    if (!declaredParams.has(name)) {
      error('app.entryUrl', `entry URL uses "${name}", which is declared nowhere`);
    }
  }

  const produced = new Set(
    artifact.steps.flatMap((step) => (step.action.kind === 'read' ? [step.action.into] : [])),
  );
  for (const [index, output] of artifact.outputs.entries()) {
    if (!produced.has(output.from)) {
      error(`outputs[${index}].from`, `output "${output.name}" reads "${output.from}", which no step produces`);
    }
  }
  for (const key of produced) {
    if (!artifact.outputs.some((output) => output.from === key)) {
      warn('outputs', `a step reads into "${key}" but no output declares it, so the caller never sees it`);
    }
  }

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

  const outcomeNames = new Set<string>();
  for (const [index, outcome] of artifact.outcomes.entries()) {
    if (outcomeNames.has(outcome.name)) {
      error(`outcomes[${index}].name`, `duplicate outcome name "${outcome.name}"`);
    }
    outcomeNames.add(outcome.name);
    if (assertionCount(outcome.when) === 0) {
      error(`outcomes[${index}].when`, `outcome "${outcome.name}" has nothing to detect it by`);
    }
  }

  for (const [index, step] of artifact.steps.entries()) {
    if (!artifact.policy.allowedActions.includes(step.action.kind)) {
      error(
        `steps[${index}].action`,
        `step "${step.id}" does "${step.action.kind}", which this capability's own policy doesn't allow`,
      );
    }
    if (step.risk !== 'safe' && step.checkpoint === undefined) {
      warn(
        `steps[${index}].checkpoint`,
        `step "${step.id}" is ${step.risk} but checks nothing afterwards, so a silent failure would look like success`,
      );
    }
  }

  for (const [tenantId, override] of Object.entries(artifact.tenantOverrides)) {
    if (override.tenantId !== tenantId) {
      error(
        `tenantOverrides.${tenantId}`,
        `override is filed under "${tenantId}" but declares tenant "${override.tenantId}"`,
      );
    }
    for (const stepId of Object.keys(override.steps)) {
      if (!stepIds.has(stepId)) {
        error(`tenantOverrides.${tenantId}.steps.${stepId}`, `patches step "${stepId}", which doesn't exist`);
      }
    }
    for (const [index, extra] of override.extraSteps.entries()) {
      if (!stepIds.has(extra.afterStepId)) {
        error(
          `tenantOverrides.${tenantId}.extraSteps[${index}]`,
          `inserts after step "${extra.afterStepId}", which doesn't exist`,
        );
      }
    }
  }

  if (artifact.approval.state === 'approved' && artifact.approval.approvedBy === undefined) {
    error('approval', 'an approved capability has to record who approved it');
  }

  return issues;
}

export function assertValid(artifact: CapabilityArtifact): CapabilityArtifact {
  const errors = validateArtifact(artifact).filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      `${artifact.id} v${artifact.version} doesn't hold together:\n` +
        errors.map((issue) => `  - ${issue.path}: ${issue.message}`).join('\n'),
    );
  }
  return artifact;
}
