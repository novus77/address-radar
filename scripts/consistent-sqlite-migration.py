#!/usr/bin/env python3
"""Consistent snapshots and lossless, non-activating migration rehearsals."""

import argparse
import base64
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import time
import uuid


def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def check(deadline):
    require(time.monotonic() < deadline, "migration_deadline_exceeded")


def regular(path):
    require(not path.is_symlink() and path.is_file(), "migration_artifact_not_regular_file")
    return path.stat()


def identity(path):
    s = regular(path)
    return (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns)


def hash_file(path, deadline):
    before = identity(path)
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while True:
            check(deadline)
            block = stream.read(1024 * 1024)
            if not block:
                break
            digest.update(block)
    require(identity(path) == before, "migration_artifact_changed_during_read")
    return digest.hexdigest()


def private_file(path, body):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(body)
        stream.flush()
        os.fsync(stream.fileno())


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def save_manifest(root, manifest):
    target = root / "manifest.json"
    require(not target.is_symlink(), "migration_manifest_symlink")
    temporary = root / (".manifest-" + uuid.uuid4().hex + ".tmp")
    private_file(temporary, encoded(manifest))
    os.replace(temporary, target)
    sync_directory(root)


def headroom(path, required_bytes, reserve):
    require(shutil.disk_usage(path).free >= required_bytes + reserve, "migration_disk_headroom_insufficient")


def source_connection(path, deadline):
    path = path.resolve(strict=True)
    regular(path)
    c = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=0.1, isolation_level=None)
    c.execute("PRAGMA query_only=ON")
    c.execute("PRAGMA busy_timeout=100")
    c.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
    return c


def snapshot(source, target, operation_id, deadline, reserve, pages_per_step=256, sleep_ms=25):
    source = source.resolve(strict=True)
    regular(source)
    require(source != target.resolve(), "migration_source_target_collision")
    require(target.parent.is_dir(), "migration_destination_parent_missing")
    require(not target.exists() and not target.is_symlink(), "migration_destination_exists")
    c = source_connection(source, deadline)
    destination = None
    try:
        c.execute("BEGIN")
        logical_bytes = c.execute("PRAGMA page_size").fetchone()[0] * c.execute("PRAGMA page_count").fetchone()[0]
        headroom(target.parent, logical_bytes, reserve)
        private_file(target, b"")
        destination = sqlite3.connect(str(target), isolation_level=None)
        destination.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
        def progress(status, remaining, total):
            check(deadline)
            if remaining > 0 and sleep_ms:
                time.sleep(sleep_ms / 1000)
            check(deadline)
        c.backup(destination, pages=pages_per_step, progress=progress, sleep=0.05)
        c.execute("ROLLBACK")
        # Release the source snapshot before the potentially long destination check.
        c.close()
        c = None
        destination.execute("PRAGMA journal_mode=DELETE")
        result = destination.execute("PRAGMA quick_check").fetchone()[0]
        require(result == "ok", "migration_backup_integrity_failed")
        destination.close()
        destination = None
        with target.open("rb") as stream:
            os.fsync(stream.fileno())
        digest = hash_file(target, deadline)
        sync_directory(target.parent)
        return {"version": 1, "operationId": operation_id, "backupPath": str(target),
                "backupBytes": target.stat().st_size, "backupSha256": digest, "quickCheck": "ok",
                "sourceWrites": False, "sourceCheckpointPerformed": False, "businessActivation": False}
    finally:
        if c is not None:
            c.close()
        if destination is not None:
            destination.close()


