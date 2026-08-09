const config = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  testPathIgnorePatterns: ["/node_modules/", "/temporal/__tests__/"],
  clearMocks: true,
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.d.ts",
    "!src/**/__tests__/**",
    "!**/*.test.ts",
    "!src/index.ts",
    "!src/**/index.ts",
    "!src/**/client.ts",
    "!src/temporal/worker.ts",
  ],
  coverageDirectory: "coverage",
  coverageThreshold: {
    global: {
      statements: 80,
      branches: 68,
      functions: 80,
      lines: 80,
    },
  },
};

module.exports = config;
