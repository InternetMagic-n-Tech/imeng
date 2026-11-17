import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

// Report-only: no formatting rules, and `npm run lint` never passes --fix, so it cannot change code.
export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**", "saves/**", "docker/**", "logs/**", "_cache/**", "**/.venv/**", "imeng.schema.json"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      // Real findings in existing code, kept as warnings so lint can gate CI without a code rewrite.
      "prefer-const": "warn", "no-useless-assignment": "warn", "preserve-caught-error": "warn", "no-useless-escape": "warn", "no-control-regex": "warn",
      "@typescript-eslint/no-unused-expressions": "warn", "@typescript-eslint/no-require-imports": "warn", "@typescript-eslint/ban-ts-comment": "warn",
    },
  },
);
