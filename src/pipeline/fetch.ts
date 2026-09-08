import { AtpAgent } from "@atproto/api";
import "dotenv/config";

// The public AppView aggregates the whole network — every PDS, including
// third-party ones like Blacksky — so it's the reliable place to read feed
// data from regardless of which server you authenticate against.
const PUBLIC_APPVIEW = "https://public.api.bsky.app";

export async function createAuthedAgent(): Promise<AtpAgent> {
  // This must point at YOUR account's actual PDS, not necessarily bsky.social.
  // See "1a. Find Your Account's PDS Endpoint" if you're not sure what to put here.
  const service = process.env.BSKY_SERVICE ?? "https://bsky.social";
  const agent = new AtpAgent({ service });

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
 * authenticated user. We log in against the user's own PDS (whatever
 * that is) but read the feed from the public AppView — third-party PDS
 * implementations don't all proxy full AppView queries the way
 * bsky.social's combined PDS+AppView does, and the public AppView will
 * have indexed the account regardless of which PDS it lives on.
 */
export async function fetchAllMyPosts(
  agent: AtpAgent
): Promise<FetchedPost[]> {
  const did = agent.session?.did;
  if (!did) throw new Error("Agent is not authenticated");

  const appview = new AtpAgent({ service: PUBLIC_APPVIEW });

  const posts: FetchedPost[] = [];
  let cursor: string | undefined = undefined;

  do {
    const res = await appview.getAuthorFeed({
      actor: did,
      limit: 100,
      ...(cursor ? { cursor } : {}),
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