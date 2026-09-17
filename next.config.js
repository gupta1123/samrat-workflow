/** @type {import('next').NextConfig} */
module.exports = {
  output: "standalone",
  distDir: process.env.SAMRAT_NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["@napi-rs/canvas", "pdfjs-dist", "sharp"],
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
      "./node_modules/pdfjs-dist/standard_fonts/**/*",
      "./node_modules/pdfjs-dist/cmaps/**/*",
    ],
  },
};
