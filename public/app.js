const form = document.getElementById('form');
const urlInput = document.getElementById('url');
const goBtn = document.getElementById('go');
const statusEl = document.getElementById('status');
const results = document.getElementById('results');
const titleEl = document.getElementById('r-title');
const descEl = document.getElementById('r-desc');
const metaEl = document.getElementById('r-meta');
const detailsEl = document.getElementById('r-details');
const countEl = document.getElementById('r-count');
const gallery = document.getElementById('gallery');
const dlAllBtn = document.getElementById('dl-all');

let lastImages = [];

function downloadUrl(u) {
  return '/api/download?url=' + encodeURIComponent(u);
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg || '';
  statusEl.classList.toggle('error', !!isError);
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of children) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

function renderMetaList(data) {
  metaEl.innerHTML = '';
  const entries = [
    ['Site', data.siteName],
    ['Author', data.author],
    ['Keywords', data.keywords],
    ['URL', data.url],
  ].filter(([, v]) => v);
  for (const [k, v] of entries) {
    metaEl.append(el('li', {}, el('strong', {}, k + ':'), ' ', v));
  }
}

function renderDetails(details) {
  detailsEl.innerHTML = '';
  if (!details || !details.length) return;
  for (const d of details) {
    detailsEl.append(
      el('li', {},
        el('span', { className: 'k' }, d.key),
        el('span', { className: 'v' }, d.value),
      )
    );
  }
}

function renderImages(images) {
  gallery.innerHTML = '';
  countEl.textContent = images.length;
  lastImages = images;
  dlAllBtn.hidden = images.length === 0;

  for (const img of images) {
    const shot = el('div', { className: 'shot' });

    const image = el('img', {
      src: img.url,
      alt: '',
      loading: 'lazy',
      decoding: 'async',
      referrerPolicy: 'no-referrer',
    });
    image.addEventListener('error', () => {
      shot.style.display = 'none';
    });

    const dl = el('a', {
      className: 'dl',
      href: downloadUrl(img.url),
      download: '',
      title: 'Download image',
    }, 'Download');

    shot.append(image, dl);
    gallery.append(shot);
  }
}

dlAllBtn.addEventListener('click', async () => {
  if (!lastImages.length) return;
  dlAllBtn.disabled = true;
  dlAllBtn.textContent = 'Downloading…';
  for (let i = 0; i < lastImages.length; i++) {
    const a = document.createElement('a');
    a.href = downloadUrl(lastImages[i].url);
    a.download = '';
    document.body.append(a);
    a.click();
    a.remove();
    await new Promise(r => setTimeout(r, 350));
  }
  dlAllBtn.disabled = false;
  dlAllBtn.textContent = 'Download all';
});

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;

  goBtn.disabled = true;
  results.hidden = true;
  setStatus('Fetching…');

  try {
    const res = await fetch('/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();

    if (!res.ok) {
      setStatus(data.error || `Request failed (${res.status})`, true);
      return;
    }

    titleEl.textContent = data.title || '(no title)';
    descEl.textContent = data.description || '';
    renderDetails(data.details || []);
    renderMetaList(data);
    renderImages(data.images || []);
    results.hidden = false;
    if (data.imageCount === 0) {
      setStatus('No images found. The site may render images via JavaScript only, or it blocks scrapers. Sites known to work: savana.com, most Shopify stores, Wikipedia, Unsplash.', true);
    } else {
      setStatus(`Done — ${data.imageCount} image${data.imageCount === 1 ? '' : 's'} found.`);
    }
  } catch (e) {
    setStatus('Network error: ' + e.message, true);
  } finally {
    goBtn.disabled = false;
  }
});
