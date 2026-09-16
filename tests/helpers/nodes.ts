import type { UiNode } from '../../src/surface/types.js';

let counter = 0;

/** A UiNode with defaults, so a test only states what it cares about. */
export function node(partial: Partial<UiNode> & { role: string }): UiNode {
  return {
    ref: partial.ref ?? `_top::${counter++}`,
    name: '',
    enabled: true,
    editable: false,
    visible: true,
    framePath: [],
    ...partial,
  };
}
