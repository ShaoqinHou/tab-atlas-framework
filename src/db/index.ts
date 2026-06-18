import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export function openDatabase(filePath = path.join(process.cwd(), 'data', 'tabatlas.sqlite')) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  const schemas = [
    new URL('./schema.sql', import.meta.url),
    new URL('./schema-v2-durable.sql', import.meta.url),
  ];
  for (const schemaPath of schemas) {
    db.exec(fs.readFileSync(schemaPath, 'utf8'));
  }
  return db;
}
