/**
 * The seam between "how we perceive and act on a surface" and "the recorded
 * flow".
 *
 * Everything above this file — the agent loop, the replay engine, the policy
 * engine, escalation — deals only in the types declared here. None of them can
 * name a CSS selector, a Playwright locator, an OS window handle or a pixel
 * coordinate, because none of those appear in this vocabulary.
 *
 * A Surface implementation has exactly two jobs: flatten whatever it can see
 * into `UiNode[]`, and execute a `Primitive` against a node it previously
 * emitted. Matching a recorded `TargetSpec` to a node is *not* one of its jobs
 * — that lives in resolve.ts and is shared by every surface, so a browser and a
 * desktop adapter cannot drift in how they interpret an artifact.
 */

export type SurfaceKind = 'browser' | 'desktop' | 'terminal';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where a node sits inside a data table. Legacy screens put the answer in a
 * grid far more often than they put it in a labelled field, and a row/column
 * coordinate expressed in header text survives re-ordering and re-styling in a
 * way an nth-child selector does not.
 */
export interface TableContext {
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly columnHeader?: string;
  /** Text of the first cell in this node's row, which is usually the row key. */
  readonly rowHeader?: string;
}

/**
 * One perceivable control or piece of content, normalised across surfaces.
 * Role, name, value and bounds all have direct equivalents in the browser
 * accessibility tree, the macOS AX API and Windows UI Automation, which is what
 * makes an artifact written against these fields portable.
 */
export interface UiNode {
  /** Ephemeral handle, valid only within the observation that produced it. */
  readonly ref: string;
  readonly role: string;
  /** Accessible name. Empty string when the surface exposes none. */
  readonly name: string;
  readonly value?: string;
  /**
   * Label inferred from layout when the surface exposes no accessible name —
   * the adjacent table cell, the preceding text run. On the legacy screens this
   * project targets, this is frequently the only identifying text a control has.
   */
  readonly nearbyText?: string;
  readonly enabled: boolean;
  readonly editable: boolean;
  readonly visible: boolean;
  readonly framePath: readonly string[];
  readonly table?: TableContext;
  readonly bounds?: Rect;
  /** Raw text content, used for assertions and extraction. */
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
  /** Visible text of the screen, joined across frames. Redacted at egress. */
  readonly text: string;
  /** Structural digest used to tell "same screen" from "different screen". */
  readonly screenFingerprint: string;
  readonly httpStatus?: number;
}

// --- targeting ------------------------------------------------------------

export type TextMatchMode = 'equals' | 'contains' | 'startsWith' | 'regex';

export interface TextMatcher {
  readonly mode: TextMatchMode;
  readonly value: string;
  readonly caseSensitive?: boolean;
}

/**
 * One rung of a target's fallback ladder. Every field is a constraint; a node
 * matches only if it satisfies all of them.
 */
export interface TargetMatcher {
  readonly role?: string;
  readonly name?: TextMatcher;
  readonly nearbyText?: TextMatcher;
  readonly text?: TextMatcher;
  readonly value?: TextMatcher;
  readonly inTable?: {
    /** Text identifying the row, matched against the row's first cell. */
    readonly rowContains: TextMatcher;
    /** Column header text, or a zero-based index when the table has no header. */
    readonly column: string | number;
  };
  readonly framePath?: readonly string[];
  readonly editable?: boolean;
  /**
   * Which match to take when the constraints legitimately identify several
   * nodes — a repeated control in a grid, for instance. Absent means the
   * matcher must identify exactly one node or resolution fails.
   */
  readonly ordinal?: number;
}

export interface TargetSpec {
  /** Human-readable, for artifact review and for escalation context. */
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
      /** 'primary' or 'fallback:N' — recorded as the per-step stability signal. */
      readonly rung: string;
      /** How many nodes the winning rung matched before the ordinal was applied. */
      readonly matchCount: number;
    }
  | { readonly ok: false; readonly failure: ResolutionFailure };

// --- acting ---------------------------------------------------------------

export type Primitive =
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'click'; readonly ref: string }
  | { readonly kind: 'fill'; readonly ref: string; readonly text: string }
  | { readonly kind: 'select'; readonly ref: string; readonly value: string }
  | { readonly kind: 'check'; readonly ref: string; readonly checked: boolean }
  | { readonly kind: 'press'; readonly key: string; readonly ref?: string }
  | { readonly kind: 'waitForIdle'; readonly timeoutMs: number };

/**
 * Direct human control of a live session, for a handoff.
 *
 * Separate from `Surface` because it is a different mode of operation, not a
 * different action: a person points at pixels and types, they do not resolve a
 * semantic target. A surface that cannot offer this can still be automated —
 * it just cannot be handed over, and the escalation path has to say so rather
 * than pretend.
 */
export interface DirectControl {
  clickAt(x: number, y: number): Promise<void>;
  typeText(text: string): Promise<void>;
  pressKey(key: string): Promise<void>;
  /** Pixel size of the surface, so an operator console can scale its view. */
  viewport(): Promise<{ readonly width: number; readonly height: number }>;
}

export function supportsDirectControl(surface: unknown): surface is DirectControl {
  const candidate = surface as Partial<DirectControl> | null;
  return (
    typeof candidate?.clickAt === 'function' &&
    typeof candidate.typeText === 'function' &&
    typeof candidate.pressKey === 'function'
  );
}

export interface Surface {
  readonly kind: SurfaceKind;
  /** Stable identifier for the app instance this surface is attached to. */
  readonly targetId: string;
  observe(): Promise<Observation>;
  perform(primitive: Primitive): Promise<void>;
  screenshot(): Promise<Buffer>;
  /** Current location, in whatever form the surface names locations. */
  location(): Promise<string>;
  dispose(): Promise<void>;
}
