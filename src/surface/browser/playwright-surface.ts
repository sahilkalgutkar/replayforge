import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright';
import { fingerprintNodes } from '../fingerprint.js';
import type { DirectControl, FrameInfo, Observation, Primitive, Surface, UiNode } from '../types.js';
import { extractFrame, REF_ATTRIBUTE, type FrameExtract } from './extract.js';

export interface BrowserSurfaceOptions {
  readonly targetId: string;
  readonly headless?: boolean;
  readonly settleTimeoutMs?: number;
  /**
   * How long to wait after a click or key press for a navigation to *start*
   * before concluding the action did not navigate. Resolves the moment a
   * navigation begins, so it only costs the full window on actions that stay
   * on the same screen.
   */
  readonly navigationGraceMs?: number;
  readonly actionTimeoutMs?: number;
  readonly viewport?: { width: number; height: number };
}

/**
 * The browser implementation of the Surface seam. It knows about Playwright,
 * frames and DOM attributes; nothing above it does.
 *
 * Two details worth calling out. Refs are written into the page as a
 * `data-rf-ref` attribute rather than held in a page-side map, because a map
 * dies on navigation and the attribute round-trips through the same locator
 * lookup Playwright already does well. And the HTTP status reported for an
 * observation is the most severe status across every frame that makes up the
 * screen — a frameset returns 200 for the shell while the content frame inside
 * it returns 403, and it is the 403 that the replay engine needs to see.
 */
export class BrowserSurface implements Surface, DirectControl {
  readonly kind = 'browser' as const;
  readonly targetId: string;

  private readonly browser: Browser;
  private readonly context: BrowserContext;
  private readonly pageRef: Page;
  private readonly settleTimeoutMs: number;
  private readonly actionTimeoutMs: number;
  private readonly navigationGraceMs: number;
  private readonly statusByUrl = new Map<string, number>();
  private frameByKey = new Map<string, Frame>();
  private closed = false;

  private constructor(
    browser: Browser,
    context: BrowserContext,
    page: Page,
    options: BrowserSurfaceOptions,
  ) {
    this.browser = browser;
    this.context = context;
    this.pageRef = page;
    this.targetId = options.targetId;
    this.settleTimeoutMs = options.settleTimeoutMs ?? 8_000;
    this.actionTimeoutMs = options.actionTimeoutMs ?? 10_000;
    this.navigationGraceMs = options.navigationGraceMs ?? 600;

    page.on('response', (response) => {
      if (response.request().isNavigationRequest()) {
        this.statusByUrl.set(response.url(), response.status());
      }
    });
  }

  static async launch(options: BrowserSurfaceOptions): Promise<BrowserSurface> {
    const browser = await chromium.launch({ headless: options.headless ?? true });
    const context = await browser.newContext({
      viewport: options.viewport ?? { width: 1280, height: 900 },
    });
    // The extraction function is stringified into the page, and the TypeScript
    // toolchain compiles it with esbuild's keepNames helper, which emits a
    // reference to a `__name` that only exists in the Node bundle. Providing a
    // no-op in every frame is cheaper and far less fragile than hand-writing the
    // extractor as an untyped string.
    await context.addInitScript({
      content: 'globalThis.__name = globalThis.__name || function (f) { return f; };',
    });
    const page = await context.newPage();
    return new BrowserSurface(browser, context, page, options);
  }

  /** The live page, for the operator console to drive during a handoff. */
  get page(): Page {
    return this.pageRef;
  }

  async location(): Promise<string> {
    return this.pageRef.url();
  }

  async observe(): Promise<Observation> {
    await this.settle();
    const frames = this.pageRef.frames();
    const nodes: UiNode[] = [];
    const frameInfos: FrameInfo[] = [];
    const texts: string[] = [];
    let title = '';
    let status: number | undefined;
    const nextFrameByKey = new Map<string, Frame>();

    for (const [index, frame] of frames.entries()) {
      if (frame.isDetached()) continue;
      const path = this.framePath(frame, index);
      const key = frameKeyFor(path);
      nextFrameByKey.set(key, frame);
      frameInfos.push({ path, url: frame.url() });

      const frameStatus = this.statusByUrl.get(frame.url());
      if (frameStatus !== undefined && (status === undefined || frameStatus > status)) {
        status = frameStatus;
      }

      let extract: FrameExtract;
      try {
        extract = await frame.evaluate(extractFrame, key);
      } catch {
        // A frame can navigate out from under us mid-observation. Skipping it
        // is correct: the next observe() picks up whatever replaced it.
        continue;
      }
      if (path.length === 0 && extract.title) title = extract.title;
      if (extract.text) texts.push(extract.text);
      for (const raw of extract.nodes) {
        nodes.push({ ...raw, framePath: path });
      }
    }

    this.frameByKey = nextFrameByKey;

    return {
      observationId: randomUUID(),
      capturedAt: new Date().toISOString(),
      url: this.pageRef.url(),
      title,
      frames: frameInfos,
      nodes,
      text: texts.join('\n'),
      screenFingerprint: fingerprintNodes(nodes),
      ...(status === undefined ? {} : { httpStatus: status }),
    };
  }

