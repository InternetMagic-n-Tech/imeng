/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  // ESM + TypeScript (run via: node --experimental-vm-modules node_modules/jest/bin/jest.js)
  extensionsToTreatAsEsm: [".ts"],
  transform: { "^.+\\.ts$": ["ts-jest", { useESM: true, tsconfig: "tsconfig.json" }] },
  moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" }, // TS source imports use ".js" extensions
  testMatch: ["<rootDir>/tests/**/*.test.ts"],
  setupFiles: ["<rootDir>/tests/setup-env.ts"],
  collectCoverageFrom: ["src/utils/**/*.ts", "src/hub/**/*.ts", "src/app.ts", "!src/utils/types.ts", "!src/utils/**/*.d.cts"],
  silent: true,
  coverageDirectory: "coverage",
  coverageReporters: ["text", "lcov"],
  coverageThreshold: { global: { statements: 85, branches: 75, functions: 85, lines: 85 } },
};
