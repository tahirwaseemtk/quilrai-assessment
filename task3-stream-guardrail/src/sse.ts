import { z } from 'zod';

// Limits one unterminated line and one event's data, so a faulty provider cannot grow memory.
export const MAX_EVENT_BYTES = 1_048_576;

// Turns a stream of bytes into the `data:` payloads of server-sent events. The decoder keeps
// multibyte characters whole across chunk boundaries, and lines may end in LF, CRLF or CR.
export async function* sseDataPayloads(source: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8');
  let pending = '';
  let data: string[] = [];
  let dataLength = 0;

  // Splits complete lines off `text` and keeps the rest as `pending`. A CR at the very end is
  // held until the next chunk shows whether an LF follows it, unless the stream has ended.
  const splitLines = (text: string, ended: boolean): string[] => {
    const lines: string[] = [];
    let start = 0;
    for (let index = 0; index < text.length; index++) {
      const char = text.charAt(index);
      if (char !== '\n' && char !== '\r') continue;
      if (char === '\r' && index === text.length - 1 && !ended) break;
      lines.push(text.slice(start, index));
      if (char === '\r' && text.charAt(index + 1) === '\n') index++;
      start = index + 1;
    }
    pending = text.slice(start);
    if (ended && pending !== '') {
      lines.push(pending);
      pending = '';
    }
    return lines;
  };

  // Returns the payload when a blank line ends an event, otherwise undefined.
  const consume = (line: string): string | undefined => {
    if (line === '') {
      if (data.length === 0) return undefined;
      const payload = data.join('\n');
      data = [];
      dataLength = 0;
      return payload;
    }
    if (line.startsWith('data:')) {
      const value = line.slice(5).replace(/^ /, '');
      dataLength += value.length;
      if (dataLength > MAX_EVENT_BYTES) throw new Error('event too large');
      data.push(value);
    }
    return undefined;
  };

  for await (const chunk of source) {
    if (pending.length > MAX_EVENT_BYTES) throw new Error('line too long');
    for (const line of splitLines(pending + decoder.decode(chunk, { stream: true }), false)) {
      const payload = consume(line);
      if (payload !== undefined) yield payload;
    }
  }
  for (const line of splitLines(pending + decoder.decode(), true)) {
    const payload = consume(line);
    if (payload !== undefined) yield payload;
  }
  // An event that ends the stream without a blank line still counts.
  if (data.length > 0) yield data.join('\n');
}

// An allowlist: only the fields the gateway forwards are kept. Zod strips every other key, so
// tool calls, refusals and reasoning text cannot reach the client unredacted.
const chunkSchema = z.object({
  id: z.string().optional(),
  object: z.string().optional(),
  model: z.string().optional(),
  created: z.number().optional(),
  // Required: a usage-only chunk has an empty array, and anything without it is not a chunk.
  choices: z.array(
    z.object({
      index: z.number().optional(),
      delta: z
        .object({
          role: z.string().optional(),
          content: z.string().optional(),
        })
        .optional(),
      finish_reason: z.string().nullable().optional(),
    }),
  ),
});

export type ChunkMessage = z.infer<typeof chunkSchema>;

// Parses one event payload from the provider. A payload that is not a chat chunk is refused
// rather than guessed at.
export function parseChunk(payload: string): ChunkMessage | undefined {
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return undefined;
  }
  const parsed = chunkSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

export const DONE = '[DONE]';

export function encodeEvent(json: unknown): string {
  return `data: ${JSON.stringify(json)}\n\n`;
}
