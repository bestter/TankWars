"""Bounded native bundle transport and logical recovery comparisons."""
import base64
import hashlib
import json
import sqlite3
from pathlib import Path
from model import atomic, require
from multipart import compare_streams, safe


async def collect_bundle(page, output, options):
    root = Path(output)
    root.mkdir(parents=True, exist_ok=True)
    manifest = await page.evaluate("options => window.__tankwarsEnduranceBundle.prepare(options, true)", options)
    require(manifest.get("format") == "tankwars-endurance-bundle" and manifest.get("schemaVersion") == 1, "UNSUPPORTED_BUNDLE_SCHEMA")
    cursor = dict(path="", offset=0)
    try:
        while True:
            files = await page.evaluate("cursor => window.__tankwarsEnduranceBundle.filePage(cursor)", cursor)
            require(isinstance(files, list) and len(files) <= 128, "INVALID_FILE_PAGE")
            if not files:
                break
            total = 0
            for chunk in files:
                name, offset = chunk["path"], chunk["offset"]
                require(name > cursor["path"] or (name == cursor["path"] and offset == cursor["offset"]), "INVALID_FILE_ORDER")
                if name > cursor["path"]:
                    require(offset == 0, "INVALID_FIRST_OFFSET")
                target = safe(root, name)
                target.parent.mkdir(parents=True, exist_ok=True)
                candidate = target.with_suffix(target.suffix + ".candidate")
                data = base64.b64decode(chunk["base64"], validate=True)
                total += len(data)
                require(len(data) == chunk["bytes"] and total <= 1048576, "INVALID_BUNDLE_CHUNK")
                with candidate.open("wb" if offset == 0 else "ab") as stream:
                    require(stream.tell() == offset, "CANDIDATE_OFFSET_MISMATCH")
                    stream.write(data)
                cursor = dict(path=name, offset=offset + len(data))
                if chunk["eof"]:
                    if name == "manifest.json":
                        continue  # Publish the commit marker only after its data dependencies.
                    if target.exists() and name.startswith(("journal/", "captures/", "terrains/", "session/", "catalog/")):
                        require(compare_streams(target, candidate)[0], "IMMUTABLE_PART_CHANGED")
                        candidate.unlink()
                    else:
                        candidate.replace(target)
    finally:
        await page.evaluate("() => window.__tankwarsEnduranceBundle.unlock()")
    candidate = root / "manifest.json.candidate"
    require(json.loads(candidate.read_text(encoding="utf-8")) == manifest, "BUNDLE_GENERATION_CHANGED")
    for ref in bundle_files(root, manifest):
        digest, size = hashlib.sha256(), 0
        with safe(root, ref["path"]).open("rb") as stream:
            while data := stream.read(65536):
                size += len(data)
                digest.update(data)
        require(size == ref["bytes"] and digest.hexdigest() == ref["sha256"], "BUNDLE_FILE_INTEGRITY_FAILED")
    candidate.replace(root / "manifest.json")
    return manifest


def bundle_files(root, manifest=None):
    root = Path(root)
    manifest = manifest if manifest is not None else json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    require(manifest.get("format") == "tankwars-endurance-bundle" and manifest.get("schemaVersion") == 1, "UNSUPPORTED_BUNDLE_SCHEMA")
    # On-disk ordering prevents growing reference arrays or recursion through catalogs.
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA temp_store=FILE")
    # The catalog itself may grow indefinitely: use a temporary on-disk database.
    import tempfile
    with tempfile.TemporaryDirectory(prefix="tankwars-catalog-") as temporary:
        db.close()
        db = sqlite3.connect(str(Path(temporary) / "catalog.sqlite"))
        try:
            db.execute("CREATE TABLE files (path TEXT PRIMARY KEY, value TEXT)")
            db.execute("CREATE TABLE pages (path TEXT PRIMARY KEY)")
            page = manifest["catalogue"]
            expected_hash = manifest["catalogueSha256"]
            while page:
                db.execute("INSERT INTO pages VALUES (?)", (page,))
                raw = safe(root, page).read_bytes()  # one bounded metadata page
                require(hashlib.sha256(raw).hexdigest() == expected_hash, "CATALOGUE_INTEGRITY_FAILED")
                data = json.loads(raw)
                require(len(data["files"]) <= 256, "INVALID_CATALOGUE_PAGE")
                for ref in data["files"]:
                    safe(root, ref["path"])
                    db.execute("INSERT INTO files VALUES (?,?)", (ref["path"], json.dumps(ref)))
                page = data["next"]
                expected_hash = data["nextSha256"]
            for row in db.execute("SELECT value FROM files ORDER BY path"):
                yield json.loads(row[0])
        finally:
            db.close()


