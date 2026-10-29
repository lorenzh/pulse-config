import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import sonarjs from "eslint-plugin-sonarjs";

export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/public/**", "**/coverage/**"],
  },
  {
    ...sonarjs.configs.recommended,
    files: ["**/*.ts", "**/*.js"],
    languageOptions: { parser: tsParser },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      ...sonarjs.configs.recommended.rules,
      "sonarjs/cognitive-complexity": ["error", 15],
    },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { projectService: true, tsconfigRootDir: process.cwd() },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          // node:test registers and awaits these itself.
          allowForKnownSafeCalls: [
            {
              from: "package",
              package: "node:test",
              name: [
                "test",
                "it",
                "describe",
                "suite",
                "before",
                "after",
                "beforeEach",
                "afterEach",
              ],
            },
          ],
        },
      ],
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
];
