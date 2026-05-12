// Minimal ESLint flat config for pushwork.
//
// Goal: catch genuine bugs (undeclared bindings, unreachable code, etc.) without
// nitpicking existing style — formatting belongs to Prettier (.prettierrc).
//
// Most stylistic rules from typescript-eslint's `recommended` set are toned down
// here so this can run green on the existing codebase. Tighten over time.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "**/*.d.ts"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      // `ignoreReadBeforeAssign` keeps the rule from flagging the legitimate
      // pattern where a `let` is declared first so it can be captured by a
      // closure defined immediately afterward, and is then assigned later
      // (e.g. `let timer; const cleanup = () => clearTimeout(timer); timer = setTimeout(...)`).
      // Rewriting those to `const` would force restructuring just to silence
      // the lint without any real readability gain.
      "prefer-const": ["warn", { ignoreReadBeforeAssign: true }],
    },
  },
);
