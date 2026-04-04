import { startDaemon } from "./daemon.js";

startDaemon().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
