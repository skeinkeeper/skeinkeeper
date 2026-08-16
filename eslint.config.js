// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.tsbuildinfo",
      "**/coverage/**",
      "docs/**",
      "behavior/**",
      "app/src/web/static/**",
      "modules/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Per ADR-0009: PostHog and Sentry SDKs must only be imported from the
      // telemetry package. All other modules go through the typed wrapper.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "posthog-node",
              message: "Import the typed telemetry wrapper from `telemetry/` instead.",
            },
            {
              name: "@sentry/node",
              message: "Import the typed telemetry wrapper from `telemetry/` instead.",
            },
          ],
          patterns: [
            {
              group: ["@sentry/*"],
              message: "Import the typed telemetry wrapper from `telemetry/` instead.",
            },
          ],
        },
      ],
    },
  },
  {
    // The telemetry package itself is the one place that legitimately imports
    // the underlying SDKs.
    files: ["telemetry/src/**/*.ts"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  {
    files: ["scripts/**/*.{js,mjs}", ".claude/hooks/**/*.{js,mjs}"],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
];
