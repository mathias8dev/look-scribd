import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "server-dist/**", ".next/**", "node_modules/**", "data/**", "downloads/**"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [...tseslint.configs.recommended, reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["server/**/*.ts", "vite.config.ts"],
    extends: [...tseslint.configs.recommended],
    languageOptions: { globals: globals.node },
  },
);
