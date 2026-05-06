import { startClusterWorker } from "./cluster.js";

startClusterWorker().catch((error) => {
  console.error("Failed to start cluster worker.");
  console.error(error);
  process.exit(1);
});
