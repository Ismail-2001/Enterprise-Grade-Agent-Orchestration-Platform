const config = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  clearMocks: true,
  transformIgnorePatterns: ["/node_modules/(?!@kubernetes/client-node)/"],
};

module.exports = config;
