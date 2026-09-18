import type { CapabilityArtifact, Step } from './schema.js';

// Applies a tenant's override to produce the flow that actually runs. The
// contract - inputs, outputs, outcomes, policy - is not patchable, so one
// capability keeps meaning the same thing to its caller everywhere.

export interface ResolvedCapability {
  readonly artifact: CapabilityArtifact;
  readonly tenantId: string;
  readonly patchedSteps: readonly string[];
  readonly insertedSteps: readonly string[];
  readonly skippedSteps: readonly string[];
}

type StepPatch = NonNullable<CapabilityArtifact['tenantOverrides'][string]['steps'][string]>;

export function resolveForTenant(artifact: CapabilityArtifact, tenantId: string): ResolvedCapability {
  const override = artifact.tenantOverrides[tenantId];
  if (!override) {
    return { artifact, tenantId, patchedSteps: [], insertedSteps: [], skippedSteps: [] };
  }

  const patchedSteps: string[] = [];
  const skippedSteps: string[] = [];
  const insertedSteps: string[] = [];
  const steps: Step[] = [];

  for (const step of artifact.steps) {
    const patch = override.steps[step.id];
    if (patch?.skip === true) {
      skippedSteps.push(step.id);
    } else if (patch) {
      patchedSteps.push(step.id);
      steps.push(applyPatch(step, patch));
    } else {
      steps.push(step);
    }
    for (const extra of override.extraSteps) {
      if (extra.afterStepId === step.id) {
        insertedSteps.push(extra.step.id);
        steps.push(extra.step);
      }
    }
  }

  return {
    artifact: {
      ...artifact,
      app: { ...artifact.app, entryUrl: override.entryUrl ?? artifact.app.entryUrl },
      steps,
    },
    tenantId,
    patchedSteps,
    insertedSteps,
    skippedSteps,
  };
}

function applyPatch(step: Step, patch: StepPatch): Step {
  const action = { ...step.action };
  if (patch.target && 'target' in action) (action as { target: unknown }).target = patch.target;
  if (patch.value && 'value' in action) (action as { value: unknown }).value = patch.value;
  return {
    ...step,
    action: action as Step['action'],
    ...(patch.checkpoint ? { checkpoint: patch.checkpoint } : {}),
  };
}
