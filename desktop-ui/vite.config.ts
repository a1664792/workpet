import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  // Tauri 固定窗口尺寸，禁止 vite 清屏输出干扰
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { target: "chrome105", outDir: "dist" },
});
