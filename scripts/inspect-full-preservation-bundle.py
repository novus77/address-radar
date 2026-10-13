#!/usr/bin/env python3
"""Read-only, pinned size inventory. Never parse historical rows or connect to PostgreSQL."""
import argparse
import hashlib
import json
import os
import re
import stat
from pathlib import Path

MANIFEST_SHA256 = "d73b0c6f794c649058072cd07ea2af6989193f5e8c705456e9d82d0e25e7350c"
SNAPSHOT_SHA256 = "d73d27350f0785ac3938024f7d56c77b5c4b404a236b75dc6ff1cb726a0e91b7"
CATALOG_SHA256 = "6f8776bbba041c4cd91cb0d622f0d169286857371099198ea0123d3bc439edf5"


def strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_json_key")
        result[key] = value
    return result


def inventory(root):
    root = Path(root)
    if not root.is_absolute() or os.path.realpath(root) != str(root):
        raise ValueError("canonical_root_required")
    candidates = [root / "manifest.json", root / "bundle" / "manifest.json"]
    present = [path for path in candidates if path.exists() or path.is_symlink()]
    if len(present) != 1:
        raise ValueError("exact_bundle_location_required")
    manifest_path = present[0]
    if os.path.realpath(manifest_path.parent) != str(manifest_path.parent):
        raise ValueError("symlink_bundle")
    fd = os.open(manifest_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size != 545010:
            raise ValueError("manifest_size_or_kind")
        if before.st_uid != 0 or before.st_mode & 0o077:
            raise ValueError("manifest_owner_or_permissions")
        body = bytearray()
        while len(body) <= 545010:
            block = os.read(fd, min(65536, 545011 - len(body)))
            if not block:
                break
            body.extend(block)
        after = os.fstat(fd)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError("manifest_changed")
    finally:
        os.close(fd)
    if len(body) != 545010 or hashlib.sha256(body).hexdigest() != MANIFEST_SHA256:
        raise ValueError("manifest_pin")
    manifest = json.loads(body, object_pairs_hook=strict_object)
    if manifest["completed"] is not True or manifest["version"] != 1 or manifest["snapshotSha256"] != SNAPSHOT_SHA256 or manifest["snapshotBytes"] != 3837816832 or manifest["catalogFingerprint"] != CATALOG_SHA256:
        raise ValueError("source_lineage")
    tables = manifest["tables"]
    plans = [chunk for table in tables for chunk in table["chunks"]]
    if len(tables) != 141 or sum(table["rowCount"] for table in tables) != 6023033 or len(plans) != 1548:
        raise ValueError("source_accounting")
    files = set()
    sizes = []
    for chunk in plans:
        filename = chunk["file"]
        if not isinstance(filename, str) or not re.fullmatch(r"table-[0-9]{4}-chunk-[0-9]{6}\.json", filename) or filename in files:
            raise ValueError("source_path")
        files.add(filename)
        info = os.lstat(manifest_path.parent / filename)
        if not stat.S_ISREG(info.st_mode) or info.st_size <= 0 or info.st_size > 16 * 1024**2:
            raise ValueError("chunk_kind_or_limit")
        if info.st_uid != 0 or info.st_mode & 0o077:
            raise ValueError("chunk_owner_or_permissions")
        sizes.append({"file": filename, "bytes": info.st_size, "sha256": chunk["sha256"]})
    total = sum(item["bytes"] for item in sizes)
    result = {"version": 1, "bundleDirectory": str(manifest_path.parent), "manifestSha256": MANIFEST_SHA256,
              "snapshotSha256": SNAPSHOT_SHA256, "catalogFingerprint": CATALOG_SHA256,
              "tables": len(tables), "rows": 6023033, "chunks": len(plans), "chunkBytes": total,
              "exportBytes": total + len(body), "maximumChunkBytes": max(item["bytes"] for item in sizes),
              "chunksOverTwoMiB": sum(item["bytes"] > 2 * 1024**2 for item in sizes),
              "largestChunks": sorted(sizes, key=lambda item: item["bytes"], reverse=True)[:8],
              "chunkDigestsChecked": False, "rootOwnedPrivateFiles": len(plans) + 1,
              "sourceWrites": False, "databaseConnections": 0}
    encoded = json.dumps(result, sort_keys=True, separators=(",", ":")).encode()
    result["inventorySha256"] = hashlib.sha256(encoded).hexdigest()
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    args = parser.parse_args()
    print(json.dumps(inventory(args.root), sort_keys=True, separators=(",", ":")))
