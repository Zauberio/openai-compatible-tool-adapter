export type TrimMessage = {
  role: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string }>;
};

const messageBytes = (message: TrimMessage): number =>
  Buffer.byteLength(JSON.stringify(message) || "{}");

/**
 * Bound the message history sent to the provider by dropping the oldest
 * complete (tool_call, tool_result) pairs. The system prompt (index 0) and
 * the first user prompt (index 1) are always preserved, as are standalone
 * assistant text messages. Orphaned tool results (no matching call in the
 * window) are never sent, since providers reject them.
 */
export function trimMessagesForProvider<T extends TrimMessage>(
  messages: T[],
  maxBytes: number,
): T[] {
  if (!(maxBytes > 0) || messages.length <= 2) return messages;

  const head = messages.slice(0, 2);
  const candidates = messages.slice(2);
  const headBytes = head.reduce((total, message) => total + messageBytes(message), 0);

  interface Block {
    callIdx: number;
    resultIdx: number[];
  }
  const blocks: Block[] = [];
  const callIdToBlock = new Map<string, Block>();
  // Indices are original candidate indices; only whole blocks are ever dropped,
  // so removal never shifts the meaning of the remaining indices.
  const dropped = new Set<number>();

  for (let index = 0; index < candidates.length; index += 1) {
    const message = candidates[index];
    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const block: Block = { callIdx: index, resultIdx: [] };
      blocks.push(block);
      for (const call of message.tool_calls) callIdToBlock.set(call.id, block);
      continue;
    }
    if (message.role === "tool" && message.tool_call_id) {
      const block = callIdToBlock.get(message.tool_call_id);
      if (block) {
        block.resultIdx.push(index);
      } else {
        // Tool result without its call in the window: never send it.
        dropped.add(index);
      }
      continue;
    }
  }

  let total = headBytes + candidates.reduce((sum, message, index) => {
    return dropped.has(index) ? sum : sum + messageBytes(message);
  }, 0);

  if (total <= maxBytes) {
    return dropped.size === 0
      ? messages
      : [...head, ...candidates.filter((_, index) => !dropped.has(index))];
  }

  for (const block of blocks) {
    if (total <= maxBytes) break;
    for (const index of [block.callIdx, ...block.resultIdx]) dropped.add(index);
    total = headBytes + candidates.reduce((sum, message, index) => {
      return dropped.has(index) ? sum : sum + messageBytes(message);
    }, 0);
  }

  return [...head, ...candidates.filter((_, index) => !dropped.has(index))];
}
