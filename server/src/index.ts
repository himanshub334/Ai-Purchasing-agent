import { config } from "./config.ts";
import { createApp } from "./api/app.ts";

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`AI Purchasing Agent API on http://localhost:${config.port} (provider=${config.provider}, sim date ${config.simDate})`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`${sig} received, shutting down`);
    server.close(() => process.exit(0));
  });
}
