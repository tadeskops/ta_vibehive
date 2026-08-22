# One-time OAuth setup

VibeHive uses **OAuth 2.0 Authorization Code + PKCE** (RFC 7636) to sign residents
in via **Google** or **Microsoft**. There is no server, no client secret, and
no password to remember or leak.

You need to do the following **once per society deployment** (typically the very
first time you deploy the app, or if the site URL changes). After that,
every resident just taps "Continue with Google" (or Microsoft) and they are
in — no admin work per user.

---

## What you need before you start

1. The public URL where the site is hosted. For GitHub Pages that is
   `https://<user>.github.io/<repo>/` — for The Address · Baner it is:

   ```
   https://tadeskops.github.io/ta_vibehive/
   ```

   The trailing `/` matters — some providers reject URIs without it.

2. Push access to this repo (to commit the client IDs into
   [config/auth.json](../config/auth.json)) — or Admin role in the app so you can
   paste them into `Admin → Settings → Auth` once that tab lands.

3. Around 15 minutes.

---

## 1. Google (recommended — works out of the box)

Google issues **public** OAuth clients that support PKCE with no secret, so
they are safe to embed in a static site. This is the smoothest path.

### 1.1 Create the OAuth client

1. Open [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials).
2. If you don't have a project yet, click **New Project** at the top-right,
   name it `ta_vibehive` (any name works), and select it.
3. Click **CONFIGURE CONSENT SCREEN** (only needed once per project):
   - **User type:** External (unless you have a Google Workspace domain, then
     Internal is safer).
   - **App name:** `VibeHive · The Address` (or whatever your society is called).
   - **User support email:** the committee's email.
   - **Authorized domains:** add `github.io` (or your custom hosting domain).
   - **Scopes:** click **ADD OR REMOVE SCOPES**, tick
     `.../auth/userinfo.email` and `.../auth/userinfo.profile` and `openid`.
     Skip everything else.
   - **Test users:** while the app is in "Testing" mode, add every committee
     member's Gmail address. Once you publish the consent screen this becomes
     unnecessary — but the review is minimal for a "sign-in only" scope set.
   - Save.
4. Back on **Credentials**, click **CREATE CREDENTIALS → OAuth client ID**.
   - **Application type:** `Web application`.
   - **Name:** `VibeHive PKCE`.
   - **Authorized JavaScript origins:** add
     ```
     https://tadeskops.github.io
     ```
     (origin only — no path). If you also use `http://localhost:8081` for
     development, add that too.
   - **Authorized redirect URIs:** add
     ```
     https://tadeskops.github.io/ta_vibehive/
     ```
     (include the trailing `/`). And for dev:
     ```
     http://localhost:8081/ta_vibehive/
     ```
   - Click **Create**. Copy the **Client ID** (looks like
     `1234567890-abcxyz.apps.googleusercontent.com`).

### 1.2 Paste it into the app

Open [config/auth.json](../config/auth.json) and set:

```json
{
  "providers": [
    {
      "id": "google",
      "clientId": "1234567890-abcxyz.apps.googleusercontent.com",
      "...": "..."
    }
  ]
}
```

Commit + push. On the next page load the login screen will show the
`Continue with Google` button.

### 1.3 Publish the consent screen (optional but recommended)

While the consent screen is in "Testing", **only listed test users** can sign
in. Once you have tested the flow with a couple of committee members, go back
to the **OAuth consent screen** page and click **PUBLISH APP**.

Because the app requests only `openid email profile` (no sensitive scopes),
Google does NOT trigger a verification review — publish is immediate.

---

## 2. Microsoft (Entra ID / Azure AD — works out of the box)

Microsoft supports **Single-page application (SPA)** clients that use PKCE
without a client secret. Setup is very similar to Google.

### 2.1 Register the app

1. Open [Microsoft Entra admin center → App registrations](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade).
2. Click **New registration**.
   - **Name:** `VibeHive · The Address`.
   - **Supported account types:** `Accounts in any organizational directory
     and personal Microsoft accounts` (multi-tenant, so residents with an
     `@outlook.com` / `@hotmail.com` account also work).
   - **Redirect URI:** platform `Single-page application (SPA)`, value:
     ```
     https://tadeskops.github.io/ta_vibehive/
     ```
   - Click **Register**.
