import type { Assertion } from '../artifact/schema.js';
import { matchesText, resolveTarget } from '../surface/resolve.js';
import type { Observation } from '../surface/types.js';

// Every check says why it passed or failed, not just whether. "expected text
// 'Current Balance', saw 'Your session has expired'" is something you can act
// on; `false` isn't.

export interface AssertionResult {
  readonly ok: boolean;
  readonly detail: string;
}

// What a person would say is on the screen. The page's rendered text leaves out
// form control values, so the label on a submit button isn't in it, but anyone
// looking at the screen would say it is.
function screenText(observation: Observation, framePath?: readonly string[]): string {
  const nodes =
    framePath === undefined
      ? observation.nodes
      : observation.nodes.filter((node) => node.framePath.join('/') === framePath.join('/'));
  const controlText = nodes.map((node) => [node.name, node.text, node.value].filter(Boolean).join(' ')).join('\n');
  return framePath === undefined ? `${observation.text}\n${controlText}` : controlText;
}

export function evaluateAssertion(assertion: Assertion, observation: Observation): AssertionResult {
  switch (assertion.kind) {
    case 'targetPresent': {
      const resolution = resolveTarget(assertion.target, observation);
      return {
        ok: resolution.ok,
        detail: resolution.ok
          ? `found ${assertion.target.description} on rung ${resolution.rung}`
          : `did not find ${assertion.target.description}`,
      };
    }
    case 'targetAbsent': {
      const resolution = resolveTarget(assertion.target, observation);
      return {
        ok: !resolution.ok,
        detail: resolution.ok
          ? `${assertion.target.description} is still there`
          : `${assertion.target.description} is gone, as expected`,
      };
    }
    case 'textPresent':
    case 'textAbsent': {
      const found = matchesText(assertion.text, screenText(observation, assertion.framePath));
      const where = assertion.framePath ? ` in frame ${assertion.framePath.join('/')}` : '';
      return {
        ok: found === (assertion.kind === 'textPresent'),
        detail: `text ${assertion.text.mode} "${assertion.text.value}"${where} was ${found ? 'present' : 'absent'}`,
      };
    }
    case 'httpStatusIn': {
      const status = observation.httpStatus;
      return {
        ok: status !== undefined && assertion.statuses.includes(status),
        detail: `http status ${status ?? 'unknown'}, expected one of ${assertion.statuses.join(', ')}`,
      };
    }
    case 'urlMatches': {
      const pattern = new RegExp(assertion.pattern);
      const urls = [observation.url, ...observation.frames.map((frame) => frame.url)];
      const hit = urls.find((url) => pattern.test(url));
      return {
        ok: hit !== undefined,
        detail: hit ? `url ${hit} matches /${assertion.pattern}/` : `no frame url matches /${assertion.pattern}/`,
      };
    }
    case 'all': {
      const failed = assertion.of.map((inner) => evaluateAssertion(inner, observation)).find((r) => !r.ok);
      return {
        ok: failed === undefined,
        detail: failed ? `first unmet: ${failed.detail}` : `all ${assertion.of.length} conditions met`,
      };
    }
    case 'any': {
      const results = assertion.of.map((inner) => evaluateAssertion(inner, observation));
      const passed = results.find((r) => r.ok);
      return {
        ok: passed !== undefined,
        detail: passed
          ? `met by: ${passed.detail}`
          : `none of ${results.length} conditions met (${results.map((r) => r.detail).join('; ')})`,
      };
    }
    case 'not': {
      const inner = evaluateAssertion(assertion.of, observation);
      return { ok: !inner.ok, detail: `not: ${inner.detail}` };
    }
  }
}

/** One line describing what an assertion looks for. */
export function describeAssertion(assertion: Assertion): string {
  switch (assertion.kind) {
    case 'targetPresent':
      return `${assertion.target.description} is present`;
    case 'targetAbsent':
      return `${assertion.target.description} is gone`;
    case 'textPresent':
      return `text ${assertion.text.mode} "${assertion.text.value}"`;
    case 'textAbsent':
      return `no text ${assertion.text.mode} "${assertion.text.value}"`;
    case 'httpStatusIn':
      return `http status in [${assertion.statuses.join(', ')}]`;
    case 'urlMatches':
      return `url matching /${assertion.pattern}/`;
    case 'all':
      return `all of (${assertion.of.map(describeAssertion).join(', ')})`;
    case 'any':
      return `any of (${assertion.of.map(describeAssertion).join(', ')})`;
    case 'not':
      return `not (${describeAssertion(assertion.of)})`;
  }
}
