// Fixed messages only: nothing from the upstream, the request or the stack is ever returned.
export const ErrorCode = {
  NotFound: 'NOT_FOUND',
  MethodNotAllowed: 'METHOD_NOT_ALLOWED',
  PayloadTooLarge: 'PAYLOAD_TOO_LARGE',
  InvalidRequest: 'INVALID_REQUEST',
  Unauthorized: 'UNAUTHORIZED',
  RateLimited: 'RATE_LIMITED',
  UpstreamUnavailable: 'UPSTREAM_UNAVAILABLE',
  UpstreamRejected: 'UPSTREAM_REJECTED',
  Internal: 'INTERNAL',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ErrorMessage: Readonly<Record<ErrorCodeValue, string>> = {
  [ErrorCode.NotFound]: 'Not found',
  [ErrorCode.MethodNotAllowed]: 'Method not allowed',
  [ErrorCode.PayloadTooLarge]: 'Request body is too large',
  [ErrorCode.InvalidRequest]: 'Request is invalid',
  [ErrorCode.Unauthorized]: 'Missing or invalid API key',
  [ErrorCode.RateLimited]: 'Token rate limit exceeded',
  [ErrorCode.UpstreamUnavailable]: 'The model provider is unavailable',
  [ErrorCode.UpstreamRejected]: 'The model provider rejected the request',
  [ErrorCode.Internal]: 'Internal error',
};

export const ErrorStatus: Readonly<Record<ErrorCodeValue, number>> = {
  [ErrorCode.NotFound]: 404,
  [ErrorCode.MethodNotAllowed]: 405,
  [ErrorCode.PayloadTooLarge]: 413,
  [ErrorCode.InvalidRequest]: 400,
  [ErrorCode.Unauthorized]: 401,
  [ErrorCode.RateLimited]: 429,
  [ErrorCode.UpstreamUnavailable]: 502,
  [ErrorCode.UpstreamRejected]: 502,
  [ErrorCode.Internal]: 500,
};
