// ESLint flat config for the space-agent Node/browser shell.
//
// Scope is deliberately the code THIS project owns and maintains:
//   • server/, commands/, tests/, and root scripts (Node ESM)
//   • server/pages/res/** — browser scripts served by the shell
//   • app/L0/_all/mod/_prime_silo/** — the project's own browser modules
//
// The rest of app/L0 is the vendored upstream space-agent framework; like
// runtime/ (Python) and node_modules, it is not linted here — gating thousands
// of legacy framework files would drown real findings.
//
// IMPORTANT: every config object below that carries `rules` also carries
// `files`. A rules-bearing object WITHOUT `files` is global and would pull every
// non-ignored file into linting (that is why eslint-config-prettier is folded
// into the rule sets here rather than added as a standalone entry). Prettier
// owns formatting; ESLint owns correctness only, so the two never fight.

import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier";

const recommended = js.configs.recommended.rules;

const baseRules = {
  ...recommended,
  ...prettier.rules,
  "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
  "no-var": "error",
  "prefer-const": "warn",
  eqeqeq: ["error", "smart"],
  "no-throw-literal": "error",
  // Empty catch is an intentional idiom here (best-effort cleanup, optional I/O).
  "no-empty": ["error", { allowEmptyCatch: true }]
};

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "packaging/node_modules/**",
      "packaging/runtime-bundle/**",
      "runtime/**",
      ".benny_home/**",
      "home/**",
      "site/**",
      "**/*.min.js",
      "**/vendor/**",
      // Under app/ we lint only the project's own _prime_silo modules; the
      // vendored upstream space-agent framework (all of it under _core) is not
      // linted. ESLint lints every non-ignored file, so this must be explicit.
      "app/L0/_all/mod/_core/**"
    ]
  },
  {
    // Node-side: server, CLI, tests, root scripts.
    files: ["server/**/*.js", "commands/**/*.js", "tests/**/*.mjs", "*.js", "*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node }
    },
    rules: baseRules
  },
  {
    // Browser-side: the shell's own browser modules + the page scripts it serves.
    // These reference DOM globals; tests get both Node + browser because the
    // browser-component harnesses stub window/document in a Node process.
    files: ["app/L0/_all/mod/_prime_silo/**/*.js", "server/pages/res/**/*.js", "tests/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser }
    },
    rules: baseRules
  }
];
