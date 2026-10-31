# Publishing to Firefox

Firefox only installs extensions that Mozilla has signed. This guide covers getting Bookmark sync signed and, if you want, listed on [addons.mozilla.org](https://addons.mozilla.org) (AMO), Mozilla's add-on store. It assumes no prior knowledge.

There are three parts:

1. **One-time setup:** an account, API keys and a fixed add-on ID. You do this once, ever.
2. **Every release:** a new version number and a build.
3. **The upload:** unlisted, listed, or both.

## Unlisted or listed

Every version you upload is either **unlisted** or **listed**. You choose per upload.

| | Unlisted ("on your own") | Listed ("on this site") |
|---|---|---|
| What you get | A signed `.xpi` file to share yourself, for example on GitHub Releases | A public page on addons.mozilla.org |
| How people install it | Open the `.xpi` in Firefox and choose **Add** | Choose **Add to Firefox** on the store page |
| Review | Automatic checks only, signed within minutes | Automatic checks, then a human review that takes days, sometimes a couple of weeks |
| Updates | People download each new `.xpi` themselves | Firefox updates it automatically |
| Source code upload | Not needed | Needed every time, because the build is bundled |
| Listing details | None | Description, screenshots, privacy policy and more |
| Command | `pnpm firefox:unlisted` | `pnpm firefox:listed` (after the first listed version) |

Two rules apply to both:

- **A version number can be used only once**, across both kinds. If 1.2.0 was uploaded unlisted, the store version must be 1.2.1 or later, even with identical code.
- **An upload can't change kind afterwards.** An unlisted version stays unlisted.

## 1. One-time setup

### Create a developer account

1. Go to [addons.mozilla.org/developers](https://addons.mozilla.org/developers/) and choose **Log in**. Sign in with a Mozilla account, or create one. It's free.
2. Mozilla asks you to accept the **Firefox Add-on Distribution Agreement**, and may ask you to turn on two-step sign-in. Do both.

### Create API keys

The commands in this guide talk to Mozilla through its API, which needs a key pair.

1. Open [Developer Hub, then Manage API Keys](https://addons.mozilla.org/developers/addon/api/key/).
2. Choose **Generate new credentials**. You get:
   - a **JWT issuer**, which looks like `user:12345:678`,
   - a **JWT secret**, a long random string.
3. Add both to `.env` in the project. Git ignores this file, so they are never committed:

   ```
   WEB_EXT_API_KEY=user:12345:678
   WEB_EXT_API_SECRET=the-long-secret
   ```

Treat the secret like a password: anyone with it can upload versions of your add-on. If it leaks, revoke it on the same page and generate a new pair.

### Fix the add-on ID

`WXT_GECKO_ID` in `.env` is the add-on's permanent identity, for example `bookmark-sync@your-domain`. It must be set before the first upload and never changed afterwards. Mozilla ties every version to it, and Firefox's Google sign-in address is made from it (see [google-setup.md](google-setup.md), step 4). `pnpm zip` refuses to build while it is still the `example.com` placeholder.

## 2. Every release

1. **Pick a new version number** in `package.json` (`"version"`). It must be higher than every version uploaded before, listed or unlisted.
2. **Build:**

   ```bash
   pnpm zip
   ```

   This writes three files to `.output/`:

   | File | What it's for |
   |---|---|
   | `bookmark-sync-VERSION-firefox.zip` | The Firefox build |
   | `bookmark-sync-VERSION-sources.zip` | The source code Mozilla's reviewers rebuild it from |
   | `bookmark-sync-VERSION-chrome.zip` | The Chromium build, not used here |

## 3a. Upload unlisted

```bash
pnpm firefox:unlisted
```

It uploads the build, waits for Mozilla's automatic checks (usually a few minutes), and saves the signed file as `.output/bookmark-sync-VERSION-firefox.xpi`. Attach that file to the GitHub release. Anyone who opens it in Firefox can install it, and it stays installed.

## 3b. Upload listed

### The first listed version

The first listed version also creates the store page, so it needs details the command doesn't send. Use the website:

1. In [Developer Hub](https://addons.mozilla.org/developers/addons), open the add-on and choose **Upload a new version**. For a brand-new add-on, choose **Submit a New Add-on** instead.
2. Choose **On this site**.
3. Upload `bookmark-sync-VERSION-firefox.zip` and wait for the automatic checks. Warnings are fine. Only errors block you.
4. When asked whether you use code generators, minifiers or bundlers, answer **Yes** and upload `bookmark-sync-VERSION-sources.zip`.
5. Fill in the listing:
   - **Name:** Bookmark sync
   - **Summary:** one sentence, up to 250 characters.
   - **Description:** what it does and what it sends where. The README's opening and feature list work well.
   - **Category:** Bookmarks.
   - **License:** your choice, for example All rights reserved.
   - **Homepage:** the project website.
6. Under **Notes to reviewer**, explain how to build and test it, then paste every `WXT_` line from `.env`. Leave out the two `WEB_EXT_API_` lines. Only Mozilla's reviewers see these notes. `pnpm firefox:listed` writes the same notes automatically for later versions.
7. Submit.
8. Then, on the add-on's **Edit Product Page**, add what the upload form doesn't ask for:
   - **Screenshots:** for example from `promo/shots/`.
   - **Privacy policy:** in the page's technical details section, paste the text of the website's privacy page.

### Every later listed version

```bash
pnpm firefox:listed --notes "What changed in this version"
```

It uploads the build and the source code, writes the reviewer notes from `.env` (leaving out the API keys), and submits the version for review. `--notes` becomes the release notes users see on the store page. It doesn't wait for the review, which takes days.

## After submitting

1. **Automatic checks** run within minutes. A version that fails them is not submitted, and the command prints why.
2. **Human review** follows for listed versions. Mozilla emails you when the version is approved, or when the reviewer has questions or asks for changes. Questions arrive in Developer Hub, on the version's page, and you reply there.
3. **When approved,** the store page shows the new version, and Firefox updates everyone who installed it from the store, usually within a day.

To check where a version stands, open [Developer Hub](https://addons.mozilla.org/developers/addons), choose the add-on, then **Manage Status & Versions**.

## What every listed upload needs

| Item | Why | Done by |
|---|---|---|
| A version number not used before | Mozilla rejects repeats | You, in `package.json` |
| The Firefox build | What users install | `pnpm zip` |
| The source code | The build is bundled, so reviewers rebuild it from source | `pnpm zip`, uploaded by `pnpm firefox:listed` |
| Build settings in the reviewer notes | The source zip has no `.env`, so reviewers need the values to rebuild | `pnpm firefox:listed` |
| A data-collection declaration | Firefox shows it at install. Bookmarks leave the browser for the user's own storage, which Mozilla counts as transmitted data, so the manifest declares `bookmarksInfo` | Already in `wxt.config.ts` |

## If something fails

- **"Version X already exists":** that number was used before, listed or unlisted. Raise the version in `package.json`, run `pnpm zip` again and retry.
- **"The Firefox build is X, but package.json says Y":** the build is from an older version. Run `pnpm zip`.
- **"Unsupported file type":** an old copy of `web-ext` sent the upload without a file name. The commands use the pinned version in `package.json`, which works. Run them through `pnpm`, not a global `web-ext`.
- **"Set WEB_EXT_API_KEY and WEB_EXT_API_SECRET":** the keys from step 1 are missing from `.env`.
- **A reviewer can't build it:** check that every `WXT_` value used for the build is in the reviewer notes, and that the source zip has no files missing.
- **Google sign-in fails in Firefox after an ID change:** the Firefox sign-in address depends on `WXT_GECKO_ID`. See [google-setup.md](google-setup.md).
