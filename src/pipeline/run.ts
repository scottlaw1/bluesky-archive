import { openDb } from "../db/client.js";
import { createAuthedAgent, fetchAllMyPosts } from "./fetch.js";
import { upsertPosts } from "./store.js";

export async function runPipeline(dbPath = "bluesky.db") {
  const db = openDb(dbPath);
  const startedAt = new Date().toISOString();

  try {
    const agent = await createAuthedAgent();
    const posts = await fetchAllMyPosts(agent);
    const { inserted, updated } = upsertPosts(db, posts);

    db.prepare(
      `INSERT INTO sync_log (posts_fetched, posts_inserted, posts_updated, status)
       VALUES (?, ?, ?, 'success')`
    ).run(posts.length, inserted, updated);

    console.log(
      `[${startedAt}] Fetched ${posts.length}, inserted ${inserted}, updated ${updated}`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare(
      `INSERT INTO sync_log (posts_fetched, posts_inserted, posts_updated, status, error_message)
       VALUES (0, 0, 0, 'error', ?)`
    ).run(message);
    console.error(`[${startedAt}] Pipeline failed:`, message);
    throw err;
  } finally {
    db.close();
  }
}

// Allow `tsx src/pipeline/run.ts` to run this directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runPipeline().catch(() => process.exit(1));
}