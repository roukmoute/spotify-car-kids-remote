/**
 * Genere les icones PNG de la PWA sans aucune dependance npm.
 *
 * Node n'a pas d'encodeur image, mais un PNG est simple a produire a la main :
 * signature + IHDR + IDAT (scanlines RGBA prefixees d'un octet de filtre,
 * compressees en zlib) + IEND. On dessine en supersampling 3x pour lisser les
 * bords (anti-aliasing par moyenne).
 *
 * Usage : node tools/make-icons.mjs
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "icons");

const GREEN = [29, 185, 84];
const DARK = [10, 10, 12];

/* ------------------------------------------------------------------ */
/* Encodeur PNG                                                        */
/* ------------------------------------------------------------------ */

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  // Chaque scanline est prefixee par son octet de filtre (0 = None).
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // profondeur 8 bits
  ihdr[9] = 6; // type couleur 6 = RGBA
  ihdr[10] = 0; // compression deflate
  ihdr[11] = 0; // filtre adaptatif
  ihdr[12] = 0; // pas d'entrelacement

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* Dessin                                                              */
/* ------------------------------------------------------------------ */

/** Test d'appartenance a un rectangle arrondi centre en (cx, cy). */
function insideRoundRect(x, y, cx, cy, halfW, halfH, r) {
  const dx = Math.abs(x - cx) - (halfW - r);
  const dy = Math.abs(y - cy) - (halfH - r);
  if (dx <= 0 && dy <= 0) return true;
  const qx = Math.max(dx, 0);
  const qy = Math.max(dy, 0);
  return qx * qx + qy * qy <= r * r;
}

function insideEllipse(x, y, cx, cy, rx, ry, rotDeg = 0) {
  const t = (rotDeg * Math.PI) / 180;
  const dx = x - cx;
  const dy = y - cy;
  const ux = dx * Math.cos(t) + dy * Math.sin(t);
  const uy = -dx * Math.sin(t) + dy * Math.cos(t);
  return (ux * ux) / (rx * rx) + (uy * uy) / (ry * ry) <= 1;
}

function insideRect(x, y, x0, y0, x1, y1) {
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

/**
 * Une double croche : deux tetes de note ovales, deux hampes, une barre.
 * Coordonnees exprimees en fraction de la taille (0..1) pour etre scalables.
 */
function noteAlpha(u, v) {
  const headRx = 0.088;
  const headRy = 0.066;
  const stemW = 0.030;

  const leftHeadX = 0.335;
  const rightHeadX = 0.665;
  const headY = 0.690;

  const stemTop = 0.255;

  // Tetes de notes (ovales inclines, comme sur une portee)
  if (insideEllipse(u, v, leftHeadX, headY, headRx, headRy, -22)) return 1;
  if (insideEllipse(u, v, rightHeadX, headY, headRx, headRy, -22)) return 1;

  // Hampes
  const leftStemX = leftHeadX + headRx * 0.82;
  const rightStemX = rightHeadX + headRx * 0.82;
  if (insideRect(u, v, leftStemX - stemW / 2, stemTop, leftStemX + stemW / 2, headY)) return 1;
  if (insideRect(u, v, rightStemX - stemW / 2, stemTop, rightStemX + stemW / 2, headY)) return 1;

  // Barre reliant les deux hampes (legerement inclinee)
  const beamH = 0.072;
  if (u >= leftStemX - stemW / 2 && u <= rightStemX + stemW / 2) {
    const t = (u - leftStemX) / (rightStemX - leftStemX);
    const top = stemTop + t * 0.028;
    if (v >= top && v <= top + beamH) return 1;
  }

  return 0;
}

/**
 * @param {number} size       taille finale en px
 * @param {boolean} maskable  si true, marge de securite (zone sure = 80%)
 */
function render(size, { maskable = false } = {}) {
  const SS = 3; // supersampling
  const N = size * SS;
  const rgba = Buffer.alloc(size * size * 4);

  // En maskable, le contenu doit tenir dans un cercle de 80% : on retrecit
  // la note et on laisse le fond deborder jusqu'aux bords.
  const contentScale = maskable ? 0.76 : 1;
  const radius = maskable ? 0.5 : 0.22; // en fraction de la taille

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (px + (sx + 0.5) / SS) / size;
          const v = (py + (sy + 0.5) / SS) / size;

          let px3 = null;

          const inBg = maskable
            ? true // maskable : fond plein bord a bord, l'OS masque lui-meme
            : insideRoundRect(u, v, 0.5, 0.5, 0.5, 0.5, radius);

          if (inBg) {
            px3 = GREEN;

            // note centree, eventuellement retrecie pour la zone sure
            const nu = (u - 0.5) / contentScale + 0.5;
            const nv = (v - 0.5) / contentScale + 0.5;
            if (nu >= 0 && nu <= 1 && nv >= 0 && nv <= 1 && noteAlpha(nu, nv)) {
              px3 = DARK;
            }
          }

          if (px3) {
            r += px3[0];
            g += px3[1];
            b += px3[2];
            a += 255;
          }
        }
      }

      const n = SS * SS;
      const i = (py * size + px) * 4;
      const cov = a / n;
      // Pre-moyenne des couleurs sur les sous-pixels couverts uniquement.
      const covered = a / 255 || 1;
      rgba[i] = Math.round(r / covered);
      rgba[i + 1] = Math.round(g / covered);
      rgba[i + 2] = Math.round(b / covered);
      rgba[i + 3] = Math.round(cov);
    }
  }

  return encodePng(size, size, rgba);
}

/* ------------------------------------------------------------------ */

mkdirSync(OUT, { recursive: true });

const targets = [
  ["icon-192.png", 192, {}],
  ["icon-512.png", 512, {}],
  ["icon-maskable-512.png", 512, { maskable: true }],
  ["favicon-32.png", 32, {}],
];

for (const [name, size, opts] of targets) {
  const png = render(size, opts);
  writeFileSync(join(OUT, name), png);
  console.log(`${name.padEnd(26)} ${String(png.length).padStart(7)} octets`);
}
