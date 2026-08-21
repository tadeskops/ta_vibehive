// ta_vibehive · Event page bootstrap (G1-01)
//
// Registers the Alpine `eventPage` component on the event route. Kept
// separate from event.js so the module stays test-friendly (event.js
// exports pure functions; this file has the side-effect of Alpine
// registration).

import { eventPage } from './event.js';

document.addEventListener('alpine:init', () => {
  // eslint-disable-next-line no-undef
  Alpine.data('eventPage', () => eventPage('/config/ganpati_2026.json'));
});
