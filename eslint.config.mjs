import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Correctness-focused ESLint setup. Intentionally NOT a formatter: this
// codebase deliberately mixes tabs/spaces by file (see CLAUDE.md), so no
// style/whitespace rules — just bug-catching lints, including a curated set of
// type-aware promise rules (no-floating-promises etc.) for this async-heavy CLI.
export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  {
    files: ["src/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        // Enable type-aware linting (uses the nearest tsconfig). Powers the
        // promise rules below, which catch real bugs in this async-heavy code.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // --- type-aware: the high-value ones that catch real async bugs ---
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",

      // `any` is used deliberately at the Wasm / dynamic-import boundary and
      // for a few external-type workarounds; don't flag it.
      "@typescript-eslint/no-explicit-any": "off",
      // The package compiles to CommonJS and uses a few intentional require()
      // calls (package.json version read, lazy fs/path); allow them.
      "@typescript-eslint/no-require-imports": "off",
      // Honor the underscore-prefix convention for intentionally-unused
      // params/vars, and don't flag deliberately-ignored caught errors.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
      // Empty catch blocks are used intentionally for best-effort cleanup.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Allow `let x; ...; x = setInterval(...)` where x is referenced by a
      // closure (cleanup) defined before its assignment — a `const` there
      // would be a forward-reference headache.
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
    },
  },
  {
    // Tests and benches: same correctness lints, but without the type-aware
    // promise rules (jest/fast-check idioms trip them constantly) and with
    // test-pragmatic allowances.
    files: ["test/**/*.ts", "bench/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
);
