import { openDb } from "../db/client.js";

const db = openDb("/app/data/bluesky.db");

console.log(db.prepare("SELECT COUNT(*) as n FROM posts").get());

db.close();