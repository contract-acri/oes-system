# ACRI OES — Online Examination System

**Live site:** https://www.oes.acriindia.org.in  
Ahmedabad Centre for Research and Innovation · Office of the Controller of Examinations

One website, one domain, every portal:

| Address | Who uses it |
|---|---|
| `/` | Students sit exams |
| `/admin` | Controller of Examinations (CoE) |
| `/review` | Reviewers |
| `/papers` | Paper setters and moderators |
| `/control` | Master Control (CoE only) |
| `/staff` | A page that links to all the staff portals |

The website is static: plain HTML served by Cloudflare Pages from this repository. All data and logic stay in **Google Apps Script + Google Sheets**. The pages call Apps Script with `fetch` (POST, text/plain JSON) to the web app's `/exec` URL, set in **`site/config.js`**.

## What is in this repository

```
site/              ← Cloudflare serves this folder (build output directory)
  index.html         student exam page
  admin/ review/ papers/ control/ staff/   one folder per portal
  config.js          the Apps Script /exec URL (the only setting)
  _headers           security headers (no framing; camera/screen/fullscreen allowed)
  _redirects         short names: /coe → /admin, /reviewer → /review, /setter → /papers …
  robots.txt, 404.html, favicon.png
apps-script/Code.gs ← paste into the Apps Script project bound to the Sheet
src/               ← editable sources (shared parts are stitched in by build.py)
static/            ← files copied as-is into site/
build.py           ← python3 build.py  → rebuilds site/ and apps-script/Code.gs
```

## First deployment

1. **GitHub.** Create a **private** repository (for example `acri-oes`) and upload everything in this folder.
2. **Cloudflare.** Go to *Workers & Pages → Create → Pages → Connect to Git* and pick the repository. Use these settings:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: **`site`**

   Then click **Deploy**. You get a `*.pages.dev` address. Check that it works.
3. **Domain.** In the Pages project, open *Custom domains → Set up a custom domain* and add `www.oes.acriindia.org.in`, then `oes.acriindia.org.in`.
   - If `acriindia.org.in` uses Cloudflare DNS, Cloudflare adds the records itself.
   - If not, add a CNAME record at your DNS provider: `www.oes` → `<project>.pages.dev`, and the same for `oes`.
4. **Apps Script.**
   1. Paste `apps-script/Code.gs`.
   2. Go to *Deploy → Manage deployments → ✏️ → Version: New version → Deploy*. This keeps the same `/exec` URL.
   3. In the Sheet, run **ACRI Exams → Set up / repair sheets**. This moves the site links that emails and admit cards use from the old Google Sites addresses to the new `/admin`, `/review` and so on.
5. **Old Google Sites.** Replace each old site's content with a one-line notice: "The examination system has moved to www.oes.acriindia.org.in". Google Sites cannot forward visitors automatically.

## Making changes later

- **New Apps Script deployment URL:** edit `site/config.js` on GitHub and commit. Cloudflare redeploys in about a minute.
- **Page changes:** edit the files in `src/`, run `python3 build.py`, then commit `site/` and `apps-script/Code.gs`.
- **Different domain:** change the `*_SITE_URL` rows in the Sheet's **Settings** tab. Nothing in `site/` needs to change, because all links in the site are relative.

Secrets (Zoho tokens, etc.) live in Apps Script *Script Properties*, never in this repository.
