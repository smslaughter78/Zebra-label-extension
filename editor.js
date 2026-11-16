import * as pdfjsLib from './lib/pdf.min.mjs';
import { detectLabel } from './detect.js';

const hasChrome = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
const libUrl = (p) => new URL(`./lib/${p}`, import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = libUrl('pdf.worker.min.mjs');

const LABEL_W_IN = 4;
const LABEL_H_IN = 6;
const DISPLAY_DPI = 150;
const MAX_SRC_DPI = 600;

const $ = (id) => document.getElementById(id);
const el = {
  status: $('status'), file: $('file'), pager: $('pager'), prev: $('prev'), next: $('next'),
  pageLabel: $('page-label'), stageWrap: $('stage-wrap'), empty: $('empty'), stage: $('stage'),
  pageCanvas: $('page-canvas'), crop: $('crop'), preview: $('preview'), rotate: $('rotate'),
  redetect: $('redetect'), fullpage: $('fullpage'), bw: $('bw'), thrRow: $('thr-row'),
  threshold: $('threshold'), dpi: $('dpi'), margin: $('margin'), allRow: $('all-row'),
  allPages: $('all-pages'), autoPrint: $('auto-print'), print: $('print'), printArea: $('print-area'),
};

const settings = { bw: true, threshold: 150, dpi: 203, margin: 0.05, landscapeRot: 90, autoPrint: false };

// source: { type: 'pdf', doc, numPages } | { type: 'image', canvas, numPages: 1 }
let source = null;
let pages = []; // per page: { crop:{x,y,w,h}, rotation, confident }
let cur = 0;
let renderCache = new Map(); // `${page}@${dpi}` -> canvas
let previewToken = 0;

// ---------- settings ----------

async function loadSettings() {
  if (!hasChrome) return;
  try {
    const stored = await chrome.storage.local.get('settings');
    Object.assign(settings, stored.settings || {});
  } catch (err) {
    console.warn('Could not load settings:', err);
  }
}

async function saveSettings() {
  if (!hasChrome) return;
  try {
    await chrome.storage.local.set({ settings });
  } catch (err) {
    console.warn('Could not save settings:', err);
  }
}

function syncControls() {
  el.bw.checked = settings.bw;
  el.threshold.value = settings.threshold;
  el.thrRow.hidden = !settings.bw;
  el.dpi.value = String(settings.dpi);
  el.margin.value = String(settings.margin);
  el.autoPrint.checked = settings.autoPrint;
}

function setStatus(text, isError = false) {
  el.status.textContent = text;
  el.status.classList.toggle('error', isError);
}

// ---------- loading ----------

function isPdfBytes(bytes) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

async function loadBlob(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (isPdfBytes(bytes)) {
    const doc = await pdfjsLib.getDocument({
      data: bytes,
      standardFontDataUrl: libUrl('standard_fonts/'),
      cMapUrl: libUrl('cmaps/'),
      cMapPacked: true,
      wasmUrl: libUrl('wasm/'),
      isEvalSupported: false,
    }).promise;
    await setSource({ type: 'pdf', doc, numPages: doc.numPages });
    return;
  }
  // Not a PDF: it has to decode as an image, otherwise this throws.
  const bitmap = await createImageBitmap(new Blob([bytes], { type: blob.type || 'image/png' }));
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  await setSource({ type: 'image', canvas, numPages: 1 });
}

async function fetchBlob(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

// Fetch from inside the source tab. Needed for blob: URLs and for sites that
// only serve the label to requests made by their own page.
async function fetchBlobInTab(tabId, url) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [url],
    func: async (u) => {
      try {
        const res = await fetch(u, { credentials: 'include' });
        if (!res.ok) return null;
        const blob = await res.blob();
        return await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
      } catch {
        return null;
      }
    },
  });
  if (!result?.result) throw new Error('in-tab fetch failed');
  return (await fetch(result.result)).blob();
}

// Look inside the page for an embedded PDF or a large image.
async function findEmbeddedSources(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      const found = [];
      for (const node of document.querySelectorAll('embed, object, iframe')) {
        const url = node.src || node.data;
        const type = node.type || '';
        if (url && (/pdf/i.test(type) || /\.pdf([?#]|$)/i.test(url) || url.startsWith('blob:'))) {
          found.push({ url, area: Infinity });
        }
      }
      for (const img of document.images) {
        const area = img.naturalWidth * img.naturalHeight;
        if (img.naturalWidth >= 300 && img.naturalHeight >= 300 && img.currentSrc) {
          found.push({ url: img.currentSrc, area });
        }
      }
      return found;
    },
  });
  return results
    .flatMap((r) => r.result || [])
    .sort((a, b) => b.area - a.area)
    .slice(0, 4)
    .map((f) => f.url);
}

