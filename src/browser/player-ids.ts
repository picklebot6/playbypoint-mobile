import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

export type PlayerIds = Readonly<Record<string, number>>;

export function parsePlayerIds(text: string): PlayerIds {
  const value: unknown = JSON.parse(text);

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Player IDs must be a JSON object mapping names to numeric IDs");
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    throw new Error("Player IDs must contain at least one player");
  }

  const ids: Record<string, number> = Object.create(null);
  for (const [name, id] of entries) {
    if (!name.trim() || name !== name.trim() ||
        typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`Invalid player ID entry for: ${name}`);
    }
    ids[name] = id;
  }

  return Object.freeze(ids);
}

export async function loadPlayerIds(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PlayerIds> {
  const required = [
    "PLAYBYPOINT_R2_ACCOUNT_ID",
    "PLAYBYPOINT_R2_BUCKET",
    "PLAYBYPOINT_R2_ACCESS_KEY_ID",
    "PLAYBYPOINT_R2_SECRET_ACCESS_KEY",
  ] as const;
  const configured = required.filter((name) => env[name]?.trim());

  // Keep existing runs working until the private bucket is configured.
  if (configured.length === 0 && !env.PLAYBYPOINT_R2_PLAYER_IDS_KEY?.trim()) {
    const ids = parsePlayerIds(await readFile(
      resolve(__dirname, "../../data/player-ids.json"), "utf8",
    ));
    console.log(`Loaded ${Object.keys(ids).length} player IDs from local JSON`);
    return ids;
  }

  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing R2 configuration: ${missing.join(", ")}`);
  }

  const accountId = env.PLAYBYPOINT_R2_ACCOUNT_ID!.trim();
  if (!/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new Error("PLAYBYPOINT_R2_ACCOUNT_ID must be a Cloudflare account ID");
  }

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.PLAYBYPOINT_R2_ACCESS_KEY_ID!.trim(),
      secretAccessKey: env.PLAYBYPOINT_R2_SECRET_ACCESS_KEY!.trim(),
    },
    maxAttempts: 2,
  });

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 15_000);
  try {
    const response = await client.send(new GetObjectCommand({
      Bucket: env.PLAYBYPOINT_R2_BUCKET!.trim(),
      Key: env.PLAYBYPOINT_R2_PLAYER_IDS_KEY?.trim() || "player-ids.json",
    }), { abortSignal: abort.signal });
    if (!response.Body) {
      throw new Error("R2 player IDs object has no body");
    }
    const ids = parsePlayerIds(await response.Body.transformToString());
    console.log(`Loaded ${Object.keys(ids).length} player IDs from R2`);
    return ids;
  } finally {
    clearTimeout(timeout);
    client.destroy();
  }
}
