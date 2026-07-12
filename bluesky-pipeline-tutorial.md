# Building a Bluesky Post Archive: A Hands-On Tutorial

This tutorial walks you through building two connected components in TypeScript:

1. **A data pipeline** that pulls your Bluesky posts via the AT Protocol API on a schedule and stores them in SQLite.
2. **A CLI** for querying that database.

You'll end up with a small, real project — not a toy — that you can extend later (Postgres, a web dashboard, sentiment tagging, whatever).

---

## 0. Prerequisites

- Node.js 20+ (check with `node -v`)
- A Bluesky account and an **app password** (Settings → App Passwords in the Bluesky app — never use your main account password in code)
- Familiarity with TypeScript basics

---

## 1. Project Setup

```bash
mkdir bluesky-archive && cd bluesky-archive
npm init -y
npm install typescript tsx @types/node --save-dev
npx tsc --init
```

Edit `tsconfig.json` to something sane for a Node CLI/service project:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

Set `"type": "module"` in `package.json` so we can use ESM imports throughout.

Now install the runtime dependencies:

```bash
npm install @atproto/api better-sqlite3 dotenv commander node-cron
npm install --save-dev @types/better-sqlite3 @types/node-cron
```

- `@atproto/api` — official AT Protocol client, handles Bluesky auth and post fetching
- `better-sqlite3` — synchronous, fast, dead-simple SQLite bindings (perfect for a single-writer pipeline)
- `dotenv` — loads your credentials from a `.env` file
- `commander` — CLI argument parsing
- `node-cron` — in-process scheduling (we'll also cover the macOS `launchd` alternative)

Create the folder structure:

```bash
mkdir -p src/{db,pipeline,cli}
```

Create `.env` (and add it to `.gitignore` immediately):

```
BSKY_IDENTIFIER=your-handle.bsky.social
BSKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

```bash
echo ".env" >> .gitignore
echo "node_modules" >> .gitignore
echo "dist" >> .gitignore
echo "*.db" >> .gitignore
```

---

## 2. Database Layer

We'll design a schema that stores posts idempotently — re-running the pipeline shouldn't create duplicates, and it should be safe to run on a schedule indefinitely.

Create `src/db/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS posts (
  uri TEXT PRIMARY KEY,
  cid TEXT NOT NULL,
  author_handle TEXT NOT NULL,
  author_did TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  reply_count INTEGER DEFAULT 0,
  repost_count INTEGER DEFAULT 0,
  like_count INTEGER DEFAULT 0,
  quote_count INTEGER DEFAULT 0,
  raw_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at TEXT NOT NULL DEFAULT (datetime('now')),
  posts_fetched INTEGER NOT NULL,
  posts_inserted INTEGER NOT NULL,
  posts_updated INTEGER NOT NULL,
  status TEXT NOT NULL,
  error_message TEXT
);
```

Design notes:

- `uri` (e.g. `at://did:plc:.../app.bsky.feed.post/xyz`) is the natural primary key — it's globally unique and stable.
- Engagement counts (`like_count`, etc.) can change after the fact, so we store them and **update on conflict** rather than ignoring duplicates.
- `raw_json` keeps the full API response so you're not stuck if you didn't extract a field you later want — you can always backfill from it.
- `sync_log` gives you a lightweight audit trail for a scheduled job, which you'll want the first time it silently fails at 3am.

Create `src/db/client.ts`:

```typescript
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function openDb(path = "bluesky.db") {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  const schema = readFileSync(join(__dirname, "schema.sql"), "utf-8");
  db.exec(schema);
  return db;
}
```

`WAL` mode matters here: it lets the CLI read the database concurrently while the pipeline is mid-write, which will happen if your scheduled job and an ad-hoc query overlap.

---

## 3. The Pipeline: Fetching Posts

Create `src/pipeline/fetch.ts`:

```typescript
import { AtpAgent } from "@atproto/api";
import "dotenv/config";

export async function createAuthedAgent(): Promise<AtpAgent> {
  const agent = new AtpAgent({ service: "https://bsky.social" });

  const identifier = process.env.BSKY_IDENTIFIER;
  const password = process.env.BSKY_APP_PASSWORD;

  if (!identifier || !password) {
    throw new Error(
      "Missing BSKY_IDENTIFIER or BSKY_APP_PASSWORD in environment"
    );
  }

  await agent.login({ identifier, password });
  return agent;
}

export interface FetchedPost {
  uri: string;
  cid: string;
  authorHandle: string;
  authorDid: string;
  text: string;
  createdAt: string;
  indexedAt: string;
  replyCount: number;
  repostCount: number;
  likeCount: number;
  quoteCount: number;
  raw: unknown;
}

/**
 * Fetches all posts (paginating through the author feed) for the
 * authenticated user. Bluesky's getAuthorFeed includes reposts and
 * replies by default — we filter to original posts here, but keep
 * the raw payload so you can change your mind later.
 */
export async function fetchAllMyPosts(
  agent: AtpAgent
): Promise<FetchedPost[]> {
  const did = agent.session?.did;
  if (!did) throw new Error("Agent is not authenticated");

  const posts: FetchedPost[] = [];
  let cursor: string | undefined = undefined;

  do {
    const res = await agent.getAuthorFeed({
      actor: did,
      limit: 100,
      cursor,
      filter: "posts_no_replies", // adjust: posts_with_replies, posts_with_media, etc.
    });

    for (const item of res.data.feed) {
      const post = item.post;
      // Only include posts authored by us (not reposts surfaced in the feed)
      if (post.author.did !== did) continue;

      const record = post.record as { text?: string; createdAt?: string };

      posts.push({
        uri: post.uri,
        cid: post.cid,
        authorHandle: post.author.handle,
        authorDid: post.author.did,
        text: record.text ?? "",
        createdAt: record.createdAt ?? post.indexedAt,
        indexedAt: post.indexedAt,
        replyCount: post.replyCount ?? 0,
        repostCount: post.repostCount ?? 0,
        likeCount: post.likeCount ?? 0,
        quoteCount: post.quoteCount ?? 0,
        raw: post,
      });
    }

    cursor = res.data.cursor;
  } while (cursor);

  return posts;
}
```

A few things worth understanding, not just copying:

- **Pagination via cursor** is the standard AT Protocol pattern — almost every list endpoint works this way. Once you've internalized this loop, you can reuse it for likes, follows, or any other feed.
- `getAuthorFeed` mixes in reposts; filtering `post.author.did !== did` keeps this pipeline scoped to posts you actually wrote. If you *want* reposts too, drop the filter and add a `record_type` column instead.
- We keep `raw` around specifically so early design mistakes are cheap to fix.

---

## 4. The Pipeline: Storing Posts (Upsert Logic)

Create `src/pipeline/store.ts`:

```typescript
import type Database from "better-sqlite3";
import type { FetchedPost } from "./fetch.js";

export interface StoreResult {
  inserted: number;
  updated: number;
}

export function upsertPosts(
  db: Database.Database,
  posts: FetchedPost[]
): StoreResult {
  const upsert = db.prepare(`
    INSERT INTO posts (
      uri, cid, author_handle, author_did, text, created_at, indexed_at,
      reply_count, repost_count, like_count, quote_count, raw_json, fetched_at
    ) VALUES (
      @uri, @cid, @authorHandle, @authorDid, @text, @createdAt, @indexedAt,
      @replyCount, @repostCount, @likeCount, @quoteCount, @rawJson, datetime('now')
    )
    ON CONFLICT(uri) DO UPDATE SET
      reply_count = excluded.reply_count,
      repost_count = excluded.repost_count,
      like_count = excluded.like_count,
      quote_count = excluded.quote_count,
      fetched_at = datetime('now')
    WHERE
      reply_count != excluded.reply_count OR
      repost_count != excluded.repost_count OR
      like_count != excluded.like_count OR
      quote_count != excluded.quote_count
  `);

  let inserted = 0;
  let updated = 0;

  const runAll = db.transaction((rows: FetchedPost[]) => {
    for (const p of rows) {
      const result = upsert.run({
        uri: p.uri,
        cid: p.cid,
        authorHandle: p.authorHandle,
        authorDid: p.authorDid,
        text: p.text,
        createdAt: p.createdAt,
        indexedAt: p.indexedAt,
        replyCount: p.replyCount,
        repostCount: p.repostCount,
        likeCount: p.likeCount,
        quoteCount: p.quoteCount,
        rawJson: JSON.stringify(p.raw),
      });
      // changes === 1 on a fresh insert; 0 or 1 on update depending on WHERE match
      if (result.changes === 1) {
        // Can't cheaply distinguish insert vs update-that-changed here without
        // a pre-check; see note below.
        inserted++;
      }
    }
  });

  runAll(posts);
  return { inserted, updated };
}
```

**Design note worth calling out explicitly:** SQLite's `changes` count doesn't tell you whether a row was inserted or updated — both count as one change. If you actually need accurate insert/update counts for `sync_log` (useful for spotting anomalies), do a cheap pre-check instead:

```typescript
const exists = db.prepare("SELECT 1 FROM posts WHERE uri = ?");
// then branch: exists.get(p.uri) ? updated++ : inserted++ , before running upsert
```

That's the kind of tradeoff — write-simplicity vs. observability — you'll hit constantly building pipelines. I'm flagging it rather than silently picking one for you.

---

## 5. Wiring the Pipeline Together

Create `src/pipeline/run.ts`:

```typescript
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
```

Test it manually first, before adding scheduling:

```bash
npx tsx src/pipeline/run.ts
```

You should see a `bluesky.db` file appear and a success line logged. Inspect it:

```bash
sqlite3 bluesky.db "SELECT text, created_at FROM posts ORDER BY created_at DESC LIMIT 5;"
```

---

## 6. Scheduling

You have two reasonable options. Pick based on how you want this to run long-term.

### Option A — `node-cron` (pipeline manages its own schedule)

Create `src/pipeline/schedule.ts`:

```typescript
import cron from "node-cron";
import { runPipeline } from "./run.js";

// Every hour at minute 0. Adjust to taste — Bluesky's API doesn't need
// aggressive polling for a single-account archive.
cron.schedule("0 * * * *", () => {
  runPipeline().catch((err) => console.error("Scheduled run failed:", err));
});

console.log("Scheduler started. Running hourly.");

// Run once immediately on startup too
runPipeline().catch((err) => console.error("Initial run failed:", err));
```

Run it as a long-lived process:

```bash
npx tsx src/pipeline/schedule.ts
```

This is simplest to reason about but requires something to keep the process alive (a terminal, `pm2`, a Docker container, etc.).

### Option B — macOS `launchd` (system manages the schedule)

Since you're on a Mac mini, this is arguably the more idiomatic choice — no long-running Node process to babysit, and it survives reboots. Build first:

```bash
npx tsc
```

Create `~/Library/LaunchAgents/com.scott.bluesky-archive.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.scott.bluesky-archive</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/scott/bluesky-archive/dist/pipeline/run.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/scott/bluesky-archive</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/scott/bluesky-archive/logs/pipeline.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/scott/bluesky-archive/logs/pipeline-error.log</string>
</dict>
</plist>
```

Adjust the `node` path (`which node`) and the project path to match your setup. Then load it:

```bash
mkdir -p logs
launchctl load ~/Library/LaunchAgents/com.scott.bluesky-archive.plist
```

Check it ran:

```bash
launchctl list | grep bluesky-archive
cat logs/pipeline.log
```

To stop it: `launchctl unload ~/Library/LaunchAgents/com.scott.bluesky-archive.plist`.

---

## 7. The CLI

Create `src/cli/index.ts`:

```typescript
#!/usr/bin/env node
import { Command } from "commander";
import { openDb } from "../db/client.js";

const program = new Command();
program
  .name("bsky-archive")
  .description("Query your archived Bluesky posts")
  .version("0.1.0");

program
  .command("list")
  .description("List recent posts")
  .option("-n, --limit <number>", "number of posts to show", "10")
  .option("--since <date>", "only posts after this ISO date")
  .action((opts) => {
    const db = openDb();
    let query = "SELECT text, created_at, like_count, repost_count FROM posts";
    const params: unknown[] = [];

    if (opts.since) {
      query += " WHERE created_at >= ?";
      params.push(opts.since);
    }
    query += " ORDER BY created_at DESC LIMIT ?";
    params.push(Number(opts.limit));

    const rows = db.prepare(query).all(...params) as Array<{
      text: string;
      created_at: string;
      like_count: number;
      repost_count: number;
    }>;

    for (const row of rows) {
      console.log(`\n[${row.created_at}] ❤ ${row.like_count} 🔁 ${row.repost_count}`);
      console.log(row.text);
    }
    db.close();
  });

program
  .command("search <term>")
  .description("Full-text search across your posts")
  .action((term: string) => {
    const db = openDb();
    const rows = db
      .prepare("SELECT text, created_at FROM posts WHERE text LIKE ? ORDER BY created_at DESC")
      .all(`%${term}%`) as Array<{ text: string; created_at: string }>;

    console.log(`Found ${rows.length} matching posts:\n`);
    for (const row of rows) {
      console.log(`[${row.created_at}] ${row.text}\n`);
    }
    db.close();
  });

program
  .command("stats")
  .description("Show summary statistics")
  .action(() => {
    const db = openDb();
    const total = db.prepare("SELECT COUNT(*) as n FROM posts").get() as { n: number };
    const topLiked = db
      .prepare("SELECT text, like_count FROM posts ORDER BY like_count DESC LIMIT 3")
      .all() as Array<{ text: string; like_count: number }>;
    const lastSync = db
      .prepare("SELECT run_at, status FROM sync_log ORDER BY run_at DESC LIMIT 1")
      .get() as { run_at: string; status: string } | undefined;

    console.log(`Total posts archived: ${total.n}`);
    console.log(`Last sync: ${lastSync ? `${lastSync.run_at} (${lastSync.status})` : "never"}`);
    console.log("\nTop liked posts:");
    for (const p of topLiked) {
      console.log(`  ❤ ${p.like_count} — ${p.text.slice(0, 80)}`);
    }
    db.close();
  });

program.parse();
```

Wire it up as a real binary. In `package.json`:

```json
{
  "bin": {
    "bsky-archive": "./dist/cli/index.js"
  },
  "scripts": {
    "build": "tsc",
    "cli": "tsx src/cli/index.ts"
  }
}
```

During development:

```bash
npm run cli -- list --limit 5
npm run cli -- search "loyalty"
npm run cli -- stats
```

After building (`npm run build`) and optionally `npm link`, you can invoke `bsky-archive list` from anywhere.

---

## 8. What's Genuinely Worth Doing Next

Once the above works end-to-end, here's where this project has real room to grow — roughly in order of leverage per effort:

1. **Rate-limit / retry handling** in `fetch.ts` — Bluesky's API will throttle you eventually; wrap `getAuthorFeed` calls with exponential backoff.
2. **Full-text search via SQLite FTS5** instead of `LIKE '%term%'` — trivial to add (`CREATE VIRTUAL TABLE posts_fts USING fts5(...)`) and dramatically better for anything beyond toy queries.
3. **Export command** (`bsky-archive export --format json|csv`) — useful once you're archiving for real, not just testing.
4. **Delta-only fetching** — right now every run re-fetches your whole feed. Once you have enough posts that this gets slow, track the newest `indexed_at` you've stored and stop paginating once you hit it.
5. **Config file instead of hardcoded schedule** — cron expression, DB path, and feed filter as CLI flags or a `config.json`, if you ever want to run this for more than one account.

---

You now have a working pipeline and CLI. Run `npx tsx src/pipeline/run.ts` once to seed the database, then try the CLI commands above against real data before setting up scheduling — it's much easier to debug the fetch/store logic without a cron job racing you.
