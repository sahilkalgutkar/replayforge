import { describe, expect, it } from 'vitest';
import { boolFlag, flag, parseArgs, requireFlag } from '../../src/cli/args.js';

describe('parsing arguments', () => {
  it('reads the command, positionals and flags in either form', () => {
    const args = parseArgs(['replay', 'member_savings_balance', '--target', 'http://x', '--version=2']);
    expect(args.command).toBe('replay');
    expect(args.positional).toEqual(['member_savings_balance']);
    expect(args.flags).toEqual({ target: 'http://x', version: '2' });
  });

  it('treats a bare flag as a switch', () => {
    const args = parseArgs(['replay', '--headed', '--target', 'http://x']);
    expect(boolFlag(args, 'headed')).toBe(true);
    expect(boolFlag(args, 'operator')).toBe(false);
    expect(boolFlag(parseArgs(['x', '--confirm-risky=true']), 'confirm-risky')).toBe(true);
  });

  it('collects repeated key=value flags, keeping any = in the value', () => {
    const args = parseArgs(['discover', '--input', 'memberNumber=10021', '--input', 'note=a=b', '--probe', 'memberNumber=99999']);
    expect(args.pairs.input).toEqual({ memberNumber: '10021', note: 'a=b' });
    expect(args.pairs.probe).toEqual({ memberNumber: '99999' });
  });

  it('rejects a pair flag that isn’t a pair', () => {
    expect(() => parseArgs(['discover', '--input', 'memberNumber'])).toThrow(/expects key=value/);
    expect(() => parseArgs(['discover', '--input'])).toThrow(/expects key=value/);
  });

  it('defaults to help, requires what it needs, and falls back for the rest', () => {
    expect(parseArgs([]).command).toBe('help');
    const args = parseArgs(['replay', '--target', 'http://x', '--goal']);
    expect(requireFlag(args, 'target')).toBe('http://x');
    expect(() => requireFlag(args, 'goal')).toThrow(/--goal is required/);
    expect(() => requireFlag(args, 'name')).toThrow(/--name is required/);
    expect(flag(args, 'store', 'capabilities')).toBe('capabilities');
  });
});
