/** Recognized JavaScript and TypeScript source suffixes, independent of module resolution. */
export const JS_TS_SOURCE_LANGUAGES: Readonly<Record<string, 'typescript' | 'tsx' | 'javascript' | 'jsx'>> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
}
export const JS_TS_SOURCE_EXTENSIONS = Object.keys(JS_TS_SOURCE_LANGUAGES)
export const TYPESCRIPT_SOURCE_EXTENSIONS = JS_TS_SOURCE_EXTENSIONS.filter(extension =>
  JS_TS_SOURCE_LANGUAGES[extension] === 'typescript' || JS_TS_SOURCE_LANGUAGES[extension] === 'tsx')
export const JAVASCRIPT_SOURCE_EXTENSIONS = JS_TS_SOURCE_EXTENSIONS.filter(extension =>
  JS_TS_SOURCE_LANGUAGES[extension] === 'javascript' || JS_TS_SOURCE_LANGUAGES[extension] === 'jsx')

/** Implementation candidates only, preserving existing exact-path priority.
 * Module-kind suffixes do not substitute for ordinary JS/TS suffixes.
 * https://www.typescriptlang.org/docs/handbook/modules/reference#file-extension-substitution
 */
export const JS_TS_EXTENSION_SUBSTITUTIONS: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.js', '.ts', '.tsx', '.jsx'],
  '.jsx': ['.jsx', '.tsx'],
  '.mjs': ['.mjs', '.mts'],
  '.cjs': ['.cjs', '.cts'],
  '.ts': ['.ts'],
  '.tsx': ['.tsx'],
  '.mts': ['.mts'],
  '.cts': ['.cts'],
}
export const EXTENSIONLESS_JS_TS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'] as const

/** Source and document suffixes admitted by file discovery. */
export const CODE_EXTENSIONS = new Set([
  '.py',
  ...JS_TS_SOURCE_EXTENSIONS,
  '.go',
  '.rs',
  '.java',
  '.cpp',
  '.cc',
  '.cxx',
  '.c',
  '.h',
  '.hpp',
  '.rb',
  '.swift',
  '.kt',
  '.kts',
  '.cs',
  '.scala',
  '.php',
  '.lua',
  '.toc',
  '.zig',
  '.ps1',
  '.ex',
  '.exs',
  '.m',
  '.mm',
  '.jl',
])
export const DOC_EXTENSIONS = new Set(['.md', '.txt', '.rst'])

export const UNSUPPORTED_SOURCE_EXTENSIONS = new Set([
  '.bash', '.clj', '.cljs', '.dart', '.elm', '.fs', '.fsx', '.groovy', '.hs', '.r', '.sh', '.sol', '.sql', '.svelte', '.vue',
])
