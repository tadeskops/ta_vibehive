import type { Env } from '../env.ts';
import type { Identity } from '../auth/jwt.ts';
import type { Role } from '../auth/roles.ts';

/**
 * Per-request context passed to every route handler. Immutable and small.
 */
export interface Ctx {
  env: Env;
  req: Request;
  url: URL;
  identity?: Identity;
  role: Role;
  ip: string;
}
