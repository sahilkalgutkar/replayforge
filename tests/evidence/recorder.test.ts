import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunRecorder } from '../../src/evidence/recorder.js';
import { Redactor } from '../../src/policy/redactor.js';

let root: string;
const redactor = new Redactor({ secrets: { core_password: 'demo-pass-01' } });
const png = async (): Promise<Buffer> => Buffer.from('png');

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
  it('writes each event as it happens, numbered and timestamped', async () => {
    const recorder = await RunRecorder.open(root, 'run-1', redactor);
    await recorder.event('run.started', { capability: 'member_savings_balance' });
    expect(await lines(recorder.directory)).toHaveLength(1);
    await recorder.event('step.started', { stepId: 'open_console' });
    const written = await lines(recorder.directory);
    expect(written.map((e) => e.seq)).toEqual([1, 2]);
    expect(typeof written[0]?.at).toBe('string');
    expect(recorder.history()).toHaveLength(2);
  });

  it('redacts payloads on the way to disk', async () => {
    const recorder = await RunRecorder.open(root, 'run-2', redactor);
    await recorder.event('action.performed', { value: 'demo-pass-01', observed: { text: 'SSN 412-55-9087' } });
    const raw = await readFile(join(recorder.directory, 'run.jsonl'), 'utf8');
    expect(raw).not.toContain('demo-pass-01');
    expect(raw).not.toContain('412-55-9087');
    expect(raw).toContain('«secret:core_password»');
    expect(raw).toContain('«ssn»');
  });

  it('keeps only failure screenshots by default, and logs the file it wrote', async () => {
    const recorder = await RunRecorder.open(root, 'run-3', redactor);
    expect(await recorder.screenshot('step', png, 'step')).toBeUndefined();
    expect(await recorder.screenshot('boom', png, 'failure')).toMatch(/-boom\.png$/);
    expect((await readdir(recorder.directory)).filter((f) => f.endsWith('.png'))).toHaveLength(1);
    expect(recorder.history().map((e) => e.type)).toContain('evidence.screenshot');
  });

  it('captures every step when asked, and nothing when told not to', async () => {
    const chatty = await RunRecorder.open(root, 'run-4', redactor, 'always');
    expect(await chatty.screenshot('one', png, 'step')).toBeDefined();
    const silent = await RunRecorder.open(root, 'run-5', redactor, 'never');
    expect(await silent.screenshot('two', png, 'failure')).toBeUndefined();
  });

  it('writes redacted JSON side files', async () => {
    const recorder = await RunRecorder.open(root, 'run-6', redactor);
    await recorder.writeJson('result', { status: 'success', note: 'used demo-pass-01' });
    const raw = await readFile(join(recorder.directory, 'result.json'), 'utf8');
    expect(raw).toContain('«secret:core_password»');
    expect(raw.endsWith('\n')).toBe(true);
  });
});
