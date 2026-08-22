import { Router } from '../lib/router.ts';
import { whoami } from './whoami.ts';
import { getSettings, putSettings } from './settings.ts';
import { listEvents, getEvent, putEvent } from './events.ts';
import { createContribution, verifyContribution, listContributions } from './contributions.ts';

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

  // Contributions
  r.get('/contributions', listContributions);
  r.post('/contributions', createContribution);
  r.post('/contributions/:year/:month/:id/verify', verifyContribution);

  return r;
}
