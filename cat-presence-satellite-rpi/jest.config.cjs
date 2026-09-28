module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.spec.ts'],
  transform: { '^.+\\.[tj]s$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }] },
  transformIgnorePatterns: ['/node_modules/(?!@noble/)'],
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
};
