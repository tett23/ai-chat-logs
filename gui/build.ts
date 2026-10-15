// docs/adr/0003: bundle the frontend with Bun's HTML bundler and Tailwind.
import tailwind from "bun-plugin-tailwind";

const result = await Bun.build({
  entrypoints: ["./index.html"],
  outdir: "./dist",
  plugins: [tailwind],
  minify: true,
});
if (!result.success) {
  result.logs.forEach((log) => console.error(log));
  process.exit(1);
}
