# URL Scraper

Paste a page URL — get its title, description, OpenGraph metadata, and every image on the page in a responsive grid.

## Stack
- Backend: Node.js + Express + Cheerio + Axios
- Frontend: Vanilla HTML/CSS/JS (served statically by Express)

## Folder structure
```
url-scraper/
├── package.json
├── server.js            # Express API + static server
└── public/
    ├── index.html
    ├── styles.css
    └── app.js
```

## Run

```bash
cd url-scraper
npm install
npm start
```

Then open http://localhost:3000 and paste a URL.

## API

`POST /api/scrape` with JSON body `{ "url": "https://..." }` returns:
```json
{
  "url": "...",
  "title": "...",
  "description": "...",
  "siteName": "...",
  "author": "...",
  "keywords": "...",
  "headings": ["..."],
  "imageCount": 12,
  "images": [
    { "url": "https://...", "alt": "...", "title": null, "caption": null, "width": null, "height": null, "source": "img" }
  ]
}
```

## What it extracts
- Title: `<title>`, `og:title`, `twitter:title`
- Description: `meta[description]`, `og:description`, `twitter:description`
- Site name, author, keywords
- All `<img>` (including `srcset`, `data-src`, `data-srcset`, `data-original`)
- `<picture><source srcset="">`
- `og:image` / `twitter:image`
- Per-image `alt`, `title`, surrounding `<figcaption>`, dimensions
- H1/H2 headings (first 20)

Relative URLs are resolved against the page URL. Duplicates are removed. `data:` URIs are skipped.

## Security / safety
- Only `http(s)` URLs accepted.
- DNS lookup with rejection of private/loopback/link-local addresses (basic SSRF guard).
- 15s timeout, 10MB cap, max 5 redirects.
- Non-HTML content types are rejected.
- Optional domain allowlist: edit `ALLOWED_HOSTS` in `server.js` (e.g. `['sabana.com']`) to restrict to specific sites.
- Frontend uses `referrerPolicy="no-referrer"` and `loading="lazy"` for image rendering.

## Notes
- This is a server-side fetch — pages that require login or render images via JavaScript only (SPA hydration) won't expose those images. For JS-rendered sites you'd need a headless browser (Playwright/Puppeteer); this project intentionally stays lightweight.
