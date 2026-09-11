import type { CapabilityArtifact, Step } from './schema.js';

/**
 * Applies a tenant's override to a product-level capability, producing the
 * artifact that will actually run.
 *
 * The rule this encodes: a tenant may re-target a control, change a literal,
 * tighten a checkpoint, skip a step, or insert a step its build of the product
 * requires. It may not rewrite the contract — inputs, outputs, outcomes and
 * policy come from the base artifact and are not patchable. That boundary is
 * what keeps "the same capability" meaning the same thing to a calling agent
 * across two hundred institutions, and it is why a difference that cannot be
 * said as a patch is a signal to record a separate capability rather than to
 * widen the override format.
 */
export interface ResolvedCapability {
  readonly artifact: CapabilityArtifact;
  readonly tenantId: string;
  /** Steps whose targeting or value the tenant changed, for the run log. */
  readonly patchedSteps: readonly string[];
  readonly insertedSteps: readonly string[];
  readonly skippedSteps: readonly string[];
}

export function resolveForTenant(
  artifact: CapabilityArtifact,
  tenantId: string,
): ResolvedCapability {
  const override = artifact.tenantOverrides[tenantId];
  if (!override) {
    return {
      artifact,
      tenantId,
      patchedSteps: [],
      insertedSteps: [],
      skippedSteps: [],
    };
  }

  const patchedSteps: string[] = [];
  const skippedSteps: string[] = [];
  const insertedSteps: string[] = [];

  const patched: Step[] = [];
  for (const step of artifact.steps) {
    const patch = override.steps[step.id];
    if (patch?.skip === true) {
      skippedSteps.push(step.id);
    } else if (patch) {
      patchedSteps.push(step.id);
      patched.push(applyPatch(step, patch));
    } else {
      patched.push(step);
    }
    for (const extra of override.extraSteps) {
      if (extra.afterStepId === step.id) {
        insertedSteps.push(extra.step.id);
        patched.push(extra.step);
      }
    }
  }

  return {
    artifact: {
      ...artifact,
      app: { ...artifact.app, entryUrl: override.entryUrl ?? artifact.app.entryUrl },
      steps: patched,
    },
    tenantId,
    patchedSteps,
    insertedSteps,
    skippedSteps,
  };
}

function applyPatch(step: Step, patch: NonNullable<CapabilityArtifact['tenantOverrides'][string]['steps'][string]>): Step {
  const action = { ...step.action };
  if (patch.target && 'target' in action) {
    (action as { target: unknown }).target = patch.target;
  }
  if (patch.value && 'value' in action) {
    (action as { value: unknown }).value = patch.value;
  }
  return {
    ...step,
    action: action as Step['action'],
    ...(patch.checkpoint ? { checkpoint: patch.checkpoint } : {}),
  };
}
