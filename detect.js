// Shipping-label detection.
//
// Heuristic, not ML: the page is segmented into blocks separated by
// whitespace (recursive XY-cut), and every block is scored on how much it
// looks like a 4x6 label: aspect ratio near 2:3, about 6 inches on the long
// side, and dense with ink (barcodes) compared to instruction text.

const ANALYSIS_MAX = 1100; // px on the long side of the analysis bitmap

/**
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas  full rendered page
 * @param {number|null} pageWidthIn  physical page width in inches, if known
 * @returns {{x:number,y:number,w:number,h:number,confident:boolean}} crop in 0..1 page units
 */
export function detectLabel(canvas, pageWidthIn) {
  const k = Math.min(1, ANALYSIS_MAX / Math.max(canvas.width, canvas.height));
  const W = Math.max(1, Math.round(canvas.width * k));
  const H = Math.max(1, Math.round(canvas.height * k));
  const small = new OffscreenCanvas(W, H);
  const ctx = small.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(canvas, 0, 0, W, H);
  const px = ctx.getImageData(0, 0, W, H).data;

  const ppi = W / (pageWidthIn || 8.5);
  const pageHIn = H / ppi;
  const pageWIn = W / ppi;

  // A page that is already label-sized: use all of it.
  const pLong = Math.max(pageWIn, pageHIn);
  const pShort = Math.min(pageWIn, pageHIn);
  if (pageWidthIn && pLong <= 7 && pLong / pShort > 1.35 && pLong / pShort < 1.65) {
    return { x: 0, y: 0, w: 1, h: 1, confident: true };
  }

  // Luma + background estimate (most common luma bucket).
  const luma = new Uint8Array(W * H);
  const hist = new Uint32Array(32);
  for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
    const l = (px[p] * 299 + px[p + 1] * 587 + px[p + 2] * 114) / 1000;
    luma[i] = l;
    hist[l >> 3]++;
  }
  let bgBucket = 31;
  for (let b = 0; b < 32; b++) if (hist[b] > hist[bgBucket]) bgBucket = b;
  const bg = bgBucket * 8 + 4;

  // Integral image of the ink mask.
  const IW = W + 1;
  const integ = new Int32Array(IW * (H + 1));
  for (let y = 0; y < H; y++) {
    let run = 0;
    for (let x = 0; x < W; x++) {
      if (Math.abs(luma[y * W + x] - bg) > 48) run++;
      integ[(y + 1) * IW + x + 1] = integ[y * IW + x + 1] + run;
    }
  }
  const sum = (x0, y0, x1, y1) =>
    integ[y1 * IW + x1] - integ[y0 * IW + x1] - integ[y1 * IW + x0] + integ[y0 * IW + x0];

  const minGap = Math.max(4, Math.round(0.2 * ppi));
  const candidates = [];

  const trim = (r) => {
    let { x0, y0, x1, y1 } = r;
    while (y0 < y1 && sum(x0, y0, x1, y0 + 1) === 0) y0++;
    while (y1 > y0 && sum(x0, y1 - 1, x1, y1) === 0) y1--;
    while (x0 < x1 && sum(x0, y0, x0 + 1, y1) === 0) x0++;
    while (x1 > x0 && sum(x1 - 1, y0, x1, y1) === 0) x1--;
    return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
  };

  // Runs of empty rows (or columns) at least minGap long, inside region r.
  const gaps = (r, rows) => {
    const out = [];
    const a = rows ? r.y0 : r.x0;
    const b = rows ? r.y1 : r.x1;
    let start = -1;
    for (let i = a; i < b; i++) {
      const empty = rows
        ? sum(r.x0, i, r.x1, i + 1) === 0
        : sum(i, r.y0, i + 1, r.y1) === 0;
      if (empty && start < 0) start = i;
      if (!empty && start >= 0) {
        if (i - start >= minGap) out.push([start, i]);
        start = -1;
      }
    }
    return out;
  };

  const split = (region, depth) => {
    const r = trim(region);
    if (!r) return;
    candidates.push(r);
    if (depth >= 6) return;
    const rg = gaps(r, true);
    const cg = gaps(r, false);
    const widest = (g) => g.reduce((m, [a, b]) => Math.max(m, b - a), 0);
    if (!rg.length && !cg.length) return;
    const rows = widest(rg) >= widest(cg);
    const g = rows ? rg : cg;
    let pos = rows ? r.y0 : r.x0;
    const end = rows ? r.y1 : r.x1;
    for (const [a, b] of [...g, [end, end]]) {
      const child = rows
        ? { x0: r.x0, y0: pos, x1: r.x1, y1: a }
        : { x0: pos, y0: r.y0, x1: a, y1: r.y1 };
      split(child, depth + 1);
      pos = b;
    }
  };
  split({ x0: 0, y0: 0, x1: W, y1: H }, 0);

  let best = null;
  for (const r of candidates) {
    const wIn = (r.x1 - r.x0) / ppi;
    const hIn = (r.y1 - r.y0) / ppi;
    const long = Math.max(wIn, hIn);
    const short = Math.min(wIn, hIn);
    if (short < 1.8 || long < 2.8) continue;
    const aspectFit = Math.exp(-1.5 * Math.abs(Math.log(long / short / 1.5)));
    const sizeFit = Math.exp(-Math.abs(Math.log(long / 6)));
    const density = sum(r.x0, r.y0, r.x1, r.y1) / ((r.x1 - r.x0) * (r.y1 - r.y0));
    const score = Math.sqrt(wIn * hIn) * aspectFit * sizeFit * (0.05 + Math.min(density, 0.35));
    if (!best || score > best.score) best = { r, score, quality: aspectFit * sizeFit };
  }

  if (!best) {
    // Nothing label-shaped: fall back to the trimmed content, or the page.
    const r = trim({ x0: 0, y0: 0, x1: W, y1: H }) || { x0: 0, y0: 0, x1: W, y1: H };
    best = { r, quality: 0 };
  }

  const pad = Math.round(0.04 * ppi);
  const x0 = Math.max(0, best.r.x0 - pad);
  const y0 = Math.max(0, best.r.y0 - pad);
  const x1 = Math.min(W, best.r.x1 + pad);
  const y1 = Math.min(H, best.r.y1 + pad);
  return {
    x: x0 / W,
    y: y0 / H,
    w: (x1 - x0) / W,
    h: (y1 - y0) / H,
    confident: best.quality > 0.6,
  };
}
