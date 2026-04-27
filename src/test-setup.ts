/**
 * Vitest global setup. Runs once before each test file.
 *
 * Set Hustle env vars BEFORE schedule-parser imports — the module
 * captures them at load time, so setting them in beforeAll() is too late.
 */
process.env.HUSTLE_DEFAULT_TEAM_ID = process.env.HUSTLE_DEFAULT_TEAM_ID ?? "test-team-id";
process.env.HUSTLE_URL = process.env.HUSTLE_URL ?? "http://127.0.0.1:3199";
process.env.HUSTLE_INTERNAL_KEY = process.env.HUSTLE_INTERNAL_KEY ?? "test-key";
process.env.JUNECLAW_BRIDGE_PORT = process.env.JUNECLAW_BRIDGE_PORT ?? "13200";
process.env.JUNECLAW_BRIDGE_ALLOW_WRITE = process.env.JUNECLAW_BRIDGE_ALLOW_WRITE ?? "1";
process.env.JUNECLAW_SIGNUP_WEBHOOK_SECRET = process.env.JUNECLAW_SIGNUP_WEBHOOK_SECRET ?? "test-signup-secret-do-not-use";
process.env.JUNECLAW_MAGIC_LINK_WEBHOOK_SECRET = process.env.JUNECLAW_MAGIC_LINK_WEBHOOK_SECRET ?? "test-magic-link-secret-do-not-use";
