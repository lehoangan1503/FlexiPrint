import next from "eslint-config-next";

/** @type {import("eslint").Linter.Config[]} */
const config = [
  {
    ignores: [
      ".next/**",
      "out/**",
      "build/**",
      "dist/**",
      "node_modules/**",
      "public/**",
      "next-env.d.ts",
    ],
  },
  ...next,
  {
    // eslint-config-next@16 promotes several React-Compiler-era hook rules to
    // errors that the older `next lint` (core-web-vitals) treated leniently.
    // Keep them as warnings so they stay visible without failing the lint run
    // across pre-existing code that predates these checks.
    rules: {
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
    },
  },
];

export default config;
