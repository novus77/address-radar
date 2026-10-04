"""Explicitly approved, bounded SQLite backup and reverse-index maintenance."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import time


TABLE = "canonical_trader_event_observations"
INDEX = "idx_canonical_trader_event_observations_observation_id"
CREATE_SQL = f'CREATE INDEX "{INDEX}" ON "{TABLE}" ("observation_id", "canonical_event_id")'
SOURCE = Path("/var/lib/address-radar/address-radar.db")
BACKUP_ROOT = Path("/var/backups/address-radar/index-maintenance")
SERVICES = tuple(f"address-radar-{name}.service" for name in (
    "scanner", "automation", "wallet-monitor", "wallet-analysis", "historical-backfill", "console"
))


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def connect(path, mode, lock_wait_ms=250):
    connection = sqlite3.connect(Path(path).resolve().as_uri() + f"?mode={mode}", uri=True,
                                 isolation_level=None, timeout=lock_wait_ms / 1000)
    connection.execute(f"PRAGMA busy_timeout={int(lock_wait_ms)}")
    connection.execute("PRAGMA trusted_schema=OFF")
    if mode == "ro":
        connection.execute("PRAGMA query_only=ON")
    else:
        connection.execute("PRAGMA foreign_keys=ON")
    return connection


def rows(connection, query):
    return [list(row) for row in connection.execute(query)]


def metadata(connection):
    indexes = []
    for row in connection.execute(f'PRAGMA index_list("{TABLE}")'):
        name = row[1]
        quoted = name.replace('"', '""')
        definition = connection.execute("SELECT sql FROM sqlite_schema WHERE name=?", (name,)).fetchone()
        indexes.append({"name": name, "unique": row[2], "origin": row[3], "partial": row[4],
                        "columns": rows(connection, f'PRAGMA index_xinfo("{quoted}")'),
                        "sql": definition[0] if definition else None})
    definition = connection.execute("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?", (TABLE,)).fetchone()
    collision = connection.execute("SELECT type,tbl_name,sql FROM sqlite_schema WHERE name=?", (INDEX,)).fetchall()
    return {"tableSql": definition[0] if definition else None,
            "columns": rows(connection, f'PRAGMA table_info("{TABLE}")'),
            "foreignKeys": rows(connection, f'PRAGMA foreign_key_list("{TABLE}")'),
            "indexes": sorted(indexes, key=lambda item: item["name"]),
            "collision": [list(row) for row in collision]}


def reviewed_shape(value):
    columns = value["columns"]
    if [(row[1], row[2].upper(), row[3], row[4], row[5]) for row in columns] != [
        ("canonical_event_id", "TEXT", 1, None, 1), ("observation_id", "TEXT", 1, None, 2)
    ]:
        raise RuntimeError("unreviewed_link_table_shape")
    references = {(row[2], row[3], row[4]) for row in value["foreignKeys"]}
    if references != {("canonical_trader_events", "canonical_event_id", "canonical_event_id"),
                      ("raw_trader_observations", "observation_id", "observation_id")}:
        raise RuntimeError("unreviewed_link_table_references")
    primary = [item for item in value["indexes"] if item["origin"] == "pk"]
    if len(primary) != 1 or [(row[2], row[3], row[4]) for row in primary[0]["columns"] if row[5]] != [
        ("canonical_event_id", 0, "BINARY"), ("observation_id", 0, "BINARY")
    ]:
        raise RuntimeError("unreviewed_link_primary_key")
    if value["collision"]:
        raise RuntimeError("existing_reverse_index_ownership")


def check_deadline(deadline, reason):
    if time.monotonic() >= deadline:
        raise RuntimeError(reason)


def prepare_backup(source_path, backup_path, *, deadline_seconds=120, minimum_free_bytes=3 * 1024**3):
    backup_path = Path(backup_path)
    if backup_path.exists():
        raise FileExistsError(backup_path)
    source = connect(source_path, "ro")
    target = None
    deadline = time.monotonic() + deadline_seconds
    try:
        source.execute("BEGIN")
        before = metadata(source)
        reviewed_shape(before)
        logical_bytes = source.execute("PRAGMA page_count").fetchone()[0] * source.execute("PRAGMA page_size").fetchone()[0]
        if shutil.disk_usage(backup_path.parent).free < 2 * logical_bytes + minimum_free_bytes:
            raise RuntimeError("backup_disk_headroom_insufficient")
        descriptor = os.open(backup_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(descriptor)
        target = sqlite3.connect(backup_path, isolation_level=None)

        def progress(_status, _remaining, _total):
            check_deadline(deadline, "backup_deadline_exceeded")
            if shutil.disk_usage(backup_path.parent).free < minimum_free_bytes:
                raise RuntimeError("backup_disk_headroom_insufficient")

        source.backup(target, pages=1024, progress=progress, sleep=0.025)
        source.execute("ROLLBACK")
        source.close()
        source = None
        target.execute("PRAGMA journal_mode=DELETE")
        target.close()
        target = None
        validation = connect(backup_path, "ro")
        validation_deadline = time.monotonic() + 60
        validation.set_progress_handler(lambda: int(time.monotonic() >= validation_deadline), 1000)
        try:
            if [row[0] for row in validation.execute("PRAGMA quick_check")] != ["ok"]:
                raise RuntimeError("backup_quick_check_failed")
            if metadata(validation) != before:
                raise RuntimeError("backup_metadata_mismatch")
        finally:
            validation.close()
        digest = hashlib.sha256()
        hashing_deadline = time.monotonic() + 30
        with backup_path.open("rb") as stream:
            while True:
                block = stream.read(1024 * 1024)
                if not block:
                    break
                check_deadline(hashing_deadline, "backup_hash_deadline_exceeded")
                digest.update(block)
            os.fsync(stream.fileno())
        return {"backupPath": str(backup_path), "backupSha256": digest.hexdigest(),
                "backupBytes": backup_path.stat().st_size, "quickCheck": "ok",
                "sourceMetadata": before, "sourceLogicalBytes": logical_bytes}
    finally:
        if target is not None:
            target.close()
        if source is not None:
            source.close()


def link_content(connection, deadline):
    digest = hashlib.sha256(b"reviewed-link-content-v1\n")
    count = 0
    for row in connection.execute(f'SELECT canonical_event_id,observation_id FROM "{TABLE}" '
                                  'ORDER BY canonical_event_id,observation_id'):
        check_deadline(deadline, "index_transaction_deadline_exceeded")
        payload = encoded(list(row))
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)
        count += 1
    return count, digest.hexdigest()


def apply_index(source_path, expected_metadata, record_precommit, *, transaction_seconds=5, lock_wait_ms=250):
    connection = connect(source_path, "rw", lock_wait_ms)
    started = time.monotonic()
    deadline = started + transaction_seconds
    connection.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
    try:
        connection.execute("BEGIN IMMEDIATE")
        current = metadata(connection)
        if current != expected_metadata:
            raise RuntimeError("source_metadata_changed")
        reviewed_shape(current)
        before = link_content(connection, deadline)
        connection.execute(CREATE_SQL)
        owned = next(item for item in metadata(connection)["indexes"] if item["name"] == INDEX)
        if owned["unique"] or owned["partial"] or owned["sql"] != CREATE_SQL or [
            (row[2], row[3], row[4]) for row in owned["columns"] if row[5]
        ] != [("observation_id", 0, "BINARY"), ("canonical_event_id", 0, "BINARY")]:
            raise RuntimeError("created_index_definition_mismatch")
        after = link_content(connection, deadline)
        if before != after:
            raise RuntimeError("link_content_changed")
        plan = [row[3] for row in connection.execute(
            f'EXPLAIN QUERY PLAN SELECT canonical_event_id FROM "{TABLE}" WHERE observation_id=?', ("",))]
        search = any("SEARCH " in detail and INDEX in detail for detail in plan) and not any("SCAN " in detail for detail in plan)
        if not search:
            raise RuntimeError("reverse_lookup_still_unindexed")
        result = {"indexCreated": True, "ownedIndexDefinition": owned, "linkRows": before[0],
                  "linkContentFingerprint": before[1], "linkContentUnchanged": True,
                  "lookupUsesSearch": search}
        record_precommit(result)
        check_deadline(deadline, "index_transaction_deadline_exceeded")
        connection.execute("COMMIT")
        return {**result, "transactionMilliseconds": round((time.monotonic() - started) * 1000)}
    finally:
        connection.set_progress_handler(None, 0)
        if connection.in_transaction:
            connection.execute("ROLLBACK")
        connection.close()


def service_guards():
    guards = {}
    for unit in SERVICES:
        result = subprocess.run(["systemctl", "show", unit, "-p", "ActiveState", "-p", "NRestarts", "-p", "MainPID"],
                                check=True, capture_output=True, text=True, timeout=5)
        values = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
        if values.get("ActiveState") != "active" or int(values.get("MainPID", "0")) <= 0:
            raise RuntimeError("business_service_not_active")
        environment = Path(f'/proc/{values["MainPID"]}/environ').read_bytes().split(b"\0")
        flags = [item for item in environment if item.startswith(b"ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=")]
        if flags != [b"ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false"]:
            raise RuntimeError("gateway_delivery_guard_failed")
        guards[unit] = values
    return {"services": guards, "release": os.path.realpath("/opt/address-radar/current"),
            "gatewayDeliveryEnabled": False}


def durable_journal(path, record):
    temporary = path.with_suffix(".pending")
    descriptor = os.open(temporary, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(encoded(record) + b"\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--operation-id", required=True)
    parser.add_argument("--code-sha256", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"purchase-reverse-index-[a-z0-9-]{8,64}", args.operation_id) or not re.fullmatch(r"[a-f0-9]{64}", args.code_sha256):
        raise RuntimeError("invalid_maintenance_identity")
    os.umask(0o077)
    initial_guards = service_guards()
    source_stat = SOURCE.stat()
    identity = {"device": source_stat.st_dev, "inode": source_stat.st_ino}
    directory = BACKUP_ROOT / args.operation_id
    BACKUP_ROOT.mkdir(parents=True, mode=0o700, exist_ok=True)
    directory.mkdir(mode=0o700)
    journal_path = directory / "maintenance.json"
    record = {"operationId": args.operation_id, "codeSha256": args.code_sha256,
              "approvedScope": "consistent_backup_nonunique_reverse_index_readonly_revalidation",
              "source": str(SOURCE), "sourceIdentity": identity, "initialGuards": initial_guards,
              "phase": "backup_started", "startedAtMs": round(time.time() * 1000)}

    def save(phase, **details):
        record.update(details)
        record.update(phase=phase, updatedAtMs=round(time.time() * 1000))
        durable_journal(journal_path, record)
        print(json.dumps({"operationId": args.operation_id, "phase": phase}), flush=True)

    committed = False
    try:
        save("backup_started")
        backup = prepare_backup(SOURCE, directory / "address-radar.db")
        save("backup_verified", backup=backup)
        current_stat = SOURCE.stat()
        if {"device": current_stat.st_dev, "inode": current_stat.st_ino} != identity or service_guards() != initial_guards:
            raise RuntimeError("production_guards_changed_before_index")
        if shutil.disk_usage(SOURCE.parent).free < backup["sourceLogicalBytes"] + 3 * 1024**3:
            raise RuntimeError("index_disk_headroom_insufficient")
        result = apply_index(SOURCE, backup["sourceMetadata"], lambda prepared: save("index_prepared", index=prepared))
        committed = True
        save("index_committed", index=result)
        final_guards = service_guards()
        if final_guards != initial_guards:
            raise RuntimeError("production_guards_changed_after_index")
        save("maintenance_verified", finalGuards=final_guards,
             diskAvailableBytes=shutil.disk_usage(SOURCE.parent).free)
        print(json.dumps({"operationId": args.operation_id, "backupPath": backup["backupPath"],
                          "backupBytes": backup["backupBytes"], "backupSha256": backup["backupSha256"],
                          "quickCheck": backup["quickCheck"], "index": result,
                          "gatewayDeliveryEnabled": False, "release": final_guards["release"],
                          "diskAvailableBytes": record["diskAvailableBytes"], "formalMigrationExecuted": False}), flush=True)
    except Exception as error:
        reason = str(error) if re.fullmatch(r"[a-z_]+", str(error)) else type(error).__name__
        save("committed_needs_review" if committed else "failed_requires_readonly_reconciliation",
             errorReason=reason, sqliteErrorCode=getattr(error, "sqlite_errorcode", None))
        raise RuntimeError(reason) from None


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        reason = str(error) if re.fullmatch(r"[a-z_]+", str(error)) else type(error).__name__
        print(json.dumps({"error": reason}), file=sys.stderr)
        sys.exit(1)
