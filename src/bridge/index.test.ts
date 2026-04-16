import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { validateHustleConfig } from "./index.js";

describe("validateHustleConfig", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  const savedEnv = {
    HUSTLE_URL: process.env.HUSTLE_URL,
    HUSTLE_DEFAULT_TEAM_ID: process.env.HUSTLE_DEFAULT_TEAM_ID,
    HUSTLE_INTERNAL_KEY: process.env.HUSTLE_INTERNAL_KEY,
  };

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env.HUSTLE_URL = savedEnv.HUSTLE_URL;
    process.env.HUSTLE_DEFAULT_TEAM_ID = savedEnv.HUSTLE_DEFAULT_TEAM_ID;
    process.env.HUSTLE_INTERNAL_KEY = savedEnv.HUSTLE_INTERNAL_KEY;
    warn.mockRestore();
  });

  test("silent when all env vars are valid", () => {
    process.env.HUSTLE_URL = "http://127.0.0.1:3100";
    process.env.HUSTLE_DEFAULT_TEAM_ID = "team-1";
    process.env.HUSTLE_INTERNAL_KEY = "key-1";

    validateHustleConfig();

    expect(warn).not.toHaveBeenCalled();
  });

  test("warns on malformed HUSTLE_URL", () => {
    process.env.HUSTLE_URL = "not a url";
    process.env.HUSTLE_DEFAULT_TEAM_ID = "team-1";
    process.env.HUSTLE_INTERNAL_KEY = "key-1";

    validateHustleConfig();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("HUSTLE_URL is malformed"));
  });

  test("warns when HUSTLE_DEFAULT_TEAM_ID is missing", () => {
    process.env.HUSTLE_URL = "http://127.0.0.1:3100";
    delete process.env.HUSTLE_DEFAULT_TEAM_ID;
    process.env.HUSTLE_INTERNAL_KEY = "key-1";

    validateHustleConfig();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("HUSTLE_DEFAULT_TEAM_ID not set"));
  });

  test("warns when HUSTLE_INTERNAL_KEY is missing", () => {
    process.env.HUSTLE_URL = "http://127.0.0.1:3100";
    process.env.HUSTLE_DEFAULT_TEAM_ID = "team-1";
    delete process.env.HUSTLE_INTERNAL_KEY;

    validateHustleConfig();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("HUSTLE_INTERNAL_KEY not set"));
  });

  test("emits multiple warnings at once when multiple gaps exist", () => {
    delete process.env.HUSTLE_DEFAULT_TEAM_ID;
    delete process.env.HUSTLE_INTERNAL_KEY;

    validateHustleConfig();

    expect(warn).toHaveBeenCalledTimes(2);
  });
});
