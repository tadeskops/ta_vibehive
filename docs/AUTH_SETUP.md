# One-time Google sign-in setup

VibeHive uses **Google Identity Services (GIS)** — the same official Google
sign-in library used by our sister app `ta-society-helpdesk`. Residents get
a signed ID token (JWT) after tapping **Continue with Google**; VibeHive
decodes the email + name locally and creates a resident record on first
sign-in. No server, no client secret, no password, no OTP.

## TL;DR

- **Reuse the existing client ID.** The default committed in
  `assets/js/config.js` is `888761828993-…apps.googleusercontent.com`, which
  is already registered with Google under the origin
  `https://tadeskops.github.io/` and already used by `ta-society-helpdesk`.
  Both apps share the same origin, so the same client works for both. If
  you're deploying VibeHive to the same GitHub Pages account, you're done —
  it works out of the box.
- **Only one person, once, per society deployment** ever needs to touch
  Google Cloud Console — and only if you're forking VibeHive to a
  **different** origin (a custom domain, a different GitHub account, etc.).
- **Residents do nothing.** Open the site, tap **Continue with Google**,
  approve Google's standard consent prompt once, they're in. On a new
  device it's still one tap.

## When do you NEED your own client ID?

Only if any of these is true:

1. You're deploying VibeHive under a different origin than
   `https://tadeskops.github.io/` (custom domain, a different GitHub Pages
   account, a personal fork, `localhost` beyond dev, etc.).
2. You want the Google consent screen to show **your society's** name and
   logo instead of the default `ta-society-helpdesk` branding.
3. You want an independent audit trail on Google's side.

If none of these apply, **skip Section A** and jump straight to
[Section C — verify it works](#c-verify-it-works).

## A. Create your own Google OAuth client (only if needed)

1. Open <https://console.cloud.google.com/> and sign in with the Google
   account that will own the OAuth client (typically the committee admin
   account, e.g. `ta.deskops@gmail.com`).
2. Create a project (top-left dropdown → **New project**). Name it
   something like `TA-VibeHive`.
3. Left sidebar → **Google Auth Platform** (or **APIs & Services** →
   **OAuth consent screen**).
4. Set up the consent screen:
   - **User type**: **External**.
   - **App name**: your society name (e.g. `The Address · VibeHive`).
   - **User support email**: your committee admin address.
   - **Developer contact**: same address.
   - **App logo**: optional but recommended
     (`assets/images/bee-circle-512.png` works well).
   - **Application home page**:
     `https://tadeskops.github.io/ta_vibehive/`
   - **Privacy policy URL**:
     `https://tadeskops.github.io/ta_vibehive/privacy.html`
   - **Terms of service URL**:
     `https://tadeskops.github.io/ta_vibehive/terms.html`
   - **Authorized domain**: `tadeskops.github.io` (or your custom domain).
   - **Scopes**: add `openid`, `email`, `profile`. All three are
     non-sensitive → **no verification review needed**.
   - **Audience**: set to **External** and click **Publish app**. Non-sensitive
     scopes only → publishes instantly, no manual review.
5. **Clients** tab → **Create client**:
   - **Application type**: **Web application**.
   - **Name**: `TA-VibeHive Web`.
   - **Authorized JavaScript origins** (add all that apply):
     - `https://tadeskops.github.io`
     - `http://localhost:8081` (for local dev; GIS does not require the
       path, only the origin)
   - **Authorized redirect URIs**: leave empty. GIS doesn't use redirects.
   - Click **Create**. Copy the **Client ID** (long string ending in
     `.apps.googleusercontent.com`).
6. Open `assets/js/config.js`, paste your new Client ID as the value of
   `window.TVH_GOOGLE_CLIENT_ID`, commit + push. GitHub Pages will
   redeploy in about a minute.

## B. Local development

The committed default client ID works from
`http://localhost:8081/ta_vibehive/` too — `localhost` is a special origin
that Google allows for any OAuth client without needing to whitelist it.
You can sign in with a real Google account locally, or use the demo
persona picker which is auto-enabled on `localhost`.

To start the dev server from `IRP_Repo` root:

```powershell
python -m http.server 8081
```

Then open <http://localhost:8081/ta_vibehive/> in a browser.

## C. Verify it works

1. Open the deployed site
   (<https://tadeskops.github.io/ta_vibehive/#/login>).
2. Tap **Continue with Google**.
3. Google's One-Tap prompt or account chooser popup appears. Pick an
   account, approve if it's the first time.
4. The popup closes, a toast reads `Signed in as <your name>`, and the
   header pill shows your real name + role.
5. Reload the page — you should still be signed in (the JWT lives in
   `localStorage.tvh_id_token` until it expires, ~1 hour).

## D. Sign-out and re-auth

`Auth.signOut()` in the browser console clears the token and calls
`google.accounts.id.disableAutoSelect()`, so the next sign-in shows the
full picker instead of silently reusing the previous account. The **Sign
out** button in the login view calls the same path.

## E. Storage keys

- `tvh_id_token` — the raw Google-signed JWT.
- `tvh_signed_in` — `'1'` hint so a fresh tab can attempt silent re-auth.

Nothing else is persisted. No refresh token, no PII beyond what's already
inside the JWT (email, name, picture URL, subject).

## F. Troubleshooting

| Symptom | Fix |
|---|---|
| **Popup blocked / One Tap doesn't appear** | Click **Continue with Google** a second time. The shim falls back to a rendered Google button which opens the popup directly (no cookies/FedCM dependency). |
| **`origin not allowed`** in browser console | The site's origin isn't in the OAuth client's Authorized JavaScript origins list. Add it in Google Cloud Console → Clients → your client → Authorized JavaScript origins. |
| **`invalid_client`** | The `TVH_GOOGLE_CLIENT_ID` in `assets/js/config.js` doesn't match a real client, or was deleted. Re-check or create a new one per Section A step 5. |
| **`CSP violation: script-src`** | Ensure `index.html`'s CSP includes `https://accounts.google.com/gsi/client` in `script-src`. This is committed already; the error would only show if you tightened the CSP by hand. |
| **Signed in on localhost, not on GitHub Pages** | The default client ID is registered for `https://tadeskops.github.io` — a fork on a different account needs its own client (Section A). |

## G. Removing Google sign-in for a build

Set `window.TVH_GOOGLE_CLIENT_ID = ''` in `assets/js/config.js`. The login
view will auto-fall-back to the demo persona picker. Useful for
contributor builds where you don't want Google popping up.
