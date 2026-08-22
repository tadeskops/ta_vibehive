import { Router } from '../lib/router.ts';
import { whoami } from './whoami.ts';
import { getSettings, putSettings } from './settings.ts';
import { listEvents, getEvent, putEvent } from './events.ts';

export function buildRouter(): Router {
  const r = new Router();

  // Identity
  r.get('/whoami', whoami);

  // Society-wide settings (overrides doc)
  r.get('/settings', getSettings);
  r.put('/settings', putSettings);

  // Events
  r.get('/events', listEvents);
  r.get('/events/:slug', getEvent);
  r.put('/events/:slug', putEvent);

  return r;
}
