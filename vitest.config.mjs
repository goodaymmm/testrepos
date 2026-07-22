/** @type {import("vitest/config").UserConfig} */
export default {
  test: {
    testTimeout: 15_000,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.kairon/**",
      "**/operation-test-results/**"
    ]
  }
};