3. On the Overview page, copy **Application (client) ID**.
4. Go to **Authentication** in the sidebar:
   - Under **Single-page application → Redirect URIs**, add the dev URL
     `http://localhost:8081/ta_vibehive/` if you want to test locally.
   - Under **Implicit grant and hybrid flows**, leave BOTH checkboxes
     UNTICKED — SPA + PKCE does not need them.
   - Under **Allow public client flows**, leave `No`.
   - Save.
5. Go to **API permissions**. The default `User.Read` + `openid email profile`
   set is enough. No admin consent needed.
6. Go to **Token configuration** (optional): under **Optional claims**, add
   `email` for the ID token — a few older tenants don't return `email` by
   default and users would fail to sign in with "provider returned no email".

### 2.2 Paste it into the app

Edit [config/auth.json](../config/auth.json):

```json
{
  "id": "microsoft",
  "clientId": "<paste the Application (client) ID here>",
  "..."
}
```

Commit + push.

---

## 3. Yahoo — DEFERRED (needs a backend proxy)

Yahoo's token endpoint **requires the `client_secret`** in the exchange call,
which means a pure browser SPA cannot use Yahoo directly without leaking the
secret. This is a Yahoo policy, not a VibeHive limitation.

Options:
- **Recommended:** skip Yahoo. Every resident with a Yahoo Mail account also
  has, or can create in 60 seconds, a Google account.
- **Advanced:** stand up a tiny serverless proxy (Cloudflare Worker,
  Vercel Function, GitHub Actions webhook) that holds the client secret and
  forwards the token request. Update `providers[].tokenUrl` to point at
  that proxy. Out of scope for MVP.

The Yahoo entry stays in [config/auth.json](../config/auth.json) with an empty
`clientId` so the login page won't render the button until an admin
consciously configures it.

---

## 4. Verification checklist

- [ ] Google client ID pasted in `config/auth.json`, committed, deployed.
- [ ] Microsoft client ID pasted in `config/auth.json`, committed, deployed.
- [ ] Redirect URI matches EXACTLY on both provider consoles
      (`https://tadeskops.github.io/ta_vibehive/` including the trailing `/`).
- [ ] Local dev URL added on both consoles
      (`http://localhost:8081/ta_vibehive/`) — optional but useful.
- [ ] Google consent screen: added `openid`, `email`, `profile` scopes.
- [ ] Microsoft: SPA platform selected (NOT Web), implicit grant OFF.
- [ ] Tested sign-in end-to-end with a real committee member's Google account.
- [ ] Signed the same person out (whoami pill → Switch → Sign out) and
      confirmed they can sign back in without stale state.

---

## 5. What if I get "redirect_uri_mismatch"?

Google/Microsoft do an **exact string** match on the redirect URI. Common
gotchas:

- `github.io` vs `Github.io` (case matters on some checks — always lowercase).
- Trailing `/` present in one place but not the other.
- HTTP vs HTTPS.
- `www.` prefix on one but not the other.

Copy the URI from your browser's address bar while you are on the site's
root URL (before signing in) — that is the exact string to paste into the
provider console.

---

## 6. What data does VibeHive get from the provider?

Only the four fields returned by the OpenID Connect `userinfo` endpoint:

- `sub` — provider-assigned stable user ID.
- `email` — used as the app-side identity key. Case-insensitive lookup.
- `name` — display name. Editable by the resident afterwards.
- (Optional) `picture` — profile image. VibeHive currently ignores this to
  save bandwidth; may render on the whoami pill in a future release.

No phone number, no address, no OAuth-token-storage, no offline access. The
`access_token` is used exactly once (to call `userinfo`) and then dropped —
never persisted, never sent to any other endpoint.

---

## 7. Removing a provider

Set the provider's `clientId` back to an empty string in
[config/auth.json](../config/auth.json). The login page immediately hides the
button on the next page load. Existing users who signed in via that provider
continue to work — their local user record is provider-agnostic (matched by
email).

If you want to fully unregister the OAuth client, delete it from the
Google Cloud Console / Microsoft Entra admin center. This does NOT wipe the
committee's existing records — VibeHive stores identity, not tokens.

---

## 8. Multi-society deployments

Each society deploys their own copy of the app at their own URL, so each
society needs their own OAuth client (different `clientId` per deployment).
Do NOT reuse a single OAuth client across societies — Google/Microsoft
enforce the redirect URI match, and mixing societies would break sign-in
for everyone.

If you fork this repo, follow steps 1 and 2 again against **your** hosting
URL. The redirect URI you register with the provider must match the URL
where your fork is published.
