import fs from 'fs';
import path from 'path';

const docsDir = path.join(__dirname, '../docs');
const indexPath = path.join(docsDir, 'README.md');

function listDocs(dir: string, prefix = ''): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return listDocs(path.join(dir, entry.name), `${prefix}${entry.name}/`);
    }
    if (!entry.name.endsWith('.md') || (prefix === '' && entry.name === 'README.md')) {
      return [];
    }
    return [`${prefix}${entry.name}`];
  });
}

describe('docs/README.md index', () => {
  const index = fs.readFileSync(indexPath, 'utf-8');

  it('links every docs/*.md file (excluding README.md)', () => {
    const missing = listDocs(docsDir).filter((doc) => !index.includes(`](${doc})`));

    expect(missing).toEqual([]);
  });
});
