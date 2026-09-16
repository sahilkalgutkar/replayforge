// The line between "how we look at an application" and "what a recorded flow
// says about it". Everything above this file works in UiNode, TargetSpec and
// Primitive, so no other layer can name a CSS selector, a window handle or a
// pixel.

export type SurfaceKind = 'browser' | 'desktop';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Where a node sits in a table, in terms of the header text around it. */
export interface TableContext {
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly columnHeader?: string;
  /** Text of the first cell in the row, which is usually the row's key. */
  readonly rowHeader?: string;
}

/**
 * One control or piece of content. Role, name, value and bounds all have
 * equivalents in the browser accessibility tree, the macOS accessibility API
 * and Windows UI Automation, which is what lets a recorded flow move between
 * them later.
 */
export interface UiNode {
  /** Only valid within the observation that produced it. */
  readonly ref: string;
  readonly role: string;
  /** Accessible name, or empty when the application exposes none. */
  readonly name: string;
  readonly value?: string;
  /**
   * Label found next to a control that has no accessible name of its own.
   * On the screens this targets, that is often the only text identifying it.
   */
  readonly nearbyText?: string;
  readonly enabled: boolean;
  readonly editable: boolean;
  readonly visible: boolean;
  readonly framePath: readonly string[];
  readonly table?: TableContext;
  readonly bounds?: Rect;
  readonly text?: string;
}

export interface FrameInfo {
  readonly path: readonly string[];
  readonly url: string;
}

export interface Observation {
  readonly observationId: string;
  readonly capturedAt: string;
  readonly url: string;
  readonly title: string;
  readonly frames: readonly FrameInfo[];
  readonly nodes: readonly UiNode[];
  /** Visible text of the screen, joined across frames. */
  readonly text: string;
  /** Digest used to tell "same screen" from "different screen". */
  readonly screenFingerprint: string;
  readonly httpStatus?: number;
}

export type TextMatchMode = 'equals' | 'contains' | 'startsWith' | 'regex';

export interface TextMatcher {
  readonly mode: TextMatchMode;
  readonly value: string;
  readonly caseSensitive?: boolean;
}

/** One rung of a target's fallback ladder. A node must satisfy every field. */
export interface TargetMatcher {
  readonly role?: string;
  readonly name?: TextMatcher;
  readonly nearbyText?: TextMatcher;
  readonly text?: TextMatcher;
  readonly value?: TextMatcher;
  readonly inTable?: {
    readonly rowContains: TextMatcher;
    /** Column header text, or an index when the table has no usable header. */
    readonly column: string | number;
  };
  readonly framePath?: readonly string[];
  readonly editable?: boolean;
  /**
   * Which match to take when several are legitimate, such as a repeated
   * control in a grid. Without it a matcher has to identify exactly one node.
   */
  readonly ordinal?: number;
}

export interface TargetSpec {
  /** Why this identifies the right control, for whoever reviews the flow. */
  readonly description: string;
  readonly primary: TargetMatcher;
  /** Tried in order when the primary matches nothing. */
  readonly fallbacks?: readonly TargetMatcher[];
}

export type ResolutionFailure =
  | { readonly reason: 'not_found'; readonly triedRungs: number }
  | { readonly reason: 'ambiguous'; readonly matchCount: number; readonly rung: string };

export type Resolution =
  | {
      readonly ok: true;
      readonly node: UiNode;
      /** 'primary' or 'fallback:N'. Recorded per step as a drift signal. */
      readonly rung: string;
      readonly matchCount: number;
    }
  | { readonly ok: false; readonly failure: ResolutionFailure };

export type Primitive =
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'click'; readonly ref: string }
  | { readonly kind: 'fill'; readonly ref: string; readonly text: string }
  | { readonly kind: 'select'; readonly ref: string; readonly value: string }
  | { readonly kind: 'check'; readonly ref: string; readonly checked: boolean }
  | { readonly kind: 'press'; readonly key: string; readonly ref?: string }
  | { readonly kind: 'waitForIdle'; readonly timeoutMs: number };

/**
 * A surface has two jobs: flatten what it can see into UiNode[], and run a
 * Primitive against a node it emitted. Matching a recorded target to a node is
 * deliberately not one of them, so two surfaces can't disagree about what a
 * recorded flow means.
 */
export interface Surface {
  readonly kind: SurfaceKind;
  /** Identifies the application instance this is attached to. */
  readonly targetId: string;
  observe(): Promise<Observation>;
  perform(primitive: Primitive): Promise<void>;
  screenshot(): Promise<Buffer>;
  location(): Promise<string>;
  dispose(): Promise<void>;
}