  async perform(primitive: Primitive): Promise<void> {
    switch (primitive.kind) {
      case 'navigate':
        await this.pageRef.goto(primitive.url, {
          waitUntil: 'load',
          timeout: this.settleTimeoutMs,
        });
        return;
      case 'waitForIdle':
        await this.settle(primitive.timeoutMs);
        return;
      case 'press':
        await this.withNavigation(async () => {
          if (primitive.ref) {
            await this.locate(primitive.ref).press(primitive.key, { timeout: this.actionTimeoutMs });
          } else {
            await this.pageRef.keyboard.press(primitive.key);
          }
        });
        return;
      case 'click':
        await this.withNavigation(() =>
          this.locate(primitive.ref).click({ timeout: this.actionTimeoutMs }),
        );
        return;
      case 'fill':
        await this.locate(primitive.ref).fill(primitive.text, { timeout: this.actionTimeoutMs });
        return;
      case 'select':
        await this.locate(primitive.ref).selectOption(
          { label: primitive.value },
          { timeout: this.actionTimeoutMs },
        );
        return;
      case 'check':
        await this.locate(primitive.ref).setChecked(primitive.checked, {
          timeout: this.actionTimeoutMs,
        });
        return;
    }
  }

  async screenshot(): Promise<Buffer> {
    return this.pageRef.screenshot({ fullPage: false });
  }

  // --- direct human control -------------------------------------------------
  // These drive the same page the automation was using, which is the whole
  // point: a fresh browser would lose the session cookie, the frameset state
  // and whatever half-finished form the run stopped on.

  async clickAt(x: number, y: number): Promise<void> {
    await this.pageRef.mouse.click(x, y);
    await this.settle(this.navigationGraceMs);
  }

  async typeText(text: string): Promise<void> {
    await this.pageRef.keyboard.type(text, { delay: 12 });
  }

  async pressKey(key: string): Promise<void> {
    await this.pageRef.keyboard.press(key);
    await this.settle(this.navigationGraceMs);
  }

  async viewport(): Promise<{ width: number; height: number }> {
    return this.pageRef.viewportSize() ?? { width: 1280, height: 900 };
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
  }

  /**
   * Clicking a submit button starts a navigation the click promise does not
   * await, so an observation taken straight afterwards can read the screen the
   * agent was leaving. Arming the listener before the action closes that race,
   * and the grace window bounds the cost when nothing navigates.
   */
  private async withNavigation(action: () => Promise<void>): Promise<void> {
    const navigated = this.pageRef
      .waitForEvent('framenavigated', { timeout: this.navigationGraceMs })
      .catch(() => undefined);
    await action();
    await navigated;
    await this.settle();
  }

  private locate(ref: string) {
    const key = ref.split('::')[0] ?? '';
    const frame = this.frameByKey.get(key);
    if (!frame) {
      throw new Error(`no live frame for ref "${ref}"; re-observe before acting`);
    }
    return frame.locator(`[${REF_ATTRIBUTE}="${ref}"]`);
  }

  private framePath(frame: Frame, index: number): string[] {
    const segments: string[] = [];
    let current: Frame | null = frame;
    while (current && current.parentFrame() !== null) {
      segments.unshift(current.name() || `frame#${index}`);
      current = current.parentFrame();
    }
    return segments;
  }

  private async settle(timeoutMs = this.settleTimeoutMs): Promise<void> {
    await this.pageRef.waitForLoadState('load', { timeout: timeoutMs }).catch(() => undefined);
    await Promise.all(
      this.pageRef.frames().map((frame) =>
        frame.waitForLoadState('load', { timeout: timeoutMs }).catch(() => undefined),
      ),
    );
  }
}

export function frameKeyFor(path: readonly string[]): string {
  return path.length === 0 ? '_top' : path.join('/');
}