async function tryUrl(url, tabId) {
  if (!url) return false;
  const attempts = [];
  if (!url.startsWith('blob:')) attempts.push(() => fetchBlob(url));
  if (hasChrome && tabId !== undefined) attempts.push(() => fetchBlobInTab(tabId, url));
  for (const attempt of attempts) {
    try {
      await loadBlob(await attempt());
      return true;
    } catch (err) {
      console.debug('Source attempt failed for', url, err);
    }
  }
  return false;
}

async function loadJob(job) {
  setStatus('Loading label…');
  // 1. Things the user pointed at directly, then the page itself.
  const direct = [job.srcUrl, job.linkUrl, job.frameUrl, job.tabUrl].filter(
    (u, i, a) => u && /^(https?|file|blob|data):/.test(u) && a.indexOf(u) === i,
  );
  for (const url of direct) {
    if (await tryUrl(url, job.tabId)) return;
  }
  // 2. A PDF or large image embedded in the page.
  if (hasChrome && job.tabId !== undefined) {
    try {
      for (const url of await findEmbeddedSources(job.tabId)) {
        if (await tryUrl(url, job.tabId)) return;
      }
    } catch (err) {
      console.debug('Could not inspect the page:', err);
    }
  }
  // 3. Last resort: the screenshot taken when the menu item was clicked.
  if (job.screenshot) {
    try {
      await loadBlob(await (await fetch(job.screenshot)).blob());
      setStatus('Using a screenshot of the page — quality is limited. For a sharper label, download the PDF and drop it here.');
      return;
    } catch (err) {
      console.debug('Screenshot failed to load:', err);
    }
  }
  setStatus('Could not read a label from that page. Download the label and drop the file here.', true);
}

async function setSource(next) {
  source = next;
  renderCache = new Map();
  pages = [];
  cur = 0;
  for (let i = 0; i < source.numPages; i++) pages.push(null);
  el.empty.hidden = true;
  el.stage.hidden = false;
  el.print.disabled = false;
  el.pager.hidden = source.numPages < 2;
  el.allRow.hidden = source.numPages < 2;
  el.allPages.checked = source.numPages > 1;
  await showPage(0);
  const p = pages[0];
  setStatus(p.confident ? 'Label found.' : 'Not sure this is the label — check the crop box.');
  if (settings.autoPrint && p.confident) await printLabels();
}

// ---------- rendering ----------

async function pageWidthIn(i) {
  if (source.type !== 'pdf') return null;
  const page = await source.doc.getPage(i + 1);
  return page.getViewport({ scale: 1 }).width / 72;
}

async function getPageCanvas(i, dpi) {
  if (source.type === 'image') return source.canvas;
  const key = `${i}@${dpi}`;
  if (renderCache.has(key)) return renderCache.get(key);
  const page = await source.doc.getPage(i + 1);
  const viewport = page.getViewport({ scale: dpi / 72 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport }).promise;
  if (renderCache.size >= 6) renderCache.delete(renderCache.keys().next().value);
  renderCache.set(key, canvas);
  return canvas;
}

function autoRotation(crop, canvas) {
  return crop.w * canvas.width > crop.h * canvas.height ? settings.landscapeRot : 0;
}

async function ensurePage(i) {
  if (pages[i]) return pages[i];
  const canvas = await getPageCanvas(i, DISPLAY_DPI);
  const box = detectLabel(canvas, await pageWidthIn(i));
  const crop = { x: box.x, y: box.y, w: box.w, h: box.h };
  pages[i] = { crop, rotation: autoRotation(crop, canvas), confident: box.confident };
  return pages[i];
}

async function showPage(i) {
  cur = i;
  const canvas = await getPageCanvas(i, DISPLAY_DPI);
  await ensurePage(i);
  el.pageCanvas.width = canvas.width;
  el.pageCanvas.height = canvas.height;
  el.pageCanvas.getContext('2d').drawImage(canvas, 0, 0);
  // Keep the whole page visible without scrolling where possible.
  const maxH = Math.max(300, el.stageWrap.clientHeight - 26);
  el.pageCanvas.style.maxHeight = `${maxH}px`;
  el.pageCanvas.style.width = 'auto';
  el.pageLabel.textContent = `Page ${i + 1} of ${source.numPages}`;
  el.prev.disabled = i === 0;
  el.next.disabled = i === source.numPages - 1;
  drawCropBox();
  await updatePreview();
}

