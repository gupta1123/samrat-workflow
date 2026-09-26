import sharp from "sharp";

export const PAGE_ORIENTATION_ROTATIONS = [0, 90, 180, 270] as const;

export type PageOrientationView = {
  view: string;
  image: string;
};

export type PageOrientationSelector = (params: {
  label: string;
  views: PageOrientationView[];
}) => Promise<{ selectedView: string }>;

function decodeImageDataUrl(image: string) {
  const separator = image.indexOf(",");
  if (
    !image.startsWith("data:image/") ||
    separator < 0 ||
    !image.slice(0, separator).includes(";base64")
  ) {
    throw new Error("Page orientation requires a base64 image data URL.");
  }
  return Buffer.from(image.slice(separator + 1), "base64");
}

function jpegDataUrl(bytes: Buffer) {
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}

async function rotatedJpeg(
  input: Buffer,
  rotation: (typeof PAGE_ORIENTATION_ROTATIONS)[number],
  options: { dimension: number; quality: number },
) {
  return sharp(input, { failOn: "none" })
    .autoOrient()
    .rotate(rotation)
    .resize({
      width: options.dimension,
      height: options.dimension,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: options.quality, progressive: true, force: true })
    .toBuffer();
}

export async function buildPageOrientationViews(
  image: string,
): Promise<PageOrientationView[]> {
  const input = decodeImageDataUrl(image);
  return Promise.all(
    PAGE_ORIENTATION_ROTATIONS.map(async (rotation, index) => ({
      view: `view_${index + 1}`,
      image: jpegDataUrl(
        await rotatedJpeg(input, rotation, {
          dimension: 1100,
          quality: 76,
        }),
      ),
    })),
  );
}

export async function orientPageImageWithVision(params: {
  image: string;
  label: string;
  select: PageOrientationSelector;
}) {
  const views = await buildPageOrientationViews(params.image);
  const choice = await params.select({ label: params.label, views });
  const selectedIndex = views.findIndex(
    (candidate) => candidate.view === choice.selectedView,
  );
  if (selectedIndex < 0) {
    throw new Error("The page-orientation reviewer returned an invalid view.");
  }

  const rotation = PAGE_ORIENTATION_ROTATIONS[selectedIndex];
  if (rotation === 0) return params.image;

  const input = decodeImageDataUrl(params.image);
  return jpegDataUrl(
    await rotatedJpeg(input, rotation, {
      dimension: 3200,
      quality: 88,
    }),
  );
}
