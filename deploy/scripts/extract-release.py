#!/usr/bin/env python3
"""Root-owned archive validator. Never executes content from the runner."""
import hashlib, json, os, pathlib, re, sys, tarfile

source, destination, revision = map(str, sys.argv[1:])
if not re.fullmatch(r'[0-9a-f]{40}', revision):
    raise SystemExit('Invalid revision')
base = pathlib.Path(source)
if base.is_symlink() or base.resolve() != base.absolute():
    raise SystemExit('Invalid source directory')
# Copy opened bytes into a root-owned temporary file before validation: the
# runner may modify its inbox concurrently, never the extracted root content.
archive = base / 'application.tar.gz'
fd = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW)
with os.fdopen(fd, 'rb') as stream:
    import tempfile
    with tempfile.TemporaryFile() as immutable:
        digest = hashlib.sha256()
        while chunk := stream.read(1048576):
            digest.update(chunk); immutable.write(chunk)
        expected = (base / 'application.sha256').read_text().split()[0]
        if digest.hexdigest() != expected:
            raise SystemExit('Archive checksum mismatch')
        immutable.seek(0)
        with tarfile.open(fileobj=immutable, mode='r:gz') as bundle:
            members = bundle.getmembers()
            allowed = {'apps', 'packages', 'moodle', 'docs', 'package.json', 'package-lock.json', 'release.json'}
            total = 0
            for member in members:
                path = pathlib.PurePosixPath(member.name)
                if path.is_absolute() or '..' in path.parts or (path.parts and path.parts[0] not in allowed):
                    raise SystemExit('Unsafe archive path')
                if not (member.isdir() or member.isfile()) or member.mode & 0o7000:
                    raise SystemExit('Unsafe archive member')
                total += member.size
                if total > 268435456 or len(members) > 10000:
                    raise SystemExit('Archive exceeds limits')
            manifest = json.load(bundle.extractfile('./release.json'))
            if manifest.get('revision') != revision or manifest.get('schema') != 1:
                raise SystemExit('Unexpected release manifest')
            bundle.extractall(destination, members=members, filter='data')
