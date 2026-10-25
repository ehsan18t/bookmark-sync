# Setting up Google Drive sign-in

Google only shows its sign-in window to apps registered in Google Cloud. You do this once, as the publisher of the extension. The client IDs then go into every build, and people using the extension only ever see "Sign in with Google".

It takes about 10 minutes. You need a Google account; a separate one for publishing is a good idea.

## 1. Create the project

1. Open [console.cloud.google.com](https://console.cloud.google.com/) and sign in.
2. In the project picker at the top, choose **New project**. Name it `Bookmark sync` and create it, then make sure it is selected.
3. Open **APIs and services**, then **Library**. Search for **Google Drive API**, open it, and choose **Enable**.

## 2. Set up the consent screen

Google shows this screen when someone signs in. In the console it is under **Google Auth Platform** (older consoles call it **OAuth consent screen**).

1. **Branding:** app name `Bookmark sync`, your support email, and your developer contact email. A logo is optional, but adding one starts a review by Google, so skip it for now.
2. **Audience:** choose **External**.
3. **Data access:** choose **Add or remove scopes**, and add `https://www.googleapis.com/auth/drive.appdata` (shown as "See, create, and delete its own configuration data in your Google Drive"). This is the only scope the extension uses. It can't see any of the user's other Drive files.
4. Back in **Audience**, choose **Publish app** to move it from Testing to In production. Apps in Testing work only for the test users you list, and their sign-ins expire after 7 days, so syncing would stop every week.

If Google asks you to verify the app, follow its prompts. Until it's verified, people may see a "Google hasn't verified this app" screen and have to choose **Advanced**, then **Go to Bookmark sync**.

## 3. Create the client for Chrome, Edge, Brave and Vivaldi

1. Open **Clients** (or **Credentials**), then **Create client**.
2. Application type: **Web application**. Name: `Bookmark sync (Chromium)`.
3. Under **Authorized redirect URIs**, add the address this prints:

   ```bash
   pnpm extension-id
   ```

   It's `https://EXTENSION-ID.chromiumapp.org/`, where the ID comes from `WXT_CHROMIUM_KEY` in `.env`. That key keeps the ID the same on every computer and from every folder.
4. Create it, and copy the **Client ID** and **Client secret**.

When you publish to the Chrome Web Store or Edge Add-ons, each store gives the extension its own ID. Add `https://STORE-ID.chromiumapp.org/` for each one to the same client, next to the first URI.

## 4. Create the client for Firefox

1. Choose **Create client** again.
2. Application type: **Desktop app**. Name: `Bookmark sync (Firefox)`.
3. Create it, and copy the **Client ID** and **Client secret**. Desktop clients don't need a redirect URI. Firefox signs in through `http://127.0.0.1/mozoauth2/...`, a loopback address of the kind Google allows for desktop clients. This hasn't been tried against a real Google account yet.

## 5. Build with the clients

Put the two client IDs in `.env`, which holds every value to set before going live:

```
WXT_GOOGLE_CLIENT_ID_CHROMIUM=1234-abc.apps.googleusercontent.com
WXT_GOOGLE_CLIENT_ID_FIREFOX=5678-def.apps.googleusercontent.com
```

Copy `.env.local.example` to `.env.local` and put the two secrets there. Git ignores `.env.local`:

```
WXT_GOOGLE_CLIENT_SECRET_CHROMIUM=GOCSPX-...
WXT_GOOGLE_CLIENT_SECRET_FIREFOX=GOCSPX-...
```

Then build as usual:

```bash
pnpm build
```

```bash
pnpm build:firefox
```

Google treats the secrets of these two client types as public, because they ship inside every copy of an app, so this is expected.

A build without the clients still works, but it hides Google Drive and offers only your own server. Setting a client ID without its secret stops the build, because Google rejects every sign-in without the secret. `pnpm zip`, which makes the packages you publish, stops with an error if any of the four values is missing, so a release can't ship without Google Drive by mistake.

## If sign-in fails

- **"redirect_uri_mismatch":** the redirect URI in step 3 doesn't match the extension's ID. Open `chrome://extensions`, compare the ID shown under the extension with the one `pnpm extension-id` prints, and add `https://THAT-ID.chromiumapp.org/` to the client.
- **"access_denied" or "app is blocked":** the consent screen is still in Testing and the account isn't a test user. Publish the app (step 2.4), or add the account under **Audience**, **Test users**.
- **"Google didn't accept this version of the extension":** Google answered `invalid_client`, so the client ID or secret in `.env` is wrong. Copy both again from the client's page in step 3 or 4, then rebuild.
- **Brave:** sign-in is off for extensions by default. Turn on "Allow Google login for extensions" in `brave://settings/extensions`. The setup page tells users this.

## The extension's private key

`.keys/extension-key.pem` (ignored by git) is the private half of the key that fixes the extension ID. You only need it to pack a signed `.crx` with the same ID yourself. Keep a copy somewhere safe; if it's lost, unpacked builds keep the same ID anyway, because only the public half in `WXT_CHROMIUM_KEY` is used for that.

To start over with a new ID, run `pnpm make-key`, put the line it prints in `.env`, and update the redirect URI in step 3.
