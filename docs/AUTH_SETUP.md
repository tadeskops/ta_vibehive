# One-time OAuth setup

VibeHive uses **OAuth 2.0 Authorization Code + PKCE** (RFC 7636) to sign residents
in via **Google** or **Microsoft**. There is no server, no client secret, and
no password to remember or leak.

## Who does this? (TL;DR)

> **Only ONE person, ONCE, per society deployment** — the developer / committee
> admin who first spins up the site. That's it.
>
> **Residents do NOT do any of this.** A resident's entire sign-in experience is:
>
> 1. Open the site.
> 2. Tap **Continue with Google** (or **Continue with Microsoft**).
> 3. Approve the standard Google/Microsoft consent prompt (once, first time only —
>    if they are already signed into their Google/Microsoft account in that browser
>    it is literally one tap and they're in).
>
> No account creation. No password. No OTP. No admin approval per user.
> No repeat setup on a new device — they just tap the same button.

**Who runs the steps below?**

- **You** (the developer / committee admin doing the initial deploy) — you register
  the app with Google and Microsoft, paste two client IDs into `config/auth.json`,
  commit, push. Takes ~15 minutes total.
- **Nobody else, ever** — unless you change the site's URL, add a new provider, or
  fork the repo for another society (each society deployment is its own OAuth app).

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

## Quick reference — every link you'll need

Bookmark these before you start; the numbered sections below walk through
each in order.

| Provider         | Console page                    | Direct link                                                                                                                                                                   |
| ---------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google           | Cloud Console home              | [https://console.cloud.google.com/](https://console.cloud.google.com/)                                                                                                         |
| Google           | Create/select project           | [https://console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate)                                                                               |
| Google           | OAuth consent screen            | [https://console.cloud.google.com/auth/overview](https://console.cloud.google.com/auth/overview)                                                                               |
| Google           | Credentials (create Client ID)  | [https://console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials)                                                                         |
| Google           | Test users (Testing mode)       | [https://console.cloud.google.com/auth/audience](https://console.cloud.google.com/auth/audience)                                                                               |
| Microsoft        | Entra admin center              | [https://entra.microsoft.com/](https://entra.microsoft.com/)                                                                                                                   |
| Microsoft        | App registrations (create)      | [https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)   |
| Microsoft        | New registration form           | [https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade) |
| Yahoo (deferred) | Developer Network               | [https://developer.yahoo.com/apps/](https://developer.yahoo.com/apps/)                                                                                                         |
| GitHub           | This repo's`config/auth.json` | [https://github.com/tadeskops/ta_vibehive/blob/main/config/auth.json](https://github.com/tadeskops/ta_vibehive/blob/main/config/auth.json)                                     |
| GitHub           | Pages deploy status             | [https://github.com/tadeskops/ta_vibehive/actions](https://github.com/tadeskops/ta_vibehive/actions)                                                                           |
| Live app         | Login page                      | [https://tadeskops.github.io/ta_vibehive/#/login](https://tadeskops.github.io/ta_vibehive/#/login)                                                                             |

**Values you'll paste in both consoles** (copy these once):

| Field                   | Value                                        |
| ----------------------- | -------------------------------------------- |
| Production origin       | `https://tadeskops.github.io`              |
| Production redirect URI | `https://tadeskops.github.io/ta_vibehive/` |
| Local dev origin        | `http://localhost:8081`                    |
| Local dev redirect URI  | `http://localhost:8081/ta_vibehive/`       |
| Scopes                  | `openid email profile`                     |

---

## 1. Google (recommended — works out of the box)

Google issues **public** OAuth clients that support PKCE with no secret, so
they are safe to embed in a static site. This is the smoothest path.

**Time estimate:** ~7 minutes.
**Prerequisite:** a Google account (personal Gmail is fine; use the committee's
shared account if you have one — that way handover to a future admin is trivial).

### 1.1 Create a Google Cloud project (one-time)

1. Open [https://console.cloud.google.com/](https://console.cloud.google.com/) and sign in.
2. At the top-left, next to the "Google Cloud" logo, click the **project
   picker dropdown** (it shows the current project name or "Select a project").
3. In the dialog that opens, click **NEW PROJECT** (top-right).
4. Fill in:
   - **Project name:** `ta_vibehive` (any name works — this is internal).
   - **Organization / Location:** leave as **No organization** unless you
     already have a Google Workspace.
5. Click **CREATE**. Wait ~10 seconds for the project to be provisioned; a
   notification chime confirms it. Click the notification (or reopen the
   project picker) to **switch into the new project**.

**Direct link once selected:**
[https://console.cloud.google.com/apis/dashboard](https://console.cloud.google.com/apis/dashboard)

> ⚠️ Every step below must be done **while your new project is selected** in
> the top bar. If you ever see credentials appear in "someone else's" project
> later, you accidentally created them in a different project — nothing breaks,
> just delete and redo in the right one.

### 1.2 Configure the OAuth consent screen (one-time)

The consent screen is what your residents see the very first time they tap
"Continue with Google": a small dialog saying *"VibeHive · The Address wants
to access your email address and profile info. Allow?"*.

1. Direct link: [https://console.cloud.google.com/auth/overview](https://console.cloud.google.com/auth/overview) (falls back to
   [https://console.cloud.google.com/apis/credentials/consent](https://console.cloud.google.com/apis/credentials/consent) on older UIs).
2. If prompted **"Which type of user will use your app?"**:
   - Choose **External** (unless you have a Google Workspace domain and only
     Workspace users will sign in — then Internal is fine and skips the
     publish step).
   - Click **CREATE**.
3. **OAuth consent screen** form — fill in:
   - **App name:** `VibeHive · The Address` (this text is shown to users).
   - **User support email:** the committee's shared email (e.g.
     `committee@theaddress-society.example`) or your personal Gmail.
   - **App logo:** optional; skip for MVP.
   - **App domain → Application home page:** `https://tadeskops.github.io/ta_vibehive/`
   - **App domain → Authorized domains:** click **+ ADD DOMAIN** and enter
     `tadeskops.github.io` (your specific GitHub Pages subdomain — NOT just
     `github.io`). Google's Public Suffix List treats `github.io` as a
     shared registry (like `.com`), so it will show a red "Missing domain:
     tadeskops.github.io" warning if you enter only `github.io`. If you
     use a custom domain later (e.g. `theaddress.in`), add that too.
   - **Developer contact information → Email addresses:** your email again.
   - Click **SAVE AND CONTINUE**.
4. **Scopes** step — click **ADD OR REMOVE SCOPES**. In the filter box search
   for and tick these three exact rows:
   - `openid`
   - `.../auth/userinfo.email`
   - `.../auth/userinfo.profile`
     Click **UPDATE**. Confirm the three rows appear under "Your non-sensitive
     scopes". **Do NOT add** `.../auth/gmail.*` or anything else — sensitive
     scopes trigger a mandatory Google verification review (weeks of delay).
     Click **SAVE AND CONTINUE**.
5. **Test users** step (only shown for External + Testing mode) — click
   **+ ADD USERS** and paste each committee member's Gmail address, one per
   line. You can add up to 100. Click **ADD**, then **SAVE AND CONTINUE**.
6. **Summary** — review, then click **BACK TO DASHBOARD**.

At this point your consent screen is in **Testing** publishing status. Only
the test users you listed can sign in successfully; anyone else gets a
scary-looking "Access blocked" page. That's fine for the pilot — you'll
publish in §1.4.

### 1.3 Create the OAuth 2.0 Client ID

1. Direct link: [https://console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials).
2. Confirm the top bar shows YOUR project (`ta_vibehive`).
3. Click **+ CREATE CREDENTIALS** (top of page) → **OAuth client ID**.
4. Fill in:
   - **Application type:** `Web application` (dropdown).
   - **Name:** `VibeHive PKCE` (internal label — not shown to users).
   - **Authorized JavaScript origins → + ADD URI:**

     Add each of these as a **separate** entry (click + ADD URI again for
     each). Origins are **scheme + host + port only** — no path, no trailing
     slash:

     ```
     https://tadeskops.github.io
     ```

     ```
     http://localhost:8081
     ```

     (skip the `localhost` entry if you never run local previews).
   - **Authorized redirect URIs → + ADD URI:**

     Add each of these — the trailing `/` IS required:

     ```
     https://tadeskops.github.io/ta_vibehive/
     ```

     ```
     http://localhost:8081/ta_vibehive/
     ```
5. Click **CREATE**. A dialog pops up showing:
   - **Client ID** (looks like `1234567890-abcxyzABC123.apps.googleusercontent.com`).
   - **Client secret** (looks like `GOCSPX-...`) — **IGNORE THIS**. PKCE does
     not use it. Do not paste it anywhere. Do not commit it. It's harmless to
     leave in Google's console.
6. Click the **copy icon** next to Client ID. That's the only value you need.

### 1.4 Publish the consent screen (removes the "test users" limit)

While the consent screen is in **Testing**, only listed test users can sign in.
To let every resident sign in, publish it:

1. Direct link: [https://console.cloud.google.com/auth/overview](https://console.cloud.google.com/auth/overview) (or Credentials
   → OAuth consent screen).
2. Under **Publishing status: Testing**, click **PUBLISH APP**.
3. Confirm the dialog. Publishing status flips to **In production**.

Because you only requested `openid email profile` (non-sensitive scopes),
Google does **NOT** trigger a verification review — publish is immediate and
free. If you ever add a sensitive scope later, you'll be sent through a
formal review; don't do that.

### 1.5 Paste the Client ID into the app

Open [config/auth.json](../config/auth.json) and find the `google` entry.
Replace the empty `clientId` string with what you copied in §1.3.5:

```json
{
  "providers": [
    {
      "id": "google",
      "label": "Continue with Google",
      "icon": "G",
      "clientId": "1234567890-abcxyzABC123.apps.googleusercontent.com",
      "authorizeUrl": "https://accounts.google.com/o/oauth2/v2/auth",
      "tokenUrl": "https://oauth2.googleapis.com/token",
      "userinfoUrl": "https://openidconnect.googleapis.com/v1/userinfo",
      "scope": "openid email profile",
      "extraAuthorizeParams": { "access_type": "online", "include_granted_scopes": "true" }
    },
    ...
  ]
}
```

Commit + push:

```powershell
git add config/auth.json
git commit -m "chore(auth): enable Google OAuth for The Address"
git push origin main
```

Wait ~1 minute for GitHub Pages to redeploy, then hard-reload the site
(`Ctrl+Shift+R`). The **Continue with Google** button now appears on the
login page.

### 1.6 Test end-to-end

1. Open the site in an **Incognito / private window** (this guarantees no
   cached session).
2. Navigate to `#/login`.
3. Click **Continue with Google**.
4. Approve the Google consent dialog (only shown the first time).
5. You should land back on the site at the home page with your name in the
   whoami pill and a toast saying *"Signed in as <Your Name></your>"*.
6. If step 4 shows **"Access blocked: VibeHive has not completed the Google
   verification process"** → you skipped §1.4 publish. Either publish now, or
   add that Gmail address to §1.2.5 test users.

---

## 2. Microsoft (Entra ID / Azure AD — works out of the box)

Microsoft supports **Single-page application (SPA)** clients that use PKCE
without a client secret. Setup takes about 5 minutes and requires just a
free Microsoft account (personal `@outlook.com` works — you do NOT need
Azure paid tier).

**Prerequisite:** a Microsoft account. If you don't have one, create a free
one at [https://signup.live.com/](https://signup.live.com/).

### 2.1 Register a new application

1. Direct link: [https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
   (or navigate: Microsoft Entra admin center → **Applications → App
   registrations**).
2. Sign in with your Microsoft account.
3. If prompted to pick a directory, use the default (a personal tenant is
   auto-created for personal MS accounts — usually called "Default Directory"
   or "MSA").
4. Click **+ New registration** at the top.
5. Fill in:
   - **Name:** `VibeHive · The Address` (shown to users on the consent screen).
   - **Supported account types:** select
     **Accounts in any organizational directory (Any Microsoft Entra ID
     tenant — Multitenant) and personal Microsoft accounts (e.g. Skype, Xbox)**.
     This lets residents with `@outlook.com`, `@hotmail.com`, `@live.com`,
     `@gmail.com`-linked-Microsoft accounts, and work/school accounts all
     sign in.
   - **Redirect URI:**
     - Platform dropdown: **Single-page application (SPA)** — NOT "Web".
       (If you pick "Web", Microsoft demands a client secret and the browser
       flow silently fails.)
     - URL: paste
       ```
       https://tadeskops.github.io/ta_vibehive/
       ```

       (trailing `/` required).
6. Click **Register**. You land on the app's **Overview** page.

### 2.2 Copy the Application (client) ID

On the **Overview** page:

- Copy the **Application (client) ID** — GUID format,
  e.g. `abcd1234-ef56-7890-abcd-ef1234567890`.
- **DO NOT** copy the "Directory (tenant) ID". You don't need it — the app
  uses the `/common` tenant endpoint so any account can sign in.

### 2.3 Add the local-dev redirect URI (optional)

1. In the app's left sidebar, click **Authentication**.
2. Under **Single-page application**, click **Add URI** and enter:
   ```
   http://localhost:8081/ta_vibehive/
   ```
3. Under **Implicit grant and hybrid flows**, confirm BOTH checkboxes
   ("Access tokens" and "ID tokens") are **UNCHECKED**. SPA + PKCE does not
   need implicit grant; leaving them on is a small security downgrade.
4. Under **Advanced settings → Allow public client flows**, leave it **No**.
5. Click **Save** (top of page).

### 2.4 Confirm API permissions (usually already correct)

1. Left sidebar → **API permissions**.
2. You should see one delegated permission: **Microsoft Graph → User.Read**.
   That's enough — `openid`, `email`, `profile` are implicit for OIDC clients.
3. If **User.Read** is missing (rare), click **+ Add a permission** →
   **Microsoft Graph** → **Delegated permissions** → search `User.Read` →
   tick → **Add permissions**.
4. **Grant admin consent** is NOT needed for these low-privilege scopes on
   personal MS accounts. Skip it.

### 2.5 Add the email optional claim (recommended)

Some older/personal-account tokens don't include `email` in the ID token by
default, which makes VibeHive fail with *"provider returned no email"*.
Fix it once:

1. Left sidebar → **Token configuration**.
2. Click **+ Add optional claim**.
3. In the panel: **Token type** = **ID**, then tick `email` in the list.
4. Click **Add**.
5. If prompted *"Some of these claims require Microsoft Graph email
   permission. Turn it on now?"* → tick it → **Add**.

### 2.6 Paste the Client ID into the app

Open [config/auth.json](../config/auth.json) and find the `microsoft` entry:

```json
{
  "id": "microsoft",
  "label": "Continue with Microsoft",
  "icon": "M",
  "clientId": "abcd1234-ef56-7890-abcd-ef1234567890",
  "authorizeUrl": "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  "tokenUrl": "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  "userinfoUrl": "https://graph.microsoft.com/oidc/userinfo",
  "scope": "openid email profile"
}
```

Commit + push (same commands as §1.5). Wait ~1 minute for GitHub Pages to
redeploy, hard-reload, and you should see both **Continue with Google** AND
**Continue with Microsoft** buttons on `#/login`.

### 2.7 Test end-to-end

Same as §1.6 but with the Microsoft button. First-run consent dialog
asks the user to allow *"VibeHive · The Address — View your basic profile,
View your email address, Sign you in"*. That's the correct minimal set.

---

## 3. Yahoo — DEFERRED (needs a backend proxy)

Yahoo's OAuth 2.0 spec **requires the `client_secret`** to be sent in the token
exchange call (see Yahoo's official docs:
[https://developer.yahoo.com/oauth2/guide/flows_authcode/#step-4-exchange-authorization-code-for-access-token](https://developer.yahoo.com/oauth2/guide/flows_authcode/#step-4-exchange-authorization-code-for-access-token)).
A pure-browser SPA cannot hold a secret without leaking it, so Yahoo is
listed under `config/auth.json#unsupported` and no button ever renders.

### 3.1 If you really want Yahoo (advanced — not needed for MVP)

You'd need to add a tiny serverless token-exchange proxy that holds the
`client_secret` server-side and forwards the exchange:

- **Cloudflare Workers** (free tier, ~50 lines):
  [https://developers.cloudflare.com/workers/get-started/guide/](https://developers.cloudflare.com/workers/get-started/guide/)
- **Vercel Functions** (free hobby tier):
  [https://vercel.com/docs/functions](https://vercel.com/docs/functions)
- **GitHub Actions webhook**: possible but slower cold-start; not recommended.

Once the proxy is deployed, register a Yahoo OAuth app at
[https://developer.yahoo.com/apps/create/](https://developer.yahoo.com/apps/create/) (Application Type: **Web
Application**, Redirect URI = the proxy's endpoint) and update
`config/auth.json` with the Yahoo entry pointing `tokenUrl` at your proxy.
This is a multi-day project — deferred until we have a real reason.

### 3.2 What to tell Yahoo Mail users in the meantime

Every Yahoo Mail user can either:

- Sign in with a Google/Microsoft account they already have (most do), or
- Create a free Google account at [https://accounts.google.com/signup](https://accounts.google.com/signup) in
  under 60 seconds.

Once magic-link email lands in a future release (needs the same serverless
slice), Yahoo Mail addresses will "just work" for OTP delivery without any
provider registration.

---

## 4. Verification checklist

Tick off after §1 + §2 are done:

- [ ] **Google Client ID** pasted in `config/auth.json`, committed, pushed.
- [ ] **Microsoft Application (client) ID** pasted in `config/auth.json`,
  committed, pushed.
- [ ] **GitHub Pages deploy** finished (check
  [https://github.com/tadeskops/ta_vibehive/actions](https://github.com/tadeskops/ta_vibehive/actions) — top workflow shows
  a green checkmark).
- [ ] **Google Cloud Console → Credentials → OAuth client** shows:
  - Authorized JavaScript origins: `https://tadeskops.github.io` (+ optional
    `http://localhost:8081`).
  - Authorized redirect URIs: `https://tadeskops.github.io/ta_vibehive/` (+
    optional dev URL).
- [ ] **Google Cloud Console → OAuth consent screen** shows **In production**
  (not Testing) — unless you're okay with pre-listed test users only.
- [ ] **Microsoft Entra → App registration → Authentication** shows platform
  **Single-page application** (NOT "Web") with the correct redirect URI,
  and BOTH implicit-grant checkboxes UNCHECKED.
- [ ] Tested sign-in end-to-end in Incognito with a real Google account →
  landed home with correct name in whoami pill.
- [ ] Tested sign-in end-to-end in Incognito with a real Microsoft account →
  same result.
- [ ] Signed out (whoami pill → **Switch** → **Sign out** button on
  `#/login`) → confirmed signed-out toast → signed back in with no stale
  state.
- [ ] The **login page shows the exact redirect URI** in the code block —
  screenshot it and file it in the committee's onboarding notes so
  whoever inherits admin duties has it ready.

---

## 5. Troubleshooting

### 5.1 `redirect_uri_mismatch` (Google) or `AADSTS50011` (Microsoft)

Both providers do an **exact string** match on the redirect URI. Common
gotchas:

- Trailing `/` present in the console but not in the running site (or vice
  versa). VibeHive's redirect URI **always ends in `/`** — mirror that in
  the console.
- `http://` vs `https://` (localhost is `http`, GitHub Pages is `https`).
- `github.io` vs `Github.io` — the console string is case-sensitive on some
  paths. Always type it lowercase.
- `www.` prefix on one but not the other.
- You edited the console entry but the change hasn't propagated yet — Google
  says it can take up to 5 minutes; Microsoft usually is instant.

**How to verify:** on the login page, copy the redirect URI shown in the
callout code block (the login page shows the exact string the app will send).
Paste that verbatim into the provider console. If they still don't match, one
of them is wrong — the URL bar wins.

### 5.2 Google: "Access blocked: VibeHive has not completed the Google verification process"

Your consent screen is still in **Testing** and the signing-in user is not
in the test users list. Either:

- Publish the consent screen (§1.4), OR
- Add that Gmail to Testing → Test users
  ([https://console.cloud.google.com/auth/overview](https://console.cloud.google.com/auth/overview)).

### 5.3 Microsoft: "AADSTS7000218: The request body must contain the following parameter: `client_assertion` or `client_secret`"

You registered the app as **Web** instead of **Single-page application (SPA)**.
Fix:

1. Entra admin center → your app → **Authentication**.
2. Under **Platform configurations**, delete the "Web" platform (click the
   trash icon).
3. Add a new platform **Single-page application** with the same redirect URI.
4. Save. Retry sign-in.

### 5.4 Microsoft: "provider returned no email"

Your tenant strips `email` from the ID token. Add the optional claim per §2.5.

### 5.5 Sign-in completes but the browser lands on a blank page

The callback URL rewrite in `app.js` didn't fire — usually means the
redirect URI you registered points at a sub-path (e.g. `.../ta_vibehive/index.html`)
instead of the site root (`.../ta_vibehive/`). Change the console entry to
the root path (trailing `/`, no `index.html`).

### 5.6 "Continue with X" button doesn't render at all

- Reload with cache disabled (`Ctrl+Shift+R`).
- Open DevTools → Network → `config/auth.json` — confirm the deployed file
  has your Client ID (not the empty string). If it's still empty, your
  commit didn't reach main / didn't deploy yet.
- Confirm the provider's `clientId` field is a **non-empty string** (not
  `null`, not `0`, not missing).

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
