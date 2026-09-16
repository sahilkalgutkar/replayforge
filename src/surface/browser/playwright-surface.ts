import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright';
import { fingerprintNodes } from '../fingerprint.js';
import type { FrameInfo, Observation, Primitive, Surface, UiNode } from '../types.js';
import { extractFrame, REF_ATTRIBUTE, type FrameExtract } from './extract.js';

export interface BrowserSurfaceOptions {
  readonly targetId: string;
  readonly headless?: boolean;
  readonly settleTimeoutMs?: number;
  readonly actionTimeoutMs?: number;
  /**
   * How long to wait after a click or key press for a navigation to start.
   * Resolves as soon as one does, so it only costs the full wait when the
   * action stays on the same screen.
   */
  readonly navigationGraceMs?: number;
  readonly viewport?: { width: number; height: number };
}

/**
 * The browser side of the surface. This is the only file that knows about
 * Playwright, frames and the DOM.
 */
export class BrowserSurface implements Surface {
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
    // The extractor is stringified into the page, and the build step compiles
    // it with a helper that references a `__name` only present in Node. A no-op
    // in every frame is cheaper than hand-writing the extractor as a string.
    await context.addInitScript({
      content: 'globalThis.__name = globalThis.__name || function (f) { return f; };',
    });
    const page = await context.newPage();
    return new BrowserSurface(browser, context, page, options);
  }

  /** The live page, for a person to drive during a handoff. */
  get page(): Page {
    return this.pageRef;
  }

  async location(): Promise<string> {
    return this.pageRef.url();
  }

  async observe(): Promise<Observation> {
    await this.settle();
    const nodes: UiNode[] = [];
    const frameInfos: FrameInfo[] = [];
    const texts: string[] = [];
    const nextFrameByKey = new Map<string, Frame>();
    let title = '';
    let status: number | undefined;

    for (const [index, frame] of this.pageRef.frames().entries()) {
      if (frame.isDetached()) continue;
      const path = this.framePath(frame, index);
      const key = frameKeyFor(path);
      nextFrameByKey.set(key, frame);
      frameInfos.push({ path, url: frame.url() });

      // A frameset answers 200 for the shell while the frame inside it answers
      // 403, and it's the 403 that matters.
      const frameStatus = this.statusByUrl.get(frame.url());
      if (frameStatus !== undefined && (status === undefined || frameStatus > status)) {
        status = frameStatus;
      }

      let extract: FrameExtract;
      try {
        extract = await frame.evaluate(extractFrame, key);
      } catch {
        // A frame can navigate away mid-observation. The next observe() picks
        // up whatever replaced it.
        continue;
      }
      if (path.length === 0 && extract.title) title = extract.title;
      if (extract.text) texts.push(extract.text);
      for (const raw of extract.nodes) nodes.push({ ...raw, framePath: path });
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
        await this.pageRef.goto(primitive.url, { waitUntil: 'load', timeout: this.settleTimeoutMs });
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
        await this.withNavigation(() => this.locate(primitive.ref).click({ timeout: this.actionTimeoutMs }));
        return;
      case 'fill':
        await this.locate(primitive.ref).fill(primitive.text, { timeout: this.actionTimeoutMs });
        return;
      case 'select':
        await this.locate(primitive.ref).selectOption({ label: primitive.value }, { timeout: this.actionTimeoutMs });
        return;
      case 'check':
        await this.locate(primitive.ref).setChecked(primitive.checked, { timeout: this.actionTimeoutMs });
        return;
    }
  }

  async screenshot(): Promise<Buffer> {
    return this.pageRef.screenshot({ fullPage: false });
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
  }

  // Clicking a submit button starts a navigation the click promise doesn't wait
  // for, so an observation taken straight afterwards can read the screen being
  // left behind. Arming the listener first closes that gap.
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
    if (!frame) throw new Error(`no live frame for ref "${ref}", re-observe before acting`);
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
      this.pageRef
        .frames()
        .map((frame) => frame.waitForLoadState('load', { timeout: timeoutMs }).catch(() => undefined)),
    );
  }
}

export function frameKeyFor(path: readonly string[]): string {
  return path.length === 0 ? '_top' : path.join('/');
}
