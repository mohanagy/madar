import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

function collectReportJsonFiles(rootDir: string): string[] {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectReportJsonFiles(entryPath));
      continue;
    }
    if (entry.isFile() && entry.name === 'report.json') {
      files.push(entryPath);
    }
  }
  return files;
}

function collectHtmlFiles(rootDir: string): string[] {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectHtmlFiles(entryPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.html')) {
      files.push(entryPath);
    }
  }
  return files;
}

function isUnsafeLocalPath(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

describe('benchmark docs artifacts', () => {
  it('do not expose absolute local graph or result paths in committed report.json files', () => {
    const reportsDir = path.join(process.cwd(), 'docs', 'benchmarks');
    const reportFiles = collectReportJsonFiles(reportsDir);

    expect(reportFiles.length).toBeGreaterThan(0);

    for (const reportFile of reportFiles) {
      const report = JSON.parse(fs.readFileSync(reportFile, 'utf8')) as {
        graph_path?: unknown;
        result_path?: unknown;
      };

      expect(
        isUnsafeLocalPath(report.graph_path),
        `${path.relative(process.cwd(), reportFile)} graph_path`,
      ).toBe(false);
      expect(
        isUnsafeLocalPath(report.result_path),
        `${path.relative(process.cwd(), reportFile)} result_path`,
      ).toBe(false);
    }
  });

  it('keeps benchmark pages on the canonical scoped npm package URL', () => {
    const benchmarkDocsDir = path.join(process.cwd(), 'docs', 'benchmarks');
    const htmlFiles = collectHtmlFiles(benchmarkDocsDir);

    expect(htmlFiles.length).toBeGreaterThan(0);

    for (const htmlFile of htmlFiles) {
      const content = fs.readFileSync(htmlFile, 'utf8');
      const relativePath = path.relative(process.cwd(), htmlFile);

      if (!content.includes('npmjs.com/package/')) {
        continue;
      }

      expect(content, `${relativePath} should not link to the unscoped npm package`).not.toContain(
        'https://www.npmjs.com/package/madar',
      );
      expect(content, `${relativePath} should link to the canonical scoped npm package`).toContain(
        'https://www.npmjs.com/package/@lubab/madar',
      );
    }
  });
});