def catalog(c):
    objects = [{"type": r[0], "name": r[1], "tbl_name": r[2], "sql": r[3]} for r in c.execute(
        "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")]
    tables = []
    for obj in objects:
        if obj["type"] != "table":
            continue
        require(not re.search(r"CREATE\s+VIRTUAL\s+TABLE", obj["sql"] or "", re.I), "migration_virtual_table_requires_review")
        name = obj["name"]
        columns = [list(row) for row in c.execute("PRAGMA table_xinfo(" + quote(name) + ")")]
        require(0 < len(columns) <= 1000, "migration_column_limit")
        groups = {}
        for row in c.execute("PRAGMA foreign_key_list(" + quote(name) + ")"):
            group = groups.setdefault(row[0], {"id": row[0], "table": row[2], "onUpdate": row[5],
                                             "onDelete": row[6], "match": row[7], "columns": []})
            group["columns"].append({"sequence": row[1], "from": row[3], "to": row[4]})
        indexes = []
        for row in c.execute("PRAGMA index_list(" + quote(name) + ")").fetchall():
            sql = c.execute("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?", (row[1],)).fetchone()
            indexes.append({"name": row[1], "unique": bool(row[2]), "origin": row[3], "partial": bool(row[4]),
                            "sql": sql[0] if sql else None,
                            "columns": [list(part) for part in c.execute("PRAGMA index_xinfo(" + quote(row[1]) + ")")]})
        tables.append({"name": name, "columns": columns, "foreignKeys": sorted(groups.values(), key=lambda g: g["id"]),
                       "indexes": sorted(indexes, key=lambda i: i["name"])})
    require(0 < len(tables) <= 1000, "migration_table_limit")
    sequences = []
    if c.execute("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").fetchone():
        for name, seq in c.execute("SELECT name,seq FROM sqlite_sequence ORDER BY name"):
            require(isinstance(seq, int) and seq >= 0, "migration_sequence_requires_review")
            sequences.append({"name": name, "seq": str(seq)})
    return {"objects": objects, "tables": sorted(tables, key=lambda t: t["name"]), "sequences": sequences,
            "pragmas": {k: c.execute("PRAGMA " + k).fetchone()[0] for k in ("user_version", "application_id", "encoding")}}


def storage_value(kind, value):
    if kind == "null":
        return {"storage": "null"}
    if kind == "integer":
        return {"storage": kind, "value": str(value)}
    if kind == "real":
        return {"storage": kind, "value": float(value).hex()}
    require(kind in ("text", "blob") and isinstance(value, bytes), "migration_storage_type_unsupported")
    result = {"storage": kind, "value": base64.b64encode(value).decode("ascii")}
    if kind == "text":
        result["encoding"] = "base64"
    return result


def row_stream(c, shape):
    expressions = []
    for column in shape["columns"]:
        q = quote(column[1])
        expressions.extend(["typeof(" + q + ")", "CASE WHEN typeof(" + q + ") IN ('text','blob') THEN CAST(" + q + " AS BLOB) ELSE " + q + " END"])
    primary = sorted([col for col in shape["columns"] if col[5]], key=lambda col: col[5])
    names = {col[1].lower() for col in shape["columns"]}
    rowid = next((candidate for candidate in ("rowid", "_rowid_", "oid") if candidate not in names), None)
    table_sql = c.execute("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?", (shape["name"],)).fetchone()[0]
    without_rowid = bool(re.search(r"WITHOUT\s+ROWID", table_sql or "", re.I))
    order = [quote(col[1]) for col in primary]
    if not without_rowid and rowid is not None:
        order.append(quote(rowid))
    require(bool(order), "migration_replayable_row_order_missing")
    cursor = c.execute("SELECT " + ",".join(expressions) + " FROM " + quote(shape["name"]) + " ORDER BY " + ",".join(order))
    for row in cursor:
        yield {"values": [storage_value(row[i], row[i + 1]) for i in range(0, len(row), 2)]}


def artifact(root, filename):
    require(isinstance(filename, str) and bool(re.fullmatch(r"table-[0-9]{4}-chunk-[0-9]{6}\.json", filename)), "migration_chunk_path_invalid")
    path = root / filename
    regular(path)
    require(path.resolve().parent == root.resolve(), "migration_chunk_path_escape")
    return path


def load_chunk(root, entry, manifest, deadline):
    path = artifact(root, entry["file"])
    require(path.stat().st_size <= manifest["limits"]["maximumChunkBytes"], "migration_chunk_byte_limit")
    check(deadline)
    raw = path.read_bytes()
    require(hashlib.sha256(raw).hexdigest() == entry["sha256"], "migration_chunk_digest_mismatch")
    body = json.loads(raw)
    for key in ("operationId", "snapshotSha256"):
        require(body.get(key) == manifest[key], "migration_chunk_lineage_mismatch")
    require(body.get("version") == 1 and body.get("table") == entry["table"] and body.get("ordinal") == entry["ordinal"]
            and body.get("startRow") == entry["startRow"] and len(body.get("rows", [])) == entry["rowCount"], "migration_chunk_metadata_mismatch")
    return body


