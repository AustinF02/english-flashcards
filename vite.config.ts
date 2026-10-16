import { defineConfig } from "vite";

// base '/' works for the default *.cloudfront.net URL (spec §3).
export default defineConfig({
  base: "/",
  build: { outDir: "dist", sourcemap: false },
  test: {
    environment: "jsdom",
    environmentOptions: { jsdom: { url: "http://localhost/" } },
    include: ["test/**/*.test.ts"],
  },
});
