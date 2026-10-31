# Publishing the website

The `site/` folder holds the homepage and privacy policy. Google's consent screen and the extension stores need both. The pages read the name, links and contact details from `.env`, so they always match the extension.

```bash
pnpm site
```

This writes the finished pages to `.output/site`. Open `.output/site/index.html` to check them.

## What to set in .env

| Value | Used for |
|---|---|
| `WXT_SUPPORT_EMAIL` | Contact links on both pages. Set this or `WXT_SOURCE_URL`, so the privacy policy has a contact. |
| `WXT_SOURCE_URL` | Source code links, for example `https://github.com/you/bookmark-sync`. The extension's About page also shows it, and adds "Report a problem" for a GitHub URL. |
| `WXT_CHROME_STORE_URL`, `WXT_EDGE_STORE_URL`, `WXT_FIREFOX_STORE_URL` | Install buttons. Until one is set, the homepage says the extension is coming to the stores. |
| `WXT_PRIVACY_UPDATED` | The date at the top of the privacy policy. Change it whenever the policy changes. |
| `WXT_HOMEPAGE_URL`, `WXT_PRIVACY_URL` | Not used by the pages, but set them to the published addresses once the site is live. The extension and the release check use them. |

The screenshots in `site/images/` are taken from the extension. If you rename it, retake them so they show the new name.

## Publish on GitHub Pages

You don't need a GitHub profile site. Any public repository can publish its own site.

1. Push this repository to GitHub as a public repository.
2. In the repository, open **Settings**, **Pages**, and under **Build and deployment** set **Source** to **GitHub Actions**.
3. `.env` isn't in the repository, so the workflow reads the site's values from repository variables. Under **Settings**, **Secrets and variables**, **Actions**, **Variables**, add each `WXT_` value from the table above, plus `WXT_APP_NAME` and `WXT_APP_DESCRIPTION`, with the same value as in your `.env`.
4. Push to `main`, or run the **Website** workflow from the **Actions** tab. It builds the pages and publishes them.

The site is then at `https://YOUR-USERNAME.github.io/bookmark-sync/`, with the privacy policy at `.../privacy.html`.

## Use a subdomain of your own domain

If you own a domain, for example the one your portfolio uses, you can serve the site from a subdomain such as `bookmarks.yourname.dev`. Your portfolio itself doesn't change.

1. At your domain's DNS provider, add a **CNAME** record: name `bookmarks`, value `YOUR-USERNAME.github.io`.
2. In the repository's **Settings**, **Pages**, enter `bookmarks.yourname.dev` under **Custom domain** and save. When the check passes, turn on **Enforce HTTPS**.
3. Set `WXT_HOMEPAGE_URL=https://bookmarks.yourname.dev/` and `WXT_PRIVACY_URL=https://bookmarks.yourname.dev/privacy.html` in `.env`.

This doesn't work if your portfolio lives at a host's address such as `yourname.vercel.app`, because you can't add subdomains to it. Use the GitHub Pages address instead.

## Verify the domain for Google

Brand verification needs the domain verified in [Google Search Console](https://search.google.com/search-console), using the same Google account that owns the Google Cloud project.

- **Your own domain:** add a **Domain** property for `yourname.dev` and add the TXT record Search Console shows at your DNS provider. This covers every subdomain, including `bookmarks.yourname.dev`.
- **GitHub Pages address:** add a **URL prefix** property for `https://YOUR-USERNAME.github.io/`, choose the **HTML file** method, and commit the file Google gives you to `site/`. Because the repository site lives under that address, the file has to be at its root. That means a repository named `YOUR-USERNAME.github.io`, which is the profile site. If you'd rather not create one, use the subdomain route above.

Then add the domain under **Authorized domains** on the consent screen's **Branding** page.
