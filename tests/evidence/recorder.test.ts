import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunRecorder } from '../../src/evidence/recorder.js';
import { Redactor } from '../../src/policy/redactor.js';

let root: string;
const redactor = new Redactor({ secrets: { core_password: 'demo-pass-01' } });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'replayforge-evidence-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function lines(directory: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(join(directory, 'run.jsonl'), 'utf8');
  return raw.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('run recorder', () => {
  it('appends each event as it happens, so a killed run still leaves a trail', async () => {
    const recorder = await RunRecorder.open(root, 'run-1', redactor);
    await recorder.event('run.started', { capability: 'member_savings_balance' });
    const written = await lines(recorder.directory);
    expect(written).toHaveLength(1);

    await recorder.event('step.started', { stepId: 'open_console' });
    expect(await lines(recorder.directory)).toHaveLength(2);
  });

  it('numbers events in order and timestamps them', async () => {
    const recorder = await RunRecorder.open(root, 'run-2', redactor);
    await recorder.event('a');
    await recorder.event('b');
    const written = await lines(recorder.directory);
    expect(written.map((e) => e.seq)).toEqual([1, 2]);
    expect(typeof written[0]?.at).toBe('string');
  });

  it('redacts every event payload on the way to disk', async () => {
    const recorder = await RunRecorder.open(root, 'run-3', redactor);
    await recorder.event('action.performed', {
      value: 'demo-pass-01',
      observed: { text: 'SSN 412-55-9087' },
    });
    const raw = await readFile(join(recorder.directory, 'run.jsonl'), 'utf8');
    expect(raw).not.toContain('demo-pass-01');
    expect(raw).not.toContain('412-55-9087');
    expect(raw).toContain('«secret:core_password»');
    expect(raw).toContain('«ssn»');
  });

  it('keeps only failure captures under the default screenshot policy', async () => {
    const recorder = await RunRecorder.open(root, 'run-4', redactor);
    const capture = async (): Promise<Buffer> => Buffer.from('png');
    expect(await recorder.screenshot('step', capture, 'step')).toBeUndefined();
    expect(await recorder.screenshot('boom', capture, 'failure')).toMatch(/-boom\.png$/);
    const files = await readdir(recorder.directory);
    expect(files.filter((f) => f.endsWith('.png'))).toHaveLength(1);
  });

  it('captures every step when asked, and nothing at all when told not to', async () => {
    const capture = async (): Promise<Buffer> => Buffer.from('png');
    const chatty = await RunRecorder.open(root, 'run-5', redactor, 'always');
    expect(await chatty.screenshot('one', capture, 'step')).toBeDefined();

    const silent = await RunRecorder.open(root, 'run-6', redactor, 'never');
    expect(await silent.screenshot('two', capture, 'failure')).toBeUndefined();
    expect((await readdir(silent.directory)).filter((f) => f.endsWith('.png'))).toHaveLength(0);
  });

  it('logs the screenshot it wrote so the trail explains the file', async () => {
    const recorder = await RunRecorder.open(root, 'run-7', redactor);
    await recorder.screenshot('failure', async () => Buffer.from('png'), 'failure');
    expect(recorder.history().map((e) => e.type)).toContain('evidence.screenshot');
  });

  it('writes redacted JSON side files', async () => {
    const recorder = await RunRecorder.open(root, 'run-8', redactor);
    await recorder.writeJson('result', { status: 'success', note: 'used demo-pass-01' });
    const raw = await readFile(join(recorder.directory, 'result.json'), 'utf8');
    expect(raw).toContain('«secret:core_password»');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('keeps an in-memory history matching what it wrote', async () => {
    const recorder = await RunRecorder.open(root, 'run-9', redactor);
    await recorder.event('run.started');
    await recorder.event('run.finished', { status: 'success' });
    expect(recorder.history().map((e) => e.type)).toEqual(['run.started', 'run.finished']);
    expect(recorder.history()).toHaveLength((await lines(recorder.directory)).length);
  });
});
