#!/usr/bin/env bash
# sqlite-cli.sh — Run SQLite queries using the sqlite3 CLI or a Python fallback.

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: sqlite-cli.sh <database> <sql>" >&2
  exit 1
fi

DB_PATH="$1"
SQL="$2"

if command -v sqlite3 &>/dev/null; then
  exec sqlite3 "${DB_PATH}" <<< "${SQL}"
fi

if ! command -v python3 &>/dev/null; then
  echo "sqlite-cli.sh: neither sqlite3 nor python3 is available" >&2
  exit 1
fi

python3 - "${DB_PATH}" "${SQL}" <<'PY'
import sqlite3
import sys

db_path, sql = sys.argv[1], sys.argv[2]
conn = sqlite3.connect(db_path)
try:
    stripped = sql.lstrip().upper()
    if stripped.startswith("SELECT") or stripped.startswith("PRAGMA"):
        cursor = conn.execute(sql)
        if cursor.description:
            for row in cursor.fetchall():
                print(row[0])
    else:
        conn.executescript(sql)
        conn.commit()
except sqlite3.Error as exc:
    print(str(exc), file=sys.stderr)
    sys.exit(1)
finally:
    conn.close()
PY
