import { extname } from 'node:path'
import ts from 'typescript'

/** TypeScript uses slash-separated filenames even on Windows. Never use this
 * spelling as a replacement for filesystem or source-authority identity. */
export function sourceCompilerPath(path: string): string {
  return path.replaceAll('\\', '/')
}

/** Adapt only an already selected source set; this host cannot discover files. */
export function createSourceCompilerHost(
  files: ReadonlyMap<string, ts.SourceFile>, currentDirectory: string,
  resolveModule?: (specifier: string, nativeImporter: string) => string | undefined,
): { host: ts.CompilerHost; rootNames: string[]; nativePath: (source: ts.SourceFile) => string } | undefined {
  const sources = new Map<string, ts.SourceFile>()
  const nativePaths = new Map<string, string>()
  const sourcePaths = new Map<ts.SourceFile, string>()
  for (const [path, source] of files) {
    const key = sourceCompilerPath(path)
    // Distinct filesystem spellings cannot silently become one compiler owner.
    if (nativePaths.has(key) || sourcePaths.has(source) || source.fileName !== key) return undefined
    sources.set(key, source); nativePaths.set(key, path); sourcePaths.set(source, path)
  }
  const host: ts.CompilerHost = {
    getSourceFile: path => sources.get(sourceCompilerPath(path)),
    getDefaultLibFileName: () => '', writeFile: () => {},
    getCurrentDirectory: () => sourceCompilerPath(currentDirectory), getDirectories: () => [],
    fileExists: path => sources.has(sourceCompilerPath(path)),
    readFile: path => sources.get(sourceCompilerPath(path))?.text,
    getCanonicalFileName: sourceCompilerPath, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
    ...(resolveModule ? { resolveModuleNames: (names: string[], containingFile: string) => names.map(name => {
      const importer = nativePaths.get(sourceCompilerPath(containingFile))
      if (importer === undefined) return undefined
      const target = resolveModule(name, importer)
      if (target === undefined || nativePaths.get(sourceCompilerPath(target)) !== target) return undefined
      return { resolvedFileName: sourceCompilerPath(target), extension: extname(target) as ts.Extension }
    }) } : {}),
  }
  return { host, rootNames: [...sources.keys()], nativePath: source => {
    const path = sourcePaths.get(source)
    if (path === undefined) throw new Error('Source file is outside the bounded compiler host')
    return path
  } }
}
