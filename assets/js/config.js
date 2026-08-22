/* VibeHive global config — regular <script> so index.html can read it
 * before any ES module boots. Mirrors the ta-society-helpdesk pattern
 * (docs/assets/js/config.js) so the same Google OAuth "Web application"
 * client ID can be reused across both apps — they both live at
 * https://tadeskops.github.io/, which is the only Authorized JavaScript
 * origin Google actually checks for Google Identity Services (GIS).
 *
 * How to change it later:
 *   - Local override: paste `window.TVH_GOOGLE_CLIENT_ID = '<new id>'`
 *     into the DevTools console before Auth.init runs.
 *   - Permanent: edit this file, commit, push. GitHub Pages redeploys
 *     in ~1 min.
 *
 * Security posture: the Client ID is a PUBLIC identifier by design.
 * Google verifies the calling origin, not the ID itself. There is no
 * client_secret involved — GIS uses the auth-code+PKCE flow internally
 * but never asks the browser to hold a secret.
 */
window.TVH_GOOGLE_CLIENT_ID = '888761828993-d38vmjdjnuns2ubksvpdmkv860qeeap5.apps.googleusercontent.com';
