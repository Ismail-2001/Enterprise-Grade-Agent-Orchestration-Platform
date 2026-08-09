const config = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  clearMocks: true,
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  coverageDirectory: "coverage",
  coverageThreshold: {
    global: {
      statements: 85,
      branches: 70,
      functions: 75,
      lines: 85,
    },
  },
};

module.exports = config;