def validate_bundle(root, deadline, completed=True):
    regular(root / "manifest.json")
    require((root / "manifest.json").stat().st_size <= 64 * 1024 * 1024, "migration_manifest_byte_limit")
    manifest = json.loads((root / "manifest.json").read_text())
    require(manifest.get("version") == 1 and (not completed or manifest.get("completed") is True), "migration_manifest_incomplete")
    require(bool(re.fullmatch(r"[0-9a-f]{64}", manifest.get("snapshotSha256", ""))), "migration_snapshot_digest_invalid")
    require(hashlib.sha256(encoded(manifest["catalog"])).hexdigest() == manifest.get("catalogFingerprint"), "migration_catalog_digest_mismatch")
    shapes = manifest["catalog"]["tables"]
    require([t["name"] for t in shapes] == [t["name"] for t in manifest["tables"]]
            and len(set(t["name"] for t in shapes)) == len(shapes), "migration_table_accounting_mismatch")
    for table in manifest["tables"]:
        digest = hashlib.sha256()
        row_count = 0
        for ordinal, entry in enumerate(table["chunks"]):
            require(entry["table"] == table["name"] and entry["ordinal"] == ordinal and entry["startRow"] == row_count
                    and isinstance(entry["rowCount"], int) and entry["rowCount"] > 0, "migration_chunk_sequence_invalid")
            body = load_chunk(root, entry, manifest, deadline)
            for row in body["rows"]:
                digest.update(encoded(row) + b"\n")
            row_count += entry["rowCount"]
        if completed or table.get("completed"):
            require(row_count == table["rowCount"] and digest.hexdigest() == table["contentSha256"], "migration_table_digest_mismatch")
    return manifest


