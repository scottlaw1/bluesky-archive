import "dotenv/config";

async function resolvePds(handle: string) {
  // Handle -> DID, via the public AppView. This step works regardless of
  // which PDS you're actually on.
  const resolveRes = await fetch(
    `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(
      handle
    )}`
  );
  if (!resolveRes.ok) {
    throw new Error(`Handle resolution failed: ${resolveRes.status} ${await resolveRes.text()}`);
  }
  const { did } = (await resolveRes.json()) as { did: string };

  // DID -> DID document, which lists the account's actual PDS service endpoint.
  const docUrl = did.startsWith("did:plc:")
    ? `https://plc.directory/${did}`
    : `https://${did.replace("did:web:", "")}/.well-known/did.json`;

  const docRes = await fetch(docUrl);
  const doc = (await docRes.json()) as {
    service?: Array<{ id: string; serviceEndpoint: string }>;
  };

  const pds = doc.service?.find((s) => s.id === "#atproto_pds");

  console.log("DID:", did);
  console.log("PDS endpoint:", pds?.serviceEndpoint ?? "not found in DID document");
}

const handle = process.env.BSKY_IDENTIFIER;
if (!handle) throw new Error("Set BSKY_IDENTIFIER in .env first");
resolvePds(handle);