#!/usr/bin/env python3
"""Download a GitHub-verified CI artifact, never trust files from the runner."""
import hashlib, json, os, pathlib, re, sys, tempfile, urllib.request, zipfile

revision, run_id, destination = sys.argv[1:]
if not re.fullmatch('[0-9a-f]{40}', revision) or not re.fullmatch('[0-9]{1,20}', run_id):
    raise SystemExit('Invalid revision or workflow run')
repository = pathlib.Path('/etc/mprovifilesharing/github-repository').read_text().strip()
if not re.fullmatch('[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
    raise SystemExit('Invalid root-owned repository configuration')
token = sys.stdin.read(4097).strip()
if not re.fullmatch('[A-Za-z0-9_.-]{20,4096}', token):
    raise SystemExit('GitHub Actions read token required on stdin')
base = 'https://api.github.com/repos/' + repository
headers = {'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'mprovi-deployer'}
def api(path):
    with urllib.request.urlopen(urllib.request.Request(base + path, headers=headers), timeout=30) as response:
        data = response.read(1048577)
        if len(data) > 1048576:
            raise SystemExit('GitHub metadata exceeds limit')
        return json.loads(data)
run = api('/actions/runs/' + run_id)
if (run.get('head_sha') != revision or run.get('head_branch') != 'main'
        or run.get('event') not in ('push', 'workflow_dispatch')
        or run.get('path') != '.github/workflows/ci.yml'
        or run.get('head_repository', {}).get('full_name') != repository):
    raise SystemExit('Only trusted main CI runs can deploy')
if api('/git/ref/heads/main')['object']['sha'] != revision:
    raise SystemExit('Revision is no longer the head of main')
jobs = api('/actions/runs/' + run_id + '/jobs?filter=latest&per_page=100')['jobs']
if not any(job['name'] == 'validate' and job['status'] == 'completed' and job['conclusion'] == 'success' for job in jobs):
    raise SystemExit('Validation job has not succeeded')
artifacts = api('/actions/runs/' + run_id + '/artifacts?per_page=100')['artifacts']
matches = [a for a in artifacts if a['name'] == 'release-' + revision and not a['expired']]
if len(matches) != 1 or not re.fullmatch('sha256:[0-9a-f]{64}', matches[0].get('digest', '')):
    raise SystemExit('Unique immutable artifact with GitHub digest required')
artifact = matches[0]
# The API redirects to a short-lived signed blob URL. Do not forward the API
# credential to the blob host; verify the downloaded bytes against GitHub's digest.
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, hdrs, newurl):
        return None
opener = urllib.request.build_opener(NoRedirect)
try:
    response = opener.open(urllib.request.Request(base + '/actions/artifacts/' + str(artifact['id']) + '/zip', headers=headers), timeout=30)
except urllib.error.HTTPError as error:
    if error.code != 302:
        raise
    location = error.headers.get('Location', '')
    if not location.startswith('https://'):
        raise SystemExit('HTTPS artifact storage required')
    response = urllib.request.urlopen(location, timeout=30)
with response, tempfile.TemporaryFile() as archive:
    digest = hashlib.sha256(); total = 0
    while chunk := response.read(1048576):
        total += len(chunk)
        if total > 134217728:
            raise SystemExit('Artifact too large')
        digest.update(chunk); archive.write(chunk)
    if 'sha256:' + digest.hexdigest() != artifact['digest']:
        raise SystemExit('GitHub artifact digest mismatch')
    archive.seek(0)
    with zipfile.ZipFile(archive) as bundle:
        allowed = {'application.tar.gz', 'application.sha256'}
        if set(bundle.namelist()) != allowed or len(bundle.namelist()) != 2:
            raise SystemExit('Unexpected artifact files')
        for entry in bundle.infolist():
            if entry.file_size > 134217728:
                raise SystemExit('Artifact entry exceeds limit')
            with open(pathlib.Path(destination) / entry.filename, 'xb') as output, bundle.open(entry) as source:
                while chunk := source.read(1048576):
                    output.write(chunk)
print('Provenance GitHub et livraison vérifiées.')
