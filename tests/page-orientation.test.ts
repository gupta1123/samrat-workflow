import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import {
  buildPageOrientationViews,
  orientPageImageWithVision,
  applyDeclaredPageRotation,
} from "../src/server/processing/page-orientation";

async function sampleImage(width = 1200, height = 800) {
  const bytes = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 246, g: 248, b: 250 },
    },
  })
    .jpeg()
    .toBuffer();
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}

function bytesFromDataUrl(image: string) {
  return Buffer.from(image.slice(image.indexOf(",") + 1), "base64");
}

test("builds four complete visual orientations for the AI reviewer", async () => {
  const views = await buildPageOrientationViews(await sampleImage());
  assert.deepEqual(
    views.map(({ view }) => view),
    ["view_1", "view_2", "view_3", "view_4"],
  );
  assert.equal(
    views.every(({ image }) => image.startsWith("data:image/jpeg")),
    true,
  );

  const metadata = await Promise.all(
    views.map(({ image }) => sharp(bytesFromDataUrl(image)).metadata()),
  );
  assert.deepEqual(
    metadata.map(({ width, height }) => [width, height]),
    [
      [1100, 733],
      [733, 1100],
      [1100, 733],
      [733, 1100],
    ],
  );
});

test("applies the orientation selected by vision without inspecting document values", async () => {
  const image = await sampleImage();
  const oriented = await orientPageImageWithVision({
    image,
    label: "scanned page",
    select: async ({ views }) => {
      assert.equal(views.length, 4);
      return { selectedView: "view_2" };
    },
  });
  const metadata = await sharp(bytesFromDataUrl(oriented)).metadata();
  assert.deepEqual([metadata.width, metadata.height], [800, 1200]);
});

test("rejects an orientation response outside the supplied visual views", async () => {
  await assert.rejects(
    orientPageImageWithVision({
      image: await sampleImage(),
      label: "scanned page",
      select: async () => ({ selectedView: "view_5" }),
    }),
    /invalid view/,
  );
});

test("page classification rotation is applied without making another model call", async () => {
  const image = await sampleImage(1200, 800);
  assert.equal(await applyDeclaredPageRotation(image, 0), image);
  const rotated = await applyDeclaredPageRotation(image, 270);
  const metadata = await sharp(bytesFromDataUrl(rotated)).metadata();
  assert.deepEqual([metadata.width, metadata.height], [800, 1200]);
  await assert.rejects(
    applyDeclaredPageRotation(image, 45),
    /invalid reading rotation/,
  );
});
