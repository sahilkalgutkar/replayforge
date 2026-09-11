import type { Assertion } from '../artifact/schema.js';
import { matchesText, resolveTarget } from '../surface/resolve.js';
import type { Observation } from '../surface/types.js';

/**
 * Assertions are how a replay knows it is where it thinks it is.
 *
 * Every evaluation returns *why*, not just whether. A checkpoint that fails
 * with "expected: text containing 'Current Balance'; observed: 'Your session
 * has expired'" is a bug report; one that fails with `false` is a support
 * ticket.
 */

export interface AssertionResult {
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * What a person would say is "on the screen".
 *
 * `observation.text` is the document's rendered text, which deliberately omits
 * the value of a form control — the label on `<input type="submit" value="Sign
 * On">` is not part of innerText. A human looking at that screen would say
 * "Sign On" is on it, and an assertion written by a model that looked at the
 * screen will say so too, so control names and values are folded in here.
 */
function screenText(observation: Observation, framePath?: readonly string[]): string {
  const nodes =
    framePath === undefined
      ? observation.nodes
      : observation.nodes.filter((node) => node.framePath.join('/') === framePath.join('/'));
  const controlText = nodes
    .map((node) => [node.name, node.text, node.value].filter(Boolean).join(' '))
    .join('\n');
  return framePath === undefined ? `${observation.text}\n${controlText}` : controlText;
}

export function evaluateAssertion(
  assertion: Assertion,
  observation: Observation,
): AssertionResult {
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
          ? `${assertion.target.description} is present but was expected to be gone`
          : `${assertion.target.description} is absent, as expected`,
      };
    }
    case 'textPresent':
    case 'textAbsent': {
      const haystack = screenText(observation, assertion.framePath);
      const found = matchesText(assertion.text, haystack);
      const wanted = assertion.kind === 'textPresent';
      const where = assertion.framePath ? ` in frame ${assertion.framePath.join('/')}` : '';
      return {
        ok: found === wanted,
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
      const candidates = [observation.url, ...observation.frames.map((f) => f.url)];
      const hit = candidates.find((url) => pattern.test(url));
      return {
        ok: hit !== undefined,
        detail: hit
          ? `url ${hit} matches /${assertion.pattern}/`
          : `no frame url matches /${assertion.pattern}/ (saw ${candidates.join(', ')})`,
      };
    }
    case 'all': {
      const results = assertion.of.map((inner) => evaluateAssertion(inner, observation));
      const failed = results.find((r) => !r.ok);
      return {
        ok: failed === undefined,
        detail: failed ? `all: first unmet — ${failed.detail}` : `all ${results.length} conditions met`,
      };
    }
    case 'any': {
      const results = assertion.of.map((inner) => evaluateAssertion(inner, observation));
      const passed = results.find((r) => r.ok);
      return {
        ok: passed !== undefined,
        detail: passed
          ? `any: met by — ${passed.detail}`
          : `any: none of ${results.length} conditions met (${results.map((r) => r.detail).join('; ')})`,
      };
    }
    case 'not': {
      const inner = evaluateAssertion(assertion.of, observation);
      return { ok: !inner.ok, detail: `not: inner assertion — ${inner.detail}` };
    }
  }
}

/** A one-line rendering of what an assertion is looking for, for error messages. */
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