function drawCropBox() {
  const { crop } = pages[cur];
  el.crop.style.left = `${crop.x * 100}%`;
  el.crop.style.top = `${crop.y * 100}%`;
  el.crop.style.width = `${crop.w * 100}%`;
  el.crop.style.height = `${crop.h * 100}%`;
}

// Produce the final label bitmap at exactly printer resolution.
async function renderLabel(i) {
  const { crop, rotation } = await ensurePage(i);
  const dpi = settings.dpi;
  const outW = LABEL_W_IN * dpi;
  const outH = LABEL_H_IN * dpi;
  const availW = outW - 2 * settings.margin * dpi;
  const availH = outH - 2 * settings.margin * dpi;
  const turned = rotation % 180 !== 0;

  let src;
  if (source.type === 'pdf') {
    // Re-render the PDF so the cropped area lands at ~1:1 printer pixels.
    const page = await source.doc.getPage(i + 1);
    const vp = page.getViewport({ scale: 1 });
    const cwIn = (crop.w * vp.width) / 72;
    const chIn = (crop.h * vp.height) / 72;
    const fit = Math.min(availW / (turned ? chIn : cwIn), availH / (turned ? cwIn : chIn));
    const srcDpi = Math.round(Math.min(MAX_SRC_DPI, Math.max(72, fit)));
    src = await getPageCanvas(i, srcDpi);
  } else {
    src = source.canvas;
  }

  const sx = crop.x * src.width;
  const sy = crop.y * src.height;
  const sw = Math.max(1, crop.w * src.width);
  const sh = Math.max(1, crop.h * src.height);
  const k = Math.min(availW / (turned ? sh : sw), availH / (turned ? sw : sh));

  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, outW, outH);
  ctx.imageSmoothingQuality = 'high';
  ctx.save();
  ctx.translate(outW / 2, outH / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(src, sx, sy, sw, sh, (-sw * k) / 2, (-sh * k) / 2, sw * k, sh * k);
  ctx.restore();

  if (settings.bw) {
    const img = ctx.getImageData(0, 0, outW, outH);
    const d = img.data;
    for (let p = 0; p < d.length; p += 4) {
      const l = (d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000;
      const v = l < settings.threshold ? 0 : 255;
      d[p] = d[p + 1] = d[p + 2] = v;
      d[p + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }
  return out;
}

async function updatePreview() {
  if (!source) return;
  const token = ++previewToken;
  try {
    const label = await renderLabel(cur);
    if (token !== previewToken) return;
    el.preview.width = label.width;
    el.preview.height = label.height;
    el.preview.getContext('2d').drawImage(label, 0, 0);
  } catch (err) {
    console.error(err);
    setStatus(`Could not render the label: ${err.message}`, true);
  }
}

// ---------- printing ----------

async function printLabels() {
  if (!source) return;
  el.print.disabled = true;
  const urls = [];
  try {
    const list = el.allPages.checked && source.numPages > 1
      ? pages.map((_, i) => i)
      : [cur];
    el.printArea.replaceChildren();
    for (const i of list) {
      const canvas = await renderLabel(i);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const img = new Image();
      img.src = url;
      await img.decode();
      const wrap = document.createElement('div');
      wrap.className = 'label';
      wrap.append(img);
      el.printArea.append(wrap);
    }
    window.print(); // blocks until the dialog closes
  } catch (err) {
    console.error(err);
    setStatus(`Printing failed: ${err.message}`, true);
  } finally {
    el.print.disabled = false;
    el.printArea.replaceChildren();
    urls.forEach((u) => URL.revokeObjectURL(u));
  }
}

// ---------- crop interaction ----------

const MIN = 0.02;
let drag = null;

function pointerPos(e) {
  const r = el.stage.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
  };
}

el.stage.addEventListener('pointerdown', (e) => {
  if (!source || e.button !== 0) return;
  const p = pointerPos(e);
  const handle = e.target.dataset?.h;
  const start = { ...pages[cur].crop };
  let mode;
  if (handle) mode = handle;
  else if (e.target === el.crop) mode = 'move';
  else mode = 'new';
  drag = { mode, p, start };
  el.stage.setPointerCapture(e.pointerId);
  e.preventDefault();
});

el.stage.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const p = pointerPos(e);
  const s = drag.start;
  let x0 = s.x, y0 = s.y, x1 = s.x + s.w, y1 = s.y + s.h;
  if (drag.mode === 'move') {
    const dx = Math.min(1 - x1, Math.max(-x0, p.x - drag.p.x));
    const dy = Math.min(1 - y1, Math.max(-y0, p.y - drag.p.y));
    x0 += dx; x1 += dx; y0 += dy; y1 += dy;
  } else if (drag.mode === 'new') {
    x0 = Math.min(drag.p.x, p.x); x1 = Math.max(drag.p.x, p.x);
    y0 = Math.min(drag.p.y, p.y); y1 = Math.max(drag.p.y, p.y);
  } else {
    if (drag.mode.includes('w')) x0 = Math.min(p.x, x1 - MIN);
    if (drag.mode.includes('e')) x1 = Math.max(p.x, x0 + MIN);
    if (drag.mode.includes('n')) y0 = Math.min(p.y, y1 - MIN);
    if (drag.mode.includes('s')) y1 = Math.max(p.y, y0 + MIN);
  }
  if (x1 - x0 < MIN || y1 - y0 < MIN) return;
  pages[cur].crop = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  drawCropBox();
});

