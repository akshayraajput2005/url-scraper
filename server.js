const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const { URL } = require('url');
const dns = require('dns').promises;
const net = require('net');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Optional allowlist. Leave empty to allow any public http(s) host.
// Example: ['sabana.com', 'unsplash.com']
const ALLOWED_HOSTS = [];

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
  }
  return true;
}

async function validateUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http and https URLs are allowed');
  }
  const host = parsed.hostname;
  if (ALLOWED_HOSTS.length > 0) {
    const ok = ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h));
    if (!ok) throw new Error('Domain not allowed');
  }
  // SSRF guard: resolve and reject private/loopback addresses.
  try {
    const records = await dns.lookup(host, { all: true });
    for (const r of records) {
      if (isPrivateIp(r.address)) throw new Error('Refused: private address');
    }
  } catch (e) {
    if (e.message.startsWith('Refused')) throw e;
    throw new Error('Could not resolve host');
  }
  return parsed;
}

function absolutize(src, base) {
  if (!src) return null;
  try {
    return new URL(src, base).toString();
  } catch {
    return null;
  }
}

function pickFromSrcset(srcset, base) {
  if (!srcset) return null;
  const parts = srcset.split(',').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  // pick the last (usually largest)
  const last = parts[parts.length - 1].split(/\s+/)[0];
  return absolutize(last, base);
}

function findInJsonState(html, keys) {
  for (const k of keys) {
    const re = new RegExp(`"${k}"\\s*:\\s*"((?:\\\\.|[^"\\\\])+)"`);
    const m = html.match(re);
    if (m && m[1]) {
      try {
        return JSON.parse('"' + m[1] + '"');
      } catch {
        return m[1];
      }
    }
  }
  return '';
}

