import { describe, expect, it } from 'vitest';
import { LogBuffer } from '../server/log-buffer.js';

describe('LogBuffer', () => {
  it('splits lines and retains only the configured tail', () => {
    const buffer = new LogBuffer(2);
    buffer.append('stdout', 'one\ntwo');
    buffer.append('stderr', 'three');
    expect(buffer.list().map((entry) => `${entry.stream}:${entry.text}`)).toEqual(['stdout:two', 'stderr:three']);
  });
});