const endDrag = async () => {
  if (!drag) return;
  const wasNew = drag.mode === 'new';
  drag = null;
  const page = pages[cur];
  page.confident = true;
  // A freshly drawn box gets a fresh orientation guess.
  if (wasNew) page.rotation = autoRotation(page.crop, el.pageCanvas);
  await updatePreview();
};
el.stage.addEventListener('pointerup', endDrag);
el.stage.addEventListener('pointercancel', endDrag);

// ---------- controls ----------

el.rotate.addEventListener('click', async () => {
  if (!source) return;
  const page = pages[cur];
  page.rotation = (page.rotation + 90) % 360;
  // Remember which way the user turns landscape labels.
  const landscape = page.crop.w * el.pageCanvas.width > page.crop.h * el.pageCanvas.height;
  if (landscape && page.rotation % 180 !== 0) {
    settings.landscapeRot = page.rotation;
    await saveSettings();
  }
  await updatePreview();
});

el.redetect.addEventListener('click', async () => {
  if (!source) return;
  pages[cur] = null;
  await showPage(cur);
  setStatus(pages[cur].confident ? 'Label found.' : 'Not sure this is the label — check the crop box.');
});

el.fullpage.addEventListener('click', async () => {
  if (!source) return;
  const crop = { x: 0, y: 0, w: 1, h: 1 };
  pages[cur] = { crop, rotation: autoRotation(crop, el.pageCanvas), confident: true };
  drawCropBox();
  await updatePreview();
});

const onSetting = (node, key, read) => {
  node.addEventListener('change', async () => {
    settings[key] = read(node);
    syncControls();
    await saveSettings();
    await updatePreview();
  });
};
onSetting(el.bw, 'bw', (n) => n.checked);
onSetting(el.threshold, 'threshold', (n) => Number(n.value));
onSetting(el.dpi, 'dpi', (n) => Number(n.value));
onSetting(el.margin, 'margin', (n) => Number(n.value));
onSetting(el.autoPrint, 'autoPrint', (n) => n.checked);

el.prev.addEventListener('click', () => showPage(Math.max(0, cur - 1)));
el.next.addEventListener('click', () => showPage(Math.min(source.numPages - 1, cur + 1)));
el.print.addEventListener('click', printLabels);

// Ctrl/Cmd+P prints the label, not this editor page.
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p' && source) {
    e.preventDefault();
    printLabels();
  }
});

// ---------- manual input: file picker, drag & drop, paste ----------

async function loadUserFile(file) {
  if (!file) return;
  setStatus('Loading…');
  try {
    await loadBlob(file);
  } catch (err) {
    console.error(err);
    setStatus('That file is not a PDF or image I can read.', true);
  }
}

el.file.addEventListener('change', () => loadUserFile(el.file.files[0]));
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  el.stageWrap.classList.add('drag');
});
window.addEventListener('dragleave', () => el.stageWrap.classList.remove('drag'));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  el.stageWrap.classList.remove('drag');
  loadUserFile(e.dataTransfer.files[0]);
});
window.addEventListener('paste', (e) => {
  const item = [...e.clipboardData.items].find((it) => it.kind === 'file');
  if (item) loadUserFile(item.getAsFile());
});

// ---------- start ----------

async function init() {
  await loadSettings();
  syncControls();
  const params = new URLSearchParams(location.search);
  const jobId = params.get('job');
  try {
    if (jobId && hasChrome) {
      const stored = await chrome.storage.session.get(jobId);
      const job = stored[jobId];
      await chrome.storage.session.remove(jobId);
      if (job) await loadJob(job);
      else setStatus('Drop a label PDF or image here.');
    } else if (params.get('url')) {
      await loadJob({ tabUrl: params.get('url') });
    }
  } catch (err) {
    console.error(err);
    setStatus(`Something went wrong: ${err.message}`, true);
  }
}

init();
