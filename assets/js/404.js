'use strict';
/* 404 fallback — keeps CSP happy (no inline JS). */
const back = document.querySelector('a.btn');
if (back) back.addEventListener('click', (e) => { /* nothing; SPA takes over on click */ });
