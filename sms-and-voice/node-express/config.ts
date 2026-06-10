// Configuration — the Dial API key is sourced ONLY from the environment (.env).
// .env is loaded by Node itself via the `--env-file-if-exists=.env` start flag.

export interface Settings {
  apiKey: string;
  baseUrl: string;
  numberId?: string; // explicit default sending number id, optional
}

export function loadSettings(): Settings {
  const apiKey = (process.env.DIAL_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error(
      "DIAL_API_KEY is not set. Put it in .env:\n    DIAL_API_KEY=sk_live_...",
    );
  }
  const baseUrl = (process.env.DIAL_BASE_URL ?? "https://getdial.ai").trim();
  const numberId = (process.env.DIAL_NUMBER_ID ?? "").trim() || undefined;
  return { apiKey, baseUrl, numberId };
}
