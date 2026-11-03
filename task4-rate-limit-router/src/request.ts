import { z } from 'zod';

// Anything beyond these fields is refused, so the provider only ever sees a known shape.
export const completionRequest = z
  .object({
    prompt: z.string().min(1).max(100_000),
    max_tokens: z.number().int().min(1).max(4096),
    model: z.string().min(1).max(100).optional(),
  })
  .strict();

export type CompletionRequest = z.infer<typeof completionRequest>;

// A deliberately rough estimate (about four characters per token) plus the requested output.
// The reservation is reconciled with the provider's real count after the call.
export function estimateTokens(request: CompletionRequest): number {
  return Math.ceil(request.prompt.length / 4) + request.max_tokens;
}
