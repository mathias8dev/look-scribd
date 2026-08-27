import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.LOOK_SCRIBD_API_PORT || 3435}`,
        changeOrigin: true,
      },
    },
  },
});
