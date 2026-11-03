import { describe, expect, it } from 'vitest';
import { authorize } from '../src/authorize.js';
import type { Role } from '../src/token-config.js';

const roles: Role[] = ['admin', 'viewer'];

describe('authorize', () => {
  it.each(['admin', 'admin_', 'admin_reset_key', 'admin_x'])('lets the admin call %s', (name) => {
    expect(authorize('admin', name)).toBe('allow');
  });

  it.each(['admin', 'admin_', 'admin_reset_key', 'admin_x', 'admin_admin'])(
    'denies the viewer %s',
    (name) => {
      expect(authorize('viewer', name)).toBe('deny');
    },
  );

  it.each(['get_status', 'adminx', 'administrator', 'xadmin', 'x_admin', 'admins', 'admin2'])(
    'lets both roles call the ungated %s',
    (name) => {
      for (const role of roles) expect(authorize(role, name)).toBe('allow');
    },
  );

  // Only "_" extends the prefix, as the spec reads; the pinned decision is in ADR 022.
  it.each(['admin.x', 'admin-x', 'admin.', 'admin-'])('does not gate the punctuated %s', (name) => {
    expect(authorize('viewer', name)).toBe('allow');
  });

  // A downstream that matches names case-insensitively must not be reachable by a viewer.
  it.each(['Admin', 'ADMIN', 'ADMIN_x', 'Admin_reset_key', 'aDmIn_x'])(
    'denies the viewer %s (case-insensitive)',
    (name) => {
      expect(authorize('viewer', name)).toBe('deny');
      expect(authorize('admin', name)).toBe('allow');
    },
  );

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])(
    'treats %s as an ordinary name',
    (name) => {
      for (const role of roles) expect(authorize(role, name)).toBe('allow');
    },
  );

  it('fails closed for a role outside the set', () => {
    expect(authorize('guest' as Role, 'admin_x')).toBe('deny');
    expect(authorize(undefined as unknown as Role, 'admin')).toBe('deny');
    expect(authorize('guest' as Role, 'get_status')).toBe('allow');
  });

  it('is pure: the same inputs give the same result', () => {
    for (let run = 0; run < 3; run++) {
      expect(authorize('viewer', 'admin_x')).toBe('deny');
      expect(authorize('admin', 'admin_x')).toBe('allow');
    }
  });
});
