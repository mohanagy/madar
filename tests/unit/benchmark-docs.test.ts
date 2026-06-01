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

describe('benchmark docs artifacts', () => {
  it('do not expose local graph or result paths in committed report.json files', () => {
    const reportsDir = path.join(process.cwd(), 'docs', 'benchmarks');
    const reportFiles = collectReportJsonFiles(reportsDir);

    expect(reportFiles.length).toBeGreaterThan(0);

    for (const reportFile of reportFiles) {
      const report = JSON.parse(fs.readFileSync(reportFile, 'utf8')) as {
        graph_path?: unknown;
        result_path?: unknown;
      };

      expect(report.graph_path, `${path.relative(process.cwd(), reportFile)} graph_path`).toBeUndefined();
      expect(report.result_path, `${path.relative(process.cwd(), reportFile)} result_path`).toBeUndefined();
    }
  });
});
