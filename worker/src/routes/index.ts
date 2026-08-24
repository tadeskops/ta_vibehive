import { Router } from '../lib/router.ts';
import { whoami } from './whoami.ts';
import { getSettings, putSettings } from './settings.ts';
import { listEvents, getEvent, putEvent, deleteEvent } from './events.ts';
import { createContribution, verifyContribution, voidContribution, putContribution, listContributions } from './contributions.ts';
import { createExpense, verifyExpense, putExpense, deleteExpense, listExpenses } from './expenses.ts';
import { getVisitCount, incrementVisitCount } from './metrics.ts';

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
  r.del('/events/:slug', deleteEvent);

  // Contributions
  r.get('/contributions', listContributions);
  r.post('/contributions', createContribution);
  r.put('/contributions/:year/:month/:id', putContribution);
  r.post('/contributions/:year/:month/:id/verify', verifyContribution);
  r.post('/contributions/:year/:month/:id/void', voidContribution);

  // Expenses — same shape as contributions so committee members on
  // any device see rows a resident submitted from theirs.
  r.get('/expenses', listExpenses);
  r.post('/expenses', createExpense);
  r.put('/expenses/:year/:month/:id', putExpense);
  r.del('/expenses/:year/:month/:id', deleteExpense);
  r.post('/expenses/:year/:month/:id/verify', verifyExpense);

  // Metrics — anonymous visit counter (feature-flag gated on the client)
  r.get('/metrics/visit', getVisitCount);
  r.post('/metrics/visit', incrementVisitCount);

  return r;
}
