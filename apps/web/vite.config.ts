import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

declare const process: { env: Record<string, string | undefined> };

const server = process.env.AFE_DEV_SERVER ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  // Dev: the Afe server handles the API and webhooks; Vite serves the UI and
  // falls back to index.html for client routes such as /events/<id>.
  server: { proxy: { "/api": server, "/webhooks": server } },
  preview: { proxy: { "/api": server, "/webhooks": server } },
});
