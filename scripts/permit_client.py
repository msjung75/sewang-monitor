"""Shared CI source reader; the credential stays in the process environment."""
import json
import subprocess
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

def collect_permits(**query):
    result = subprocess.run(['node', str(ROOT / 'scripts/collect-permits.mjs'), urllib.parse.urlencode(query)], capture_output=True, text=True, timeout=300)
    if result.returncode:
        raise RuntimeError('Government collection failed; previous snapshot preserved')
    data = json.loads(result.stdout)
    if not isinstance(data.get('items'), list) or data.get('capped') or data.get('error'):
        raise RuntimeError('Incomplete government collection')
    return data

def read_complete_regions(directory, regions):
    """Validate every region before touching an existing output file."""
    items = {}
    for region in regions:
        try:
            data = json.loads((Path(directory) / (region + '.json')).read_text())
        except (OSError, ValueError):
            raise RuntimeError('Incomplete region: ' + region + '; previous snapshot preserved') from None
        if not isinstance(data.get('items'), list) or data.get('error') or data.get('capped') or data.get('count') != len(data['items']):
            raise RuntimeError('Incomplete region: ' + region)
        for row in data['items']:
            if not isinstance(row, dict) or not row.get('id'):
                raise RuntimeError('Invalid row in region: ' + region)
            items[row['id']] = row
    return list(items.values())
