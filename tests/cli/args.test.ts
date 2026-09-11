import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boolFlag, flag, parseArgs, requireFlag } from '../../src/cli/args.js';
import { loadEnvFile } from '../../src/cli/env.js';

describe('argument parsing', () => {
  it('takes the command, then positionals, then flags', () => {
    const args = parseArgs(['replay', 'member_savings_balance', '--target', 'http://localhost:4310']);
    expect(args.command).toBe('replay');
    expect(args.positional).toEqual(['member_savings_balance']);
    expect(args.flags.target).toBe('http://localhost:4310');
  });

  it('accepts a flag written with an equals sign', () => {
    expect(parseArgs(['replay', '--target=http://x']).flags.target).toBe('http://x');
  });

  it('treats a flag with no value as a switch', () => {
    const args = parseArgs(['replay', '--headed', '--target', 'http://x']);
    expect(boolFlag(args, 'headed')).toBe(true);
    expect(boolFlag(args, 'confirm-risky')).toBe(false);
    expect(boolFlag(parseArgs(['x', '--confirm-risky=true']), 'confirm-risky')).toBe(true);
  });

  it('collects repeated key=value flags into a map', () => {
    const args = parseArgs([
      'discover',
      '--input',
      'memberNumber=10021',
      '--input',
      'branch=Fremont',
      '--secret',
      'core_password=MERIDIAN_PASSWORD',
    ]);
    expect(args.pairs.input).toEqual({ memberNumber: '10021', branch: 'Fremont' });
    expect(args.pairs.secret).toEqual({ core_password: 'MERIDIAN_PASSWORD' });
  });

  it('keeps a value that itself contains an equals sign', () => {
    expect(parseArgs(['x', '--input', 'note=a=b']).pairs.input).toEqual({ note: 'a=b' });
  });

  it('rejects a pair flag that is not a pair', () => {
    expect(() => parseArgs(['discover', '--input', 'memberNumber'])).toThrow(/expects key=value/);
    expect(() => parseArgs(['discover', '--input'])).toThrow(/expects key=value/);
  });

  it('defaults to help when nothing was asked for', () => {
    expect(parseArgs([]).command).toBe('help');
  });

  it('requires the flags a command cannot run without', () => {
    const args = parseArgs(['replay', '--target', 'http://x']);
    expect(requireFlag(args, 'target')).toBe('http://x');
    expect(() => requireFlag(args, 'goal')).toThrow(/--goal is required/);
    expect(() => requireFlag(parseArgs(['x', '--goal']), 'goal')).toThrow(/required/);
  });

  it('falls back to a default for optional flags', () => {
    const args = parseArgs(['replay', '--store', 'caps']);
    expect(flag(args, 'store', 'capabilities')).toBe('caps');
    expect(flag(args, 'evidence', 'evidence')).toBe('evidence');
  });
});

describe('env file loading', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'replayforge-env-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    delete process.env.RF_TEST_ONE;
    delete process.env.RF_TEST_QUOTED;
    delete process.env.RF_TEST_PRESET;
  });

  it('reads pairs, ignoring blanks and comments, and strips quotes', async () => {
    const path = join(dir, '.env');
    await writeFile(path, '\n# a comment\nRF_TEST_ONE=first\nRF_TEST_QUOTED="a value"\nnot a pair\n');
    loadEnvFile(path);
    expect(process.env.RF_TEST_ONE).toBe('first');
    expect(process.env.RF_TEST_QUOTED).toBe('a value');
  });

  it('never overwrites something already set, so an inline value wins', async () => {
    process.env.RF_TEST_PRESET = 'from the shell';
    const path = join(dir, '.env');
    await writeFile(path, 'RF_TEST_PRESET=from the file\n');
    loadEnvFile(path);
    expect(process.env.RF_TEST_PRESET).toBe('from the shell');
  });

  it('does nothing at all when there is no file', () => {
    expect(() => loadEnvFile(join(dir, 'absent'))).not.toThrow();
  });
});
