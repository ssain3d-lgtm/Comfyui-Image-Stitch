// Flat ESLint config for the browser extension and its Node tests.
//
// The web/ files are ES modules ComfyUI serves to the browser; the tests are ES
// modules Node runs against a stubbed ComfyUI, and the stubs stand in for
// ComfyUI's own scripts/. All of them get the same rules: the recommended set
// (which includes no-undef — that is what catches a typo'd global or a helper
// that was never imported) plus the three relaxations below.
import js from "@eslint/js";
import globals from "globals";

export default [
    {
        // Caches and generated output: nothing here is ours to lint.
        ignores: ["node_modules/**", ".tmp/**", "coverage/**", "test-results/**", "playwright-report/**"],
    },
    {
        files: ["web/**/*.js", "tests/web/**/*.mjs", "tests/web/stubs/*.js"],
        ...js.configs.recommended,
        languageOptions: {
            // The files are ES modules: ComfyUI serves web/*.js with import
            // statements, and Node loads the tests as modules.
            ecmaVersion: "latest",
            sourceType: "module",
            globals: {
                // The extension runs in the browser; the tests run in Node and
                // install browser stand-ins (window, document, Image, ...) on
                // globalThis, so both sets apply to both.
                ...globals.browser,
                ...globals.node,
                // LiteGraph puts these on window; the extension only reads them.
                LiteGraph: "readonly",
                LGraphCanvas: "readonly",
            },
        },
        rules: {
            ...js.configs.recommended.rules,
            // An unused trailing argument is part of a callback's signature
            // (ComfyUI hands callbacks more arguments than most of them use),
            // and a caught error is often deliberately ignored.
            "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
            // `catch { /* best effort */ }` is how cleanup is written here.
            "no-empty": ["error", { allowEmptyCatch: true }],
        },
    },
];
