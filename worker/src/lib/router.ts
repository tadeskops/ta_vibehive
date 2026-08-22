import type { Ctx } from './ctx.ts';

type Params = Record<string, string>;
type Handler = (ctx: Ctx, params: Params) => Response | Promise<Response>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function compile(pattern: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const src = pattern
    .replace(/\/$/, '')
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    });
  return { regex: new RegExp('^' + src + '/?$'), keys };
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    const { regex, keys } = compile(pattern);
    this.routes.push({ method: method.toUpperCase(), pattern: regex, keys, handler });
    return this;
  }

  get(pattern: string, handler: Handler): this { return this.add('GET', pattern, handler); }
  post(pattern: string, handler: Handler): this { return this.add('POST', pattern, handler); }
  put(pattern: string, handler: Handler): this { return this.add('PUT', pattern, handler); }
  patch(pattern: string, handler: Handler): this { return this.add('PATCH', pattern, handler); }
  del(pattern: string, handler: Handler): this { return this.add('DELETE', pattern, handler); }

  match(method: string, pathname: string): { handler: Handler; params: Params } | null {
    const m = method.toUpperCase();
    for (const r of this.routes) {
      if (r.method !== m) continue;
      const match = r.pattern.exec(pathname);
      if (!match) continue;
      const params: Params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(match[i + 1] ?? ''); });
      return { handler: r.handler, params };
    }
    return null;
  }
}