def logical_stream(root, kind):
    root = Path(root)
    directory = kind.replace("/", "-") + "-stream"
    (root / directory).mkdir(exist_ok=True)
    refs, pages, total, digest = [], 0, 0, hashlib.sha256()
    for ref in bundle_files(root):
        if not ref["path"].startswith(kind + "/"):
            continue
        refs.append(ref)
        with safe(root, ref["path"]).open("rb") as stream:
            while chunk := stream.read(65536):
                digest.update(chunk)
                total += len(chunk)
        if len(refs) == 256:
            pages += 1
            atomic(root / directory / f"catalog-{pages:06d}.json", json.dumps(dict(files=refs)) + "\n")
            refs = []
    if refs:
        pages += 1
        atomic(root / directory / f"catalog-{pages:06d}.json", json.dumps(dict(files=refs)) + "\n")
    path = root / directory / "checkpoint-000001.stream.json"
    atomic(path, json.dumps(dict(format="tankwars-byte-stream", schemaVersion=1, directory=directory,
        pages=pages, bytes=total, sha256=digest.hexdigest())) + "\n")
    return path


def compare_bundles(a, b):
    a, b = Path(a), Path(b)
    left = json.loads((a / "manifest.json").read_text(encoding="utf-8"))
    right = json.loads((b / "manifest.json").read_text(encoding="utf-8"))
    require(left["session"] == right["session"] and left["journal"] == right["journal"], "RECOVERED_METADATA_MISMATCH")
    for kind in ("journal", "captures", "terrains"):
        equal, detail = compare_streams(logical_stream(a, kind), logical_stream(b, kind))
        require(equal, "RECOVERED_" + kind.upper() + ": " + detail)
    # Collection revisions may be physically partitioned differently. Compare latest
    # native records by identity on disk; journal bytes above are never normalized.
    import tempfile
    with tempfile.TemporaryDirectory(prefix="tankwars-compare-") as directory:
        db = sqlite3.connect(str(Path(directory) / "records.sqlite"))
        try:
            db.execute("CREATE TABLE records (side INTEGER, kind TEXT, id TEXT, value TEXT, PRIMARY KEY(side,kind,id))")
            for side, root in enumerate((a, b)):
                for ref in bundle_files(root):
                    kind = ref["path"].split("/")
                    if len(kind) < 3 or kind[0] != "session" or kind[1] == "metadata":
                        continue
                    with safe(root, ref["path"]).open(encoding="utf-8") as stream:
                        for line in stream:
                            value = json.loads(line)["record"]
                            key = value.get("id", str(value.get("blockId")) + "/" + str(value.get("number")))
                            db.execute("INSERT OR REPLACE INTO records VALUES (?,?,?,?)", (side, kind[1], key, json.dumps(value, sort_keys=True)))
            missing = db.execute("SELECT kind,id,value FROM records WHERE side=0 EXCEPT SELECT kind,id,value FROM records WHERE side=1").fetchone()
            extra = db.execute("SELECT kind,id,value FROM records WHERE side=1 EXCEPT SELECT kind,id,value FROM records WHERE side=0").fetchone()
            require(missing is None and extra is None, "RECOVERED_COLLECTIONS_MISMATCH")
        finally:
            db.close()


def proof_files(root):
    root = Path(root)
    return [root / "manifest.json", *(logical_stream(root, kind) for kind in
        ("journal", "captures", "terrains", "session/blocks", "session/rounds", "session/incidents", "session/metadata"))]
