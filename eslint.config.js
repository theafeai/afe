import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".claude/**", "**/dist/**", "**/node_modules/**", "**/coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
      // docs/security/rules.md: never disable TLS verification; configure a CA instead.
      "no-restricted-syntax": [
        "error",
        {
          selector: "Property[key.name='rejectUnauthorized'][value.value=false]",
          message:
            "Do not disable TLS verification; pass a custom CA (see docs/security/rules.md).",
        },
        {
          selector: "Literal[value='NODE_TLS_REJECT_UNAUTHORIZED']",
          message:
            "Do not disable TLS verification; pass a custom CA (see docs/security/rules.md).",
        },
        {
          selector: "MemberExpression[property.name='NODE_TLS_REJECT_UNAUTHORIZED']",
          message:
            "Do not disable TLS verification; pass a custom CA (see docs/security/rules.md).",
        },
      ],
    },
  },
);
