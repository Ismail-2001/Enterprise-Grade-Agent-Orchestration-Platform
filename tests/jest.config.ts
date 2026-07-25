import path from "path";

const rootDir = path.resolve(__dirname, "..");

const sharedTransform = {
  "^.+\\.ts$": ["ts-jest", {
    tsconfig: path.join(rootDir, "tsconfig.base.json"),
  }],
};

const config = {
  testEnvironment: "node",
  rootDir,
  roots: [path.join(__dirname)],
  testMatch: ["**/*.test.ts"],
  testTimeout: 120000,
  clearMocks: true,
  transform: sharedTransform,
  projects: [
    {
      displayName: "integration",
      testMatch: [path.join(__dirname, "integration", "**", "*.test.ts")],
      rootDir: path.join(__dirname, "integration"),
      transform: sharedTransform,
    },
    {
      displayName: "contract",
      testMatch: [path.join(__dirname, "contract", "**", "*.test.ts")],
      rootDir: path.join(__dirname, "contract"),
      transform: sharedTransform,
    },
    {
      displayName: "chaos",
      testMatch: [path.join(__dirname, "chaos", "**", "*.test.ts")],
      rootDir: path.join(__dirname, "chaos"),
      transform: sharedTransform,
    },
    {
      displayName: "security",
      testMatch: [path.join(__dirname, "security", "**", "*.test.ts")],
      rootDir: path.join(__dirname, "security"),
      transform: sharedTransform,
    },
    {
      displayName: "perf",
      testMatch: [path.join(__dirname, "perf", "**", "*.test.ts")],
      rootDir: path.join(__dirname, "perf"),
      transform: sharedTransform,
    },
  ],
};

export default config;
