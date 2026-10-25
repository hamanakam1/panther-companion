/**
 * MemoryProvider — optional long-term memory provider (Pieces-style or a local
 * vector store). The core only depends on this interface; nothing in the
 * reasoning path requires a memory provider.
 */
export interface MemoryProvider {
  readonly id: string;
  /** Search remembered insights/facts relevant to a query. */
  search(query: string, limit?: number): Promise<Array<{ text: string; source: string }>>;
  /** Remember a durable fact the user promoted. */
  remember(text: string, source: string): Promise<void>;
}

export class NoopMemoryProvider implements MemoryProvider {
  readonly id = "none";
  async search(): Promise<Array<{ text: string; source: string }>> {
    return [];
  }
  async remember(): Promise<void> {
    return;
  }
}
