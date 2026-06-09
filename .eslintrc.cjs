module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  rules: {
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
  },
  overrides: [
    {
      files: ['src/**/*.{ts,tsx}'],
      excludedFiles: [
        'src/lib/cors-fetch.ts',
        'src/lib/web-platform.ts',
        'src/lib/media-source.ts',
        'src/app/api/**/*.ts',
      ],
      rules: {
        'no-restricted-globals': [
          'error',
          {
            name: 'fetch',
            message: '业务代码禁止直接 fetch，请使用 @/lib/cors-fetch 的 corsFetch；媒体读取请使用 @/lib/media-source。',
          },
        ],
      },
    },
  ],
}
