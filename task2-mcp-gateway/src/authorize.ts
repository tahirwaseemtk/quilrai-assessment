import type { Role } from './token-config.js';

export type Decision = 'allow' | 'deny';

// `admin` and `admin_*`, case-insensitive: a downstream that matches tool names without regard to
// case must not be reachable as "Admin_x" by a viewer. No `u` flag, so U+212A (Kelvin) and U+017F
// (long s) do not fold to ASCII letters. Only "_" extends the prefix, as the spec reads
// (ADR 022).
const GATED_NAME = /^admin(_|$)/i;

// Pure and fail-closed: anything but the admin role is treated as unprivileged, and the tool name
// is only ever tested with a regex, never used as a key on an object.
export function authorize(role: Role, toolName: string): Decision {
  if (role === 'admin') return 'allow';
  return GATED_NAME.test(toolName) ? 'deny' : 'allow';
}
