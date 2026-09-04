import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**"] },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        {
          // `path` is relative to eslint's cwd, which differs between
          // `pnpm run lint` (repo root) and `pnpm --filter … lint` (package
          // dir) — match by name only rather than a cwd-relative path.
          allow: [{ from: "file", name: "Money" }],
        },
      ],
    },
  },
  {
    // Ports are async so a real adapter (Postgres) can await I/O; in-memory
    // and mock adapters, and test fakes, legitimately implement them without
    // an await.
    files: ["**/adapters/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
    },
  },
  eslintConfigPrettier,
);