function extract(html, baseUrl) {
  const $ = cheerio.load(html);

  const title =
    $('meta[property="og:title"]').attr('content') ||
    $('meta[name="twitter:title"]').attr('content') ||
    $('title').first().text().trim() ||
    findInJsonState(html, ['goodsName', 'productName', 'pageTitle', 'title', 'name']) ||
    '';

  const description =
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    $('meta[name="twitter:description"]').attr('content') ||
    findInJsonState(html, ['goodsDesc', 'description', 'desc']) ||
    '';

  // Try to extract structured key/value details from a JSON state blob.
  // Try keys in priority order; pick the first one whose array yields
  // at least one extractable {key, value} string pair.
  const details = [];
  const candidateKeys = [
    'aboutProductDetail',
    'productDetails',
    'productAttributes',
    'attributes',
    'specifications',
    'specs',
    'details',
  ];
  for (const k of candidateKeys) {
    const re = new RegExp(`"${k}"\\s*:\\s*(\\[[\\s\\S]*?\\])`);
    const match = html.match(re);
    if (!match) continue;
    let arr;
    try { arr = JSON.parse(match[1]); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    const extracted = [];
    for (const item of arr) {
      if (item && typeof item === 'object') {
        const key = item.key || item.name || item.label || item.attrName;
        const value = item.value || item.val || item.attrValue;
        if (typeof key === 'string' && typeof value === 'string' && key && value) {
          extracted.push({ key, value });
        }
      }
    }
    if (extracted.length) {
      details.push(...extracted);
      break;
    }
  }

  const siteName = $('meta[property="og:site_name"]').attr('content') || '';
  const author = $('meta[name="author"]').attr('content') || '';
  const keywords = $('meta[name="keywords"]').attr('content') || '';

  // Most image CDNs put a content hash (24–40 hex chars) in the URL path —
  // same hash = same image regardless of CDN host, path prefix, or size suffix.
  // Falls back to the URL with size/quality params stripped.
  function dedupKey(url) {
    const hashes = url.match(/[a-f0-9]{24,40}/gi);
    if (hashes && hashes.length) return hashes[hashes.length - 1].toLowerCase();
    return url
      .replace(/[_-]w\d+([_-]h\d+)?([_-]q\d+)?([_-]lg)?([_-]fcover)?(?=\.|$|\?)/gi, '')
      .replace(/[?#].*$/, '')
      .toLowerCase();
  }

  function imageWidth(url) {
    const m = url.match(/[_-]w(\d+)/i);
    return m ? parseInt(m[1], 10) : 0;
  }

  // Junk: tracking pixels, favicons, common shared-CDN UI/promo assets.
  const JUNK = [
    /favicon/i,
    /apple-touch-icon/i,
    /aliyuncs\.com\/.*\.png/i,
    /arms-retcode/i,
    /\bsprite\b/i,
    /\/logo\//i,
    /\/icons?\//i,
    /[?&]r=\d+/, // common tracker query
  ];

  const seen = new Set();
  const byKey = new Map(); // dedupKey -> index in images[]
  const images = [];

  function isJunk(url) {
    return JUNK.some(re => re.test(url));
  }

  const MIN_WIDTH_HINT = 200;

  function pushImage(url, meta = {}) {
    if (!url) return;
    if (url.startsWith('data:')) return;
    if (seen.has(url)) return;
    seen.add(url);
    if (isJunk(url)) return;
    // Drop obvious thumbnails / color swatches.
    const w = imageWidth(url);
    if (w > 0 && w < MIN_WIDTH_HINT) return;
    const widthAttr = parseInt(meta.width, 10);
    if (widthAttr > 0 && widthAttr < MIN_WIDTH_HINT) return;

    const key = dedupKey(url);
    const existingIdx = byKey.get(key);
    if (existingIdx != null) {
      // Keep the larger variant
      if (imageWidth(url) > imageWidth(images[existingIdx].url)) {
        images[existingIdx] = { url, ...meta };
      }
      return;
    }
    byKey.set(key, images.length);
    images.push({ url, ...meta });
  }

  // og:image / twitter:image
  $('meta[property="og:image"], meta[name="twitter:image"]').each((_, el) => {
    pushImage(absolutize($(el).attr('content'), baseUrl), { source: 'meta' });
  });

  // <img>
  $('img').each((_, el) => {
    const $el = $(el);
    const src =
      absolutize($el.attr('src'), baseUrl) ||
      pickFromSrcset($el.attr('srcset'), baseUrl) ||
      absolutize($el.attr('data-src'), baseUrl) ||
      pickFromSrcset($el.attr('data-srcset'), baseUrl) ||
      absolutize($el.attr('data-original'), baseUrl);

    pushImage(src, {
      alt: ($el.attr('alt') || '').trim() || null,
      title: ($el.attr('title') || '').trim() || null,
      caption: $el.closest('figure').find('figcaption').first().text().trim() || null,
      width: $el.attr('width') || null,
      height: $el.attr('height') || null,
      source: 'img',
    });
  });

  // <source srcset=""> inside <picture>
  $('picture source').each((_, el) => {
    pushImage(pickFromSrcset($(el).attr('srcset'), baseUrl), { source: 'picture' });
  });

  // Step 1: prefer a structured product-images array in the JSON state.
  // Most e-commerce SPAs embed something like:
  //   "images":[{"originalPic":"https://...", "picThumb":"https://..."}, ...]
  // Use that as the canonical source so we don't mix in related-product
  // images from elsewhere on the page.
  const productImageKeys = [
    'images',
    'goodsImages',
    'picList',
    'goodsPics',
    'productImages',
    'pictures',
    'picsList',
    'detailImages',
  ];
  const urlFields = ['originalPic', 'picThumb', 'url', 'src', 'imageUrl', 'pic', 'image'];
  let structuredFound = false;
  for (const k of productImageKeys) {
    const re = new RegExp(`"${k}"\\s*:\\s*(\\[[\\s\\S]*?\\])`);
    const match = html.match(re);
    if (!match) continue;
    let arr;
    try { arr = JSON.parse(match[1]); } catch { continue; }
    if (!Array.isArray(arr) || arr.length === 0) continue;
    let any = false;
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      let url = null;
      for (const f of urlFields) {
        if (typeof item[f] === 'string' && /^https?:\/\//.test(item[f])) {
          url = item[f];
          break;
        }
      }
      if (url) {
        pushImage(url, { source: 'product-array', alt: item.alt || item.title || null });
        any = true;
      }
    }
    if (any) { structuredFound = true; break; }
  }

  // Step 2: only if we couldn't find a structured product images array,
  // fall back to a broad regex sweep. This is the noisy path — it picks up
  // anything image-like, so we keep it as a last resort.
  if (!structuredFound) {
    const pageHost = new URL(baseUrl).hostname;
    const baseDomain = pageHost.split('.').slice(-2).join('.');
    const urlRe = /https?:\/\/[^\s"'<>\\)]+?\.(?:jpg|jpeg|png|webp|gif|avif)(?:\?[^\s"'<>\\)]*)?/gi;
    let m;
    while ((m = urlRe.exec(html)) !== null) {
      let u = m[0].replace(/\\\//g, '/').replace(/\\u002F/gi, '/');
      let h;
      try { h = new URL(u).hostname; } catch { continue; }
      if (h !== baseDomain && !h.endsWith('.' + baseDomain)) continue;
      if (/\.gif(\?|$)/i.test(u)) continue;
      pushImage(u, { source: 'embedded' });
    }
  }

  // Headings as extra context
  const headings = [];
  $('h1, h2').each((_, el) => {
    const t = $(el).text().trim();
    if (t) headings.push(t);
  });

  return {
    url: baseUrl,
    title,
    description,
    siteName,
    author,
    keywords,
    details,
    headings: headings.slice(0, 20),
    imageCount: images.length,
    images,
  };
}

// Shopify exposes a clean JSON endpoint for every product at
// /products/<handle>.json — no auth, no scraping, authoritative data.
// Try it first when the URL matches that pattern.
async function tryShopifyJson(parsed) {
  const m = parsed.pathname.match(/\/products\/([^/?#]+)/);
  if (!m) return null;
  const jsonUrl = `${parsed.origin}/products/${m[1]}.json`;
  try {
    const r = await axios.get(jsonUrl, {
      timeout: 10000,
      maxContentLength: 5 * 1024 * 1024,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
      validateStatus: s => s === 200,
    });
    const p = r.data?.product;
    if (!p || !Array.isArray(p.images) || p.images.length === 0) return null;
    return {
      url: parsed.toString(),
      title: p.title || '',
      description: (p.body_html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 500),
      siteName: parsed.hostname.replace(/^www\./, ''),
      author: p.vendor || '',
      keywords: Array.isArray(p.tags) ? p.tags.join(', ') : (p.tags || ''),
      details: [
        p.vendor && { key: 'Vendor', value: p.vendor },
        p.product_type && { key: 'Type', value: p.product_type },
        p.variants?.[0]?.price && { key: 'Price', value: p.variants[0].price },
        p.variants?.length && { key: 'Variants', value: String(p.variants.length) },
      ].filter(Boolean),
      headings: [],
      imageCount: p.images.length,
      images: p.images.map(img => ({
        url: img.src,
        alt: img.alt || null,
        width: img.width || null,
        height: img.height || null,
        source: 'shopify-json',
      })),
    };
  } catch {
    return null;
  }
}

app.post('/api/scrape', async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing url' });
  }
  let parsed;
  try {
    parsed = await validateUrl(url);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // Shopify fast path
  const shopify = await tryShopifyJson(parsed);
  if (shopify) return res.json(shopify);

  try {
    const response = await axios.get(parsed.toString(), {
      timeout: 15000,
      maxContentLength: 10 * 1024 * 1024,
      maxRedirects: 5,
      responseType: 'text',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      validateStatus: s => s >= 200 && s < 400,
    });

    const ct = (response.headers['content-type'] || '').toLowerCase();
    if (!ct.includes('html')) {
      return res.status(415).json({ error: `Unsupported content-type: ${ct || 'unknown'}` });
    }

    const data = extract(response.data, parsed.toString());

    // Heuristic: detect anti-bot / maintenance / captcha pages so the user
    // gets a clear error instead of an empty result. These pages are normally
    // small, have no images, and a tell-tale title.
    const blockMarkers = /\b(site\s+maintenance|access\s+denied|forbidden|just\s+a\s+moment|attention\s+required|captcha|bot\s+detection|are\s+you\s+a\s+human|please\s+verify|cloudflare|akamai|press\s*&\s*hold|verify\s+you\s+are)\b/i;
    const titleLooksBlocked = blockMarkers.test(data.title || '');
    const tinyAndEmpty = response.data.length < 5000 && data.imageCount === 0;
    if (titleLooksBlocked || (tinyAndEmpty && data.imageCount === 0 && !data.description)) {
      return res.status(403).json({
        error: 'This site is blocking automated requests (returned a maintenance/captcha page). Try a different site — Myntra, Flipkart, Ajio, and Nykaa actively block scrapers.',
        blocked: true,
        upstreamTitle: data.title || null,
      });
    }

    res.json(data);
  } catch (e) {
    const status = e.response?.status;
    res.status(502).json({
      error: status ? `Upstream error ${status}` : `Fetch failed: ${e.code || e.message}`,
    });
  }
});

app.get('/api/download', async (req, res) => {
  const raw = req.query.url;
  if (!raw || typeof raw !== 'string') return res.status(400).send('Missing url');

  let parsed;
  try {
    parsed = await validateUrl(raw);
  } catch (e) {
    return res.status(400).send(e.message);
  }

  try {
    const upstream = await axios.get(parsed.toString(), {
      timeout: 20000,
      maxContentLength: 50 * 1024 * 1024,
      maxRedirects: 5,
      responseType: 'stream',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Referer: parsed.origin,
      },
      validateStatus: s => s >= 200 && s < 400,
    });

    const ct = upstream.headers['content-type'] || 'application/octet-stream';
    if (!ct.startsWith('image/') && !ct.startsWith('video/') && ct !== 'application/octet-stream') {
      return res.status(415).send('Not an image');
    }

    let filename = path.basename(parsed.pathname) || 'download';
    filename = filename.replace(/[\r\n";]/g, '').slice(0, 120);
    if (!/\.[a-z0-9]{2,5}$/i.test(filename)) {
      const extFromCt = ct.split('/')[1]?.split(';')[0];
      if (extFromCt) filename += '.' + extFromCt.replace('jpeg', 'jpg');
    }

    res.setHeader('Content-Type', ct);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (upstream.headers['content-length']) {
      res.setHeader('Content-Length', upstream.headers['content-length']);
    }
    upstream.data.pipe(res);
  } catch (e) {
    res.status(502).send(`Download failed: ${e.code || e.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`URL scraper listening on http://localhost:${PORT}`);
});
