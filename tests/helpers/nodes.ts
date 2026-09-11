import type { UiNode } from '../../src/surface/types.js';

let counter = 0;

/** Builds a UiNode with sane defaults so tests only state what they care about. */
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
