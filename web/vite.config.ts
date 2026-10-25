import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  base: "/",
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:47321", "/avatars": "http://127.0.0.1:47321", "/ws": { target: "ws://127.0.0.1:47321", ws: true } } },
});
