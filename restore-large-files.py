from pathlib import Path
import json, hashlib
root=Path(__file__).resolve().parent
for item in json.loads((root/'large-file-parts.json').read_text()):
    data=b''.join((root/p).read_bytes() for p in item['parts'])
    assert len(data)==item['size'] and hashlib.sha256(data).hexdigest()==item['sha256'], item['path']
    target=root/item['path']; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
    print('Restored', item['path'])
print('All large model files restored and SHA256 verified.')
