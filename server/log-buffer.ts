import type { LogEntry } from '../shared/types.js';

export class LogBuffer {
  private entries: LogEntry[] = [];
  constructor(private readonly capacity = 500) {}

  append(stream: LogEntry['stream'], text: string): LogEntry[] {
    const added = text.split(/\r?\n/).filter(Boolean).map((line) => ({ at: new Date().toISOString(), stream, text: line }));
    this.entries.push(...added);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    return added;
  }

  list(): LogEntry[] { return [...this.entries]; }
}
