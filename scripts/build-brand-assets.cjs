const fs = require('node:fs');
const path = require('node:path');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'assets/brand/vector/mascot-c-final.svg');
const monochromeSourcePath = path.join(root, 'assets/brand/vector/mascot-c-monochrome-final.svg');
const imagesDir = path.join(root, 'assets/images');
const backgroundColor = '#F7F8F6';

function parseSvg(source) {
  const document = new DOMParser().parseFromString(source, 'image/svg+xml');
  const svg = document.documentElement;
  const width = svg.getAttribute('width');
  const height = svg.getAttribute('height');

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  return { document, svg };
}

function serialize(document) {
  return Buffer.from(new XMLSerializer().serializeToString(document));
}

function withoutBackground(source) {
  const { document, svg } = parseSvg(source);
  const paths = Array.from(svg.getElementsByTagName('path'));
  const background = paths.find((node) => node.getAttribute('d') === 'M0 0h1254v1254H0Z');

  if (!background) {
    throw new Error('Expected full-canvas background path was not found');
  }

  background.parentNode.removeChild(background);
  return serialize(document);
}

function asMonochrome(source) {
  const { document, svg } = parseSvg(source.toString());
  const paintNodes = [
    ...Array.from(svg.getElementsByTagName('path')),
    ...Array.from(svg.getElementsByTagName('rect')),
    ...Array.from(svg.getElementsByTagName('circle')),
  ];

  paintNodes.forEach((node) => {
    if (!node.hasAttribute('fill') || node.getAttribute('fill') !== 'none') {
      node.setAttribute('fill', '#FFFFFF');
    }
    if (node.hasAttribute('stroke') && node.getAttribute('stroke') !== 'none') {
      node.setAttribute('stroke', '#FFFFFF');
    }
  });

  return serialize(document);
}

async function placeOnTransparentCanvas(source, contentSize, outputPath) {
  const content = await sharp(source).resize(contentSize, contentSize).png().toBuffer();
  const offset = Math.round((1024 - contentSize) / 2);

  await sharp({
    create: {
      width: 1024,
      height: 1024,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: content, left: offset, top: offset }])
    .png()
    .toFile(outputPath);
}

async function main() {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const monochromeSource = fs.readFileSync(monochromeSourcePath, 'utf8');
  const fullSvg = Buffer.from(source);
  const foregroundSvg = withoutBackground(source);
  const monochromeSvg = asMonochrome(Buffer.from(monochromeSource));

  await sharp(fullSvg)
    .resize(1024, 1024)
    .flatten({ background: backgroundColor })
    .png()
    .toFile(path.join(imagesDir, 'waifu-deck-icon.png'));

  await placeOnTransparentCanvas(
    foregroundSvg,
    740,
    path.join(imagesDir, 'waifu-deck-adaptive-foreground.png'),
  );
  await placeOnTransparentCanvas(
    monochromeSvg,
    740,
    path.join(imagesDir, 'waifu-deck-monochrome.png'),
  );

  await sharp(foregroundSvg)
    .resize(1024, 1024)
    .png()
    .toFile(path.join(imagesDir, 'waifu-deck-splash.png'));

  await sharp(fullSvg)
    .resize(512, 512)
    .flatten({ background: backgroundColor })
    .png()
    .toFile(path.join(imagesDir, 'waifu-deck-favicon.png'));

  console.log('Generated Waifu Deck icon, adaptive icon, monochrome icon, splash, and favicon assets.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
