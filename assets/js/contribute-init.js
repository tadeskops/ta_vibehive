// ta_vibehive · Contribute page bootstrap (G1-02)
import { contributePage } from './contribute.js';

document.addEventListener('alpine:init', () => {
  // eslint-disable-next-line no-undef
  Alpine.data('contributePage', () =>
    contributePage('/config/ganpati_2026.json', 'ganpati-2026')
  );
});
