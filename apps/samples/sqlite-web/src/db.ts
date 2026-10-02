import { DatabaseSync } from "node:sqlite";

// 방명록 데이터는 SQLite 파일 하나에 둔다. 저장소에 커밋된 data/guestbook.db 에 첫 글 몇 개가 들어 있다.
const DB_PATH = "data/guestbook.db";

export type Entry = {
  id: number;
  name: string;
  message: string;
  created_at: string;
};

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )
`);

/** 화면에 보여 주는 저장소 이름 */
export function storageName(): string {
  return "SQLite";
}

export function listEntries(limit = 50): Entry[] {
  return db
    .prepare("SELECT id, name, message, created_at FROM entries ORDER BY id DESC LIMIT ?")
    .all(limit) as Entry[];
}

export function addEntry(name: string, message: string): Entry {
  return db
    .prepare("INSERT INTO entries (name, message) VALUES (?, ?) RETURNING id, name, message, created_at")
    .get(name, message) as Entry;
}

export function countEntries(): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM entries").get() as { count: number };
  return Number(row.count);
}

/** 헬스체크용 — DB 에 실제로 질의가 되는지 확인한다 */
export function ping(): boolean {
  db.prepare("SELECT 1").get();
  return true;
}