def export(source, root, operation_id, expected_digest, deadline, reserve, chunk_bytes, chunk_rows, resume):
    source = source.resolve(strict=True)
    before = identity(source)
    require(not any(Path(str(source) + suffix).exists() and Path(str(source) + suffix).stat().st_size > 0
                    for suffix in ("-wal", "-journal")), "migration_export_requires_closed_snapshot")
    require(hash_file(source, deadline) == expected_digest, "migration_snapshot_digest_mismatch")
    c = source_connection(source, deadline)
    lock = None
    try:
        require(c.execute("PRAGMA journal_mode").fetchone()[0] != "wal", "migration_export_requires_closed_snapshot")
        c.execute("BEGIN")
        exact = catalog(c)
        fingerprint = hashlib.sha256(encoded(exact)).hexdigest()
        limits = {"maximumChunkBytes": chunk_bytes, "rowsPerChunk": chunk_rows}
        require(root.parent.is_dir() and not root.is_symlink(), "migration_export_parent_invalid")
        if resume:
            require(root.is_dir(), "migration_resume_missing_directory")
        else:
            root.mkdir(mode=0o700)
        require(root.stat().st_mode & 0o077 == 0, "migration_export_directory_not_private")
        fd = os.open(root / ".operation.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        lock = os.fdopen(fd, "rb")
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        if resume:
            manifest = validate_bundle(root, deadline, completed=False)
            require(manifest["operationId"] == operation_id and manifest["snapshotSha256"] == expected_digest
                    and manifest["catalogFingerprint"] == fingerprint and manifest["limits"] == limits, "migration_resume_lineage_mismatch")
            if manifest["completed"]:
                validate_bundle(root, deadline)
                return {"completed": True, "resumed": True, "tables": len(manifest["tables"]), "productionMigrationReady": False}
        else:
            manifest = {"version": 1, "operationId": operation_id, "snapshotSha256": expected_digest,
                        "snapshotBytes": source.stat().st_size, "catalogFingerprint": fingerprint, "catalog": exact,
                        "limits": limits, "completed": False, "businessActivation": False,
                        "tables": [{"name": t["name"], "rowCount": 0, "contentSha256": hashlib.sha256(b"").hexdigest(),
                                    "chunks": [], "completed": False} for t in exact["tables"]]}
            save_manifest(root, manifest)
        for table_number, shape in enumerate(exact["tables"]):
            table = manifest["tables"][table_number]
            digest = hashlib.sha256()
            ordinal, row_count, pending, pending_bytes = 0, 0, [], 0

            def flush():
                nonlocal ordinal, row_count, pending, pending_bytes
                if not pending:
                    return
                check(deadline)
                body = {"version": 1, "operationId": operation_id, "snapshotSha256": expected_digest,
                        "table": shape["name"], "ordinal": ordinal, "startRow": row_count, "rows": pending}
                raw = encoded(body)
                require(len(raw) <= chunk_bytes, "migration_single_row_chunk_limit")
                headroom(root, len(raw), reserve)
                filename = "table-%04d-chunk-%06d.json" % (table_number, ordinal)
                path = root / filename
                checksum = hashlib.sha256(raw).hexdigest()
                entry = {"file": filename, "table": shape["name"], "ordinal": ordinal, "startRow": row_count,
                         "rowCount": len(pending), "sha256": checksum}
                if path.exists() or path.is_symlink():
                    require(resume and hash_file(path, deadline) == checksum, "migration_chunk_collision")
                else:
                    private_file(path, raw)
                if ordinal < len(table["chunks"]):
                    require(table["chunks"][ordinal] == entry, "migration_resume_chunk_mismatch")
                else:
                    table["chunks"].append(entry)
                row_count += len(pending)
                ordinal += 1
                pending, pending_bytes = [], 0
                save_manifest(root, manifest)

            for row in row_stream(c, shape):
                check(deadline)
                raw_row = encoded(row)
                # Reserve bounded header space; never split or drop a source row.
                if pending and (len(pending) >= chunk_rows or pending_bytes + len(raw_row) + 512 > chunk_bytes):
                    flush()
                pending.append(row)
                pending_bytes += len(raw_row) + 1
                digest.update(raw_row + b"\n")
            flush()
            require(len(table["chunks"]) == ordinal, "migration_resume_excess_chunks")
            table.update({"rowCount": row_count, "contentSha256": digest.hexdigest(), "completed": True})
            save_manifest(root, manifest)
        require(identity(source) == before, "migration_snapshot_changed_during_export")
        manifest["completed"] = True
        save_manifest(root, manifest)
        validate_bundle(root, deadline)
        return {"completed": True, "tables": len(manifest["tables"]),
                "rows": sum(t["rowCount"] for t in manifest["tables"]), "catalogFingerprint": fingerprint,
                "snapshotSha256": expected_digest, "productionMigrationReady": False, "businessActivation": False}
    finally:
        c.close()
        if lock is not None:
            lock.close()


def bound_value(cell):
    kind = cell.get("storage")
    if kind == "null":
        require(set(cell) == {"storage"}, "migration_cell_invalid")
        return "?", None
    value = cell.get("value")
    require(isinstance(value, str), "migration_cell_invalid")
    if kind == "integer":
        number = int(value)
        require(str(number) == value and -(2 ** 63) <= number < 2 ** 63, "migration_integer_invalid")
        return "?", number
    if kind == "real":
        number = float.fromhex(value)
        require(not math.isnan(number) and number.hex() == value, "migration_real_invalid")
        return "?", number
    require(kind in ("text", "blob"), "migration_cell_storage_invalid")
    raw = base64.b64decode(value, validate=True)
    require(base64.b64encode(raw).decode("ascii") == value, "migration_base64_invalid")
    if kind == "text":
        require(cell.get("encoding") == "base64", "migration_text_encoding_invalid")
    return "CAST(? AS TEXT)" if kind == "text" else "?", raw


def restore(root, target, deadline, reserve):
    require(root.is_dir() and not root.is_symlink(), "migration_bundle_directory_invalid")
    manifest = validate_bundle(root, deadline)
    require(not target.exists() and not target.is_symlink(), "migration_destination_exists")
    require(target.parent.is_dir() and target.resolve().parent != root.resolve(), "migration_restore_destination_invalid")
    headroom(target.parent, manifest["snapshotBytes"], reserve)
    private_file(target, b"")
    c = sqlite3.connect(str(target), isolation_level=None)
    c.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
    try:
        encoding = manifest["catalog"]["pragmas"]["encoding"]
        require(encoding in ("UTF-8", "UTF-16le", "UTF-16be"), "migration_database_encoding_invalid")
        c.execute("PRAGMA encoding=" + quote(encoding))
        c.execute("PRAGMA foreign_keys=OFF")
        c.execute("BEGIN IMMEDIATE")
        for obj in manifest["catalog"]["objects"]:
            if obj["type"] == "table":
                check(deadline)
                require(isinstance(obj["sql"], str) and bool(re.match(r"CREATE\s+TABLE\b", obj["sql"], re.I)), "migration_restore_table_ddl_invalid")
                c.execute(obj["sql"])
        for shape, table in zip(manifest["catalog"]["tables"], manifest["tables"]):
            indexes = [i for i, col in enumerate(shape["columns"]) if col[6] == 0]
            names = ",".join(quote(shape["columns"][i][1]) for i in indexes)
            for entry in table["chunks"]:
                body = load_chunk(root, entry, manifest, deadline)
                for row in body["rows"]:
                    check(deadline)
                    require(len(row["values"]) == len(shape["columns"]), "migration_row_width_invalid")
                    cells = [bound_value(row["values"][i]) for i in indexes]
                    c.execute("INSERT INTO " + quote(shape["name"]) + " (" + names + ") VALUES ("
                              + ",".join(pair[0] for pair in cells) + ")", [pair[1] for pair in cells])
        for seq in manifest["catalog"]["sequences"]:
            c.execute("DELETE FROM sqlite_sequence WHERE name=?", (seq["name"],))
            c.execute("INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)", (seq["name"], int(seq["seq"])))
        for obj in manifest["catalog"]["objects"]:
            if obj["type"] in ("index", "view", "trigger") and obj["sql"] is not None:
                require(bool(re.match(r"CREATE\s+(?:UNIQUE\s+)?" + obj["type"] + r"\b", obj["sql"], re.I)), "migration_restore_ddl_invalid")
                c.execute(obj["sql"])
        for pragma in ("user_version", "application_id"):
            value = manifest["catalog"]["pragmas"][pragma]
            require(isinstance(value, int), "migration_pragma_invalid")
            c.execute("PRAGMA " + pragma + "=" + str(value))
        c.execute("COMMIT")
        require(c.execute("PRAGMA quick_check").fetchone()[0] == "ok", "migration_restored_integrity_failed")
        require(hashlib.sha256(encoded(catalog(c))).hexdigest() == manifest["catalogFingerprint"], "migration_restored_catalog_mismatch")
        for shape, table in zip(manifest["catalog"]["tables"], manifest["tables"]):
            digest, count = hashlib.sha256(), 0
            for row in row_stream(c, shape):
                check(deadline)
                digest.update(encoded(row) + b"\n")
                count += 1
            require(count == table["rowCount"] and digest.hexdigest() == table["contentSha256"], "migration_restored_row_parity_failed")
        fk = c.execute("PRAGMA foreign_key_check").fetchmany(101)
        with target.open("rb") as stream:
            os.fsync(stream.fileno())
        sync_directory(target.parent)
        return {"version": 1, "operationId": manifest["operationId"], "preservationVerified": True,
                "tablesVerified": len(manifest["tables"]), "foreignKeyViolationCountBounded": len(fk),
                "foreignKeyCheckTruncated": len(fk) > 100, "businessActivation": False, "gatewayDelivery": False,
                "productionMigrationReady": False, "snapshotSha256": manifest["snapshotSha256"]}
    finally:
        if c.in_transaction:
            c.execute("ROLLBACK")
        c.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("snapshot", "export", "restore"):
        p = sub.add_parser(name)
        p.add_argument("--source", required=True, type=Path)
        p.add_argument("--target", required=True, type=Path)
        p.add_argument("--deadline-seconds", required=True, type=float)
        p.add_argument("--minimum-free-bytes", required=True, type=int)
        if name != "restore":
            p.add_argument("--operation-id", required=True)
        if name == "export":
            p.add_argument("--source-sha256", required=True)
            p.add_argument("--maximum-chunk-bytes", required=True, type=int)
            p.add_argument("--rows-per-chunk", required=True, type=int)
            p.add_argument("--resume", action="store_true")
        if name == "snapshot":
            p.add_argument("--pages-per-step", type=int, default=256)
            p.add_argument("--sleep-ms", type=int, default=25)
    args = parser.parse_args()
    require(math.isfinite(args.deadline_seconds) and 0 < args.deadline_seconds <= 86400
            and args.minimum_free_bytes >= 0, "migration_resource_limits_invalid")
    if args.command != "restore":
        require(bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", args.operation_id)), "migration_operation_id_invalid")
    deadline = time.monotonic() + args.deadline_seconds
    if args.command == "snapshot":
        require(0 < args.pages_per_step <= 4096 and 0 <= args.sleep_ms <= 1000, "migration_backup_limits_invalid")
        result = snapshot(args.source, args.target, args.operation_id, deadline, args.minimum_free_bytes,
                          args.pages_per_step, args.sleep_ms)
    elif args.command == "export":
        require(bool(re.fullmatch(r"[0-9a-f]{64}", args.source_sha256)) and 1024 <= args.maximum_chunk_bytes <= 16 * 1024 * 1024
                and 0 < args.rows_per_chunk <= 4096, "migration_export_limits_invalid")
        result = export(args.source, args.target, args.operation_id, args.source_sha256, deadline,
                        args.minimum_free_bytes, args.maximum_chunk_bytes, args.rows_per_chunk, args.resume)
    else:
        result = restore(args.source, args.target, deadline, args.minimum_free_bytes)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        reason = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print(json.dumps({"status": "failed", "reason": reason, "businessActivation": False}), file=sys.stderr)
        sys.exit(1)
