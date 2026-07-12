import "dotenv/config";
import { AtpAgent } from "@atproto/api";

const service = process.env.BSKY_SERVICE ?? "https://bsky.social";
const agent = new AtpAgent({ service });

console.log("Authenticating against:", service);

try {
  console.log("identifier:", JSON.stringify(process.env.BSKY_IDENTIFIER));
  console.log("service:", JSON.stringify(process.env.BSKY_SERVICE));
  console.log("password length:", process.env.BSKY_APP_PASSWORD?.length);

  await agent.login({
    identifier: process.env.BSKY_IDENTIFIER!,
    password: process.env.BSKY_APP_PASSWORD!,
  });
  console.log("Login succeeded. DID:", agent.session?.did);
} catch (err) {
  console.error("Login failed:", err);
}