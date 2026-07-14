/** @type {import("vitest/config").UserConfig} */
export default {
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.kairon/**",
      "**/operation-test-results/**"
    ]
  }
};
