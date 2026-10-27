"""Run the tests that need a database, on a throwaway Postgres. No Docker needed.

    .venv/bin/python tools/test_db.py           # the SQL tests (tests/db/*.test.sql)
    .venv/bin/python tools/test_db.py --deno    # then every Deno test, the database ones included

It starts the Postgres that the pgserver package ships, on a free local port,
loads tests/db/stub_supabase.sql (the few Supabase pieces the migrations use)
and tests/db/before_migrations.sql (a login that already exists), applies
supabase/migrations in order, runs each test file, then deletes it all.
Each test file runs in one transaction and rolls back, so they can't affect
each other. Setup: ACCOUNTS.md, "Tests".
"""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def postgres_bin() -> Path:
    try:
        import pgserver
    except ImportError:
        sys.exit("pgserver isn't installed: see ACCOUNTS.md, \"Tests\".")
    return Path(pgserver.__file__).parent / "pginstall" / "bin"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main() -> int:
    run_deno = "--deno" in sys.argv[1:]
    bin_dir = postgres_bin()
    tmp = Path(tempfile.mkdtemp(prefix="first-in-pg-"))
    data = tmp / "data"
    port = free_port()
    quiet = {"stdout": subprocess.DEVNULL, "stderr": subprocess.STDOUT}
    subprocess.run([bin_dir / "initdb", "-D", data, "-U", "postgres", "-A", "trust", "-E", "UTF8",
                    "--no-locale"], check=True, **quiet)
    subprocess.run([bin_dir / "pg_ctl", "-D", data, "-l", tmp / "postgres.log", "-w", "-o",
                    f"-p {port} -k {tmp} -c listen_addresses=127.0.0.1 -c fsync=off", "start"],
                   check=True, **quiet)
    url = f"postgresql://postgres@127.0.0.1:{port}/postgres"
    psql = [str(bin_dir / "psql"), url, "-X", "-q", "-v", "ON_ERROR_STOP=1"]
    failed = 0
    try:
        setup = [ROOT / "tests/db/stub_supabase.sql", ROOT / "tests/db/before_migrations.sql",
                 *sorted((ROOT / "supabase/migrations").glob("*.sql"))]
        for path in setup:
            result = subprocess.run([*psql, "-f", str(path)], capture_output=True, text=True)
            if result.returncode != 0:
                print(f"SETUP FAILED: {path.relative_to(ROOT)}\n{result.stderr}")
                return 1
        for path in sorted((ROOT / "tests/db").glob("*.test.sql")):
            result = subprocess.run([*psql, "-f", str(path)], capture_output=True, text=True)
            name = path.relative_to(ROOT)
            if result.returncode == 0 and "ERROR" not in result.stderr:
                print(f"PASS {name}")
            else:
                failed += 1
                print(f"FAIL {name}\n{result.stderr.strip()}")
        if run_deno and not failed:
            deno = shutil.which("deno") or str(Path.home() / ".local/bin/deno")
            result = subprocess.run([deno, "test", "--allow-env", "--allow-net", "--allow-read",
                                     "supabase/functions/tests/", "tests/app/"],
                                    cwd=ROOT, env={**os.environ, "TEST_DATABASE_URL": url})
            failed += result.returncode != 0
    finally:
        subprocess.run([bin_dir / "pg_ctl", "-D", data, "-m", "immediate", "stop"], **quiet)
        shutil.rmtree(tmp, ignore_errors=True)
    print(("All tests passed." if run_deno else "All database tests passed.") if not failed else f"{failed} failed.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
