import { createRequire } from "node:module";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const require = createRequire(
  new URL("../apps/desktop/package.json", import.meta.url),
);
const sharp = require("sharp");

const inputDirectory = process.argv[2];
const outputDirectory = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.resolve("docs/assets/desktop");

if (!inputDirectory) {
  console.error(
    "Usage: node scripts/redact-documentation-screenshots.mjs <input-directory> [output-directory]",
  );
  process.exit(1);
}

const fill = "#ffffff";
const textColor = "#374151";

const screenshots = [
  {
    prefix: "01-",
    output: "overview.png",
    size: [2288, 1959],
    crop: { left: 0, top: 0, width: 2288, height: 1150 },
    redactions: [
      {
        left: 810,
        top: 925,
        width: 1400,
        height: 100,
        label: "本机运行时路径已隐藏",
      },
    ],
  },
  {
    prefix: "02-",
    output: "bots.png",
    size: [2324, 1512],
    redactions: Array.from({ length: 5 }, (_, index) => {
      const top = 500 + index * 127;
      return [
        {
          left: 615,
          top,
          width: 235,
          height: 60,
          label: `写作助手 ${index + 1}`,
        },
        {
          left: 1260,
          top: top - 5,
          width: 635,
          height: 88,
          label: "工作空间路径已隐藏",
        },
      ];
    }).flat(),
  },
  {
    prefix: "03-",
    output: "workspaces.png",
    size: [2290, 1676],
    crop: { left: 0, top: 0, width: 2290, height: 1285 },
    redactions: [560, 704, 846, 988, 1130].flatMap((top, index) => [
      {
        left: 530,
        top,
        width: 360,
        height: 105,
        label: `写作助手 ${index + 1}`,
      },
      {
        left: 980,
        top,
        width: 750,
        height: 105,
        label: "工作空间路径已隐藏",
      },
    ]),
  },
  {
    prefix: "05-",
    output: "capabilities.png",
    size: [2310, 1492],
    crop: { left: 0, top: 0, width: 2310, height: 650 },
    redactions: [
      {
        left: 500,
        top: 325,
        width: 1710,
        height: 145,
        label: "本机 Codex Home、MCP 配置与 Skills 路径已隐藏",
      },
    ],
  },
  {
    prefix: "06-",
    output: "system.png",
    size: [2286, 3584],
    crop: { left: 0, top: 0, width: 2286, height: 2000 },
    redactions: [],
  },
];

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function redactionSvg(width, height, redactions) {
  const content = redactions
    .map(({ left, top, width: boxWidth, height: boxHeight, label }) => {
      const baseline = top + Math.round(boxHeight / 2) + 10;
      return [
        `<rect x="${left}" y="${top}" width="${boxWidth}" height="${boxHeight}" fill="${fill}"/>`,
        label
          ? `<text x="${left + 24}" y="${baseline}" fill="${textColor}" font-family="Microsoft YaHei, Segoe UI, sans-serif" font-size="28">${escapeXml(label)}</text>`
          : "",
      ].join("");
    })
    .join("");

  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${content}</svg>`,
  );
}

async function assertRedactionCorners(outputPath, redactions) {
  const expected = [255, 255, 255, 255];
  for (const rectangle of redactions) {
    const points = [
      [rectangle.left + 3, rectangle.top + 3],
      [rectangle.left + rectangle.width - 4, rectangle.top + 3],
      [rectangle.left + 3, rectangle.top + rectangle.height - 4],
      [
        rectangle.left + rectangle.width - 4,
        rectangle.top + rectangle.height - 4,
      ],
    ];

    for (const [left, top] of points) {
      const { data } = await sharp(outputPath)
        .extract({ left, top, width: 1, height: 1 })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      if (!expected.every((value, index) => data[index] === value)) {
        throw new Error(
          `Redaction verification failed at ${outputPath}:${left},${top}`,
        );
      }
    }
  }
}

const sourceFiles = await readdir(path.resolve(inputDirectory));
await mkdir(outputDirectory, { recursive: true });

for (const screenshot of screenshots) {
  const matches = sourceFiles.filter((name) => name.startsWith(screenshot.prefix));
  if (matches.length !== 1) {
    throw new Error(
      `Expected one ${screenshot.prefix} screenshot, found ${matches.length}`,
    );
  }

  const sourcePath = path.resolve(inputDirectory, matches[0]);
  const outputPath = path.resolve(outputDirectory, screenshot.output);
  const metadata = await sharp(sourcePath).metadata();
  if (
    metadata.width !== screenshot.size[0] ||
    metadata.height !== screenshot.size[1]
  ) {
    throw new Error(
      `Unexpected dimensions for ${matches[0]}: ${metadata.width}x${metadata.height}`,
    );
  }

  const redactedImage = await sharp(sourcePath).composite([
    {
      input: redactionSvg(metadata.width, metadata.height, screenshot.redactions),
      left: 0,
      top: 0,
    },
  ]).png().toBuffer();
  let pipeline = sharp(redactedImage);
  if (screenshot.crop) {
    pipeline = pipeline.extract(screenshot.crop);
  }
  await pipeline.png({ compressionLevel: 9 }).toFile(outputPath);
  await assertRedactionCorners(outputPath, screenshot.redactions);
  console.log(`Generated ${outputPath}`);
}
