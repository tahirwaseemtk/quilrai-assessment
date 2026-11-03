import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { parseChunk, sseDataPayloads } from '../src/sse.js';

async function collect(pieces: Uint8Array[]): Promise<string[]> {
  const payloads: string[] = [];
  for await (const payload of sseDataPayloads(Readable.from(pieces))) payloads.push(payload);
  return payloads;
}

const STREAM = 'data: {"a":"é€😀"}\n\ndata: [DONE]\n\n';
const bytes = Buffer.from(STREAM, 'utf8');

describe('sseDataPayloads', () => {
  it('yields each event payload', async () => {
    expect(await collect([bytes])).toEqual(['{"a":"é€😀"}', '[DONE]']);
  });

  it('gives the same payloads for every byte split', async () => {
    const expected = ['{"a":"é€😀"}', '[DONE]'];
    for (let cut = 0; cut <= bytes.length; cut++) {
      const pieces = [bytes.subarray(0, cut), bytes.subarray(cut)];
      expect(await collect(pieces), `split at byte ${cut}`).toEqual(expected);
    }
  });

  it('accepts CRLF and bare CR line endings', async () => {
    expect(await collect([Buffer.from('data: one\r\n\r\ndata: two\r\r')])).toEqual(['one', 'two']);
  });

  it('joins multi-line data fields and ignores comments and other fields', async () => {
    const text = ': keep-alive\nevent: message\ndata: first\ndata: second\n\n';
    expect(await collect([Buffer.from(text)])).toEqual(['first\nsecond']);
  });

  it('yields a final event that has no blank line after it', async () => {
    expect(await collect([Buffer.from('data: tail\n')])).toEqual(['tail']);
  });
});

describe('parseChunk', () => {
  it('accepts a chat chunk with content', () => {
    expect(parseChunk('{"choices":[{"delta":{"content":"hi"}}]}')?.choices[0]?.delta?.content).toBe(
      'hi',
    );
  });

  it('accepts a usage-only chunk with no choices', () => {
    expect(parseChunk('{"choices":[],"usage":{"total_tokens":3}}')?.choices).toEqual([]);
  });

  it.each(['not json', '{"nope":1}', '[1,2]'])('refuses %s', (payload) => {
    expect(parseChunk(payload)).toBeUndefined();
  });
});

describe('sseDataPayloads line endings across chunks', () => {
  it('does not split an event whose CRLF straddles two chunks', async () => {
    expect(await collect([Buffer.from('data: a\r'), Buffer.from('\ndata: b\r\n\r\n')])).toEqual([
      'a\nb',
    ]);
  });

  it('keeps an event that ends the stream without a blank line', async () => {
    expect(await collect([Buffer.from('data: one\n\ndata: two')])).toEqual(['one', 'two']);
  });
});
