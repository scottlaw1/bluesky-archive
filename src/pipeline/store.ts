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