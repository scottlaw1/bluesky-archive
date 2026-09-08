#!/usr/bin/env node
import { Command } from "commander";
import { openDb } from "../db/client.js";

const program = new Command();

program
  .name("bluesky-archive")
  .description("Query your archived Bluesky posts")
  .version("0.1.0")
  .option("--db <path>", "Path to the SQLite dataase", "/app/data/bluesky.db");

program
  .command("list")
  .description("List recent posts")
  .option("-n, --limit <number>", "Number of posts to show", "10")
  .option("--since <date>", "only posts after this ISO date")
  .action((opts) => {
    const db = openDb(program.opts().db);
    let query = "SELECT text, created_at, like_count, repost_count FROM posts";
    const params: unknown[] = [];
    
    if (opts.since) {
      query += " WHERE created_at > ?";
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

    for (const row of rows){
        console.log(`\n[${row.created_at}] likes: ${row.like_count} reposts: ${row.repost_count}`);
        console.log(row.text);
    }
    db.close();
  });

program
  .command("search <term>")
  .description("Full-text search across your posts")
  .action((term: string) => {
    const db = openDb(program.opts().db);
    const rows = db
      .prepare("SELECT text, created_at FROM posts WHERE text LIKE ? ORDER BY created_at DESC")
      .all(`%${term}%`) as Array<{ text: string; created_at: string }>;

    console.log(`Found ${rows.length} posts matching "${term}":`);
    for (const row of rows) {
      console.log(`\n[${row.created_at}] ${row.text}`);
    }
    db.close();
  });

program
  .command("stats")
  .description("Show summary statistics about your archived posts")
  .action(() => {
    const db = openDb(program.opts().db);
    const totalPosts = db.prepare("SELECT COUNT(*) as n FROM posts").get() as { n: number};
    const topLiked = db
      .prepare("SELECT text, like_count FROM posts ORDER BY like_count DESC LIMIT 3")
      .all() as Array<{ text: string; like_count: number }>;
    const topReposted = db
      .prepare("SELECT text, repost_count FROM posts ORDER BY repost_count DESC LIMIT 3")
      .all() as Array<{ text: string; repost_count: number }>;
    const totalLikes = db.prepare("SELECT SUM(like_count) as sum FROM posts").get() as { sum: number };
    const totalReposts = db.prepare("SELECT SUM(repost_count) as sum FROM posts").get() as { sum: number };

    console.log(`Total posts: ${totalPosts.n}`);
    console.log(`Total likes: ${totalLikes.sum}`);
    console.log(`Total reposts: ${totalReposts.sum}`);
    console.log("\nTop 3 liked posts:");
    for (const row of topLiked) {
      console.log(`\n[${row.like_count} likes] ${row.text}`);
    }
    console.log("\nTop 3 reposted posts:");
    for (const row of topReposted) {
      console.log(`\n[${row.repost_count} reposts] ${row.text}`);
    }
    db.close();
  });

  program.parse();