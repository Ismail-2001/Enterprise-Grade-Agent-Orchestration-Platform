import { loadConfig, BaseConfigSchema } from "../config/index.js";
import { validateSecrets, validateJWTSecret } from "../config/validate-secrets.js";
import { FatalConfigError } from "../errors/index.js";

jest.mock("../config/secrets.js", () => ({
  getSecret: jest.fn(),
}));

import { getSecret } from "../config/secrets.js";

const mockGetSecret = getSecret as jest.Mock;

const processExitSpy = jest.spyOn(process, "exit").mockImplementation((() => {}) as never);

afterAll(() => {
  processExitSpy.mockRestore();
});

const HIGH_ENTROPY_JWT = "JWT-SECRET-zX9!mQ2@pL5#rV7$wK4&yT8*zH1+dB3-cN6_eA0~fG2?jU5.oS1xW7%";
const VALID_SECRETS: Record<string, string> = {
  EGAOP_MASTER_ENCRYPTION_KEY: "k".repeat(64),
  JWT_SECRET: HIGH_ENTROPY_JWT,
  POSTGRES_PASSWORD: "pg-secret-12345678901234567890",
  OPENAI_API_KEY: "sk-abcdefghij",
  GRAFANA_PASSWORD: "grafana-secret-1234567890123456",
  INTERNAL_SERVICE_TOKEN: "svc-token-123456789012345678901234567890123456789012345678",
  REDIS_PASSWORD: "redis-secret-1234567890123456",
};

describe("loadConfig", () => {
  const schema = BaseConfigSchema;

  afterEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.TLS_ENABLED;
  });

  it("parses and applies defaults", () => {
    delete process.env.NODE_ENV;
    const config = loadConfig(schema, "test-service");
    expect(config.NODE_ENV).toBe("development");
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.TLS_ENABLED).toBe(false);
    expect(config.TLS_CERT_DIR).toBe("/etc/egaop/certs");
  });

  it("applies environment overrides", () => {
    process.env.NODE_ENV = "production";
    process.env.TLS_ENABLED = "true";
    const config = loadConfig(schema, "test-service-2");
    expect(config.NODE_ENV).toBe("production");
    expect(config.TLS_ENABLED).toBe(true);
  });

  it("throws on invalid values", () => {
    process.env.NODE_ENV = "not-a-real-env";
    expect(() => loadConfig(schema, "bad-service")).toThrow(/Configuration validation failed/);
  });

  it("caches by service name", () => {
    const first = loadConfig(schema, "cache-service");
    process.env.NODE_ENV = "production";
    const second = loadConfig(schema, "cache-service");
    expect(second).toBe(first);
  });
});

describe("validateSecrets", () => {
  afterEach(() => {
    mockGetSecret.mockReset();
  });

  it("passes when all required secrets are valid", () => {
    mockGetSecret.mockImplementation((name: string) => VALID_SECRETS[name]);

    validateSecrets();
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it("exits when a required secret is missing", () => {
    mockGetSecret.mockReturnValue(undefined);
    validateSecrets();
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("rejects a known-bad value", () => {
    mockGetSecret.mockImplementation((name: string) => (name === "OPENAI_API_KEY" ? "password" : undefined));
    validateSecrets();
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("rejects a short value", () => {
    mockGetSecret.mockImplementation((name: string) => (name === "OPENAI_API_KEY" ? "short" : undefined));
    validateSecrets();
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("supports extra secrets passed by the caller", () => {
    mockGetSecret.mockImplementation((name: string) =>
      name === "MY_CUSTOM_SECRET" ? "my-custom-secret-1234567890" : VALID_SECRETS[name]
    );
    validateSecrets([{ name: "MY_CUSTOM_SECRET", minLength: 8 }]);
    expect(processExitSpy).not.toHaveBeenCalled();
  });
});

describe("validateJWTSecret", () => {
  afterEach(() => {
    mockGetSecret.mockReset();
  });

  it("throws FatalConfigError when the JWT secret is too short", () => {
    mockGetSecret.mockReturnValue("short");
    expect(() => validateJWTSecret()).toThrow(FatalConfigError);
  });

  it("passes for a high-entropy secret of sufficient length", () => {
    mockGetSecret.mockReturnValue(HIGH_ENTROPY_JWT);
    expect(() => validateJWTSecret()).not.toThrow();
  });
});
