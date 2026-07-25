import cron from "node-cron";
import { runPipeline } from "./run";

// Run the pipeline daily at midnight
cron.schedule("0 0 * * *", () => {
  runPipeline().catch((err) => console.error("Pipeline failed:", err));
});

console.log("Scheduler started.  Running daily at midnight.");

// Run once immediately on startup too
runPipeline().catch((err) => console.error("Initial pipeline run failed:", err));