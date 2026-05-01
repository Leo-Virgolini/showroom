// Genera los íconos PNG del manifest a partir de public/icons/icon-source.svg.
// Uso: node scripts/generate-icons.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = resolve(__dirname, '..', 'public', 'icons');
const sourcePath = resolve(iconsDir, 'icon-source.svg');

const sizes = [72, 96, 128, 144, 152, 192, 384, 512];

const svg = await readFile(sourcePath);

await Promise.all(
  sizes.map(async (size) => {
    const out = resolve(iconsDir, `icon-${size}x${size}.png`);
    await sharp(svg).resize(size, size).png({ compressionLevel: 9 }).toFile(out);
    console.log(`✓ ${out}`);
  }),
);

// Favicon: 32px renderizado a partir del mismo SVG.
const faviconPath = resolve(__dirname, '..', 'public', 'favicon.ico');
const png32 = await sharp(svg).resize(32, 32).png().toBuffer();
await writeFile(faviconPath, png32);
console.log(`✓ ${faviconPath}`);
