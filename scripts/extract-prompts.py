#!/usr/bin/env python3
"""Extract only identified Fusion text spans; preserve bytes, offsets and provenance."""
import argparse
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('binary', type=Path)
parser.add_argument('--out', type=Path, default=Path(__file__).resolve().parents[1] / 'resources/devin-original')
args = parser.parse_args()
binary = args.binary.resolve()
data = binary.read_bytes()
args.out.mkdir(parents=True, exist_ok=True)
records = []

def span(name, start, end, occurrence=0, include_end=True):
    needle = start.encode()
    pos = -1
    for _ in range(occurrence + 1):
        pos = data.index(needle, pos + 1)
    stop = data.index(end.encode(), pos) + (len(end.encode()) if include_end else 0)
    save(name, pos, stop)
    return pos, stop

def save(name, pos, stop):
    raw = data[pos:stop]
    raw.decode('utf-8')  # Fail instead of silently corrupting original punctuation.
    (args.out / name).write_bytes(raw)
    records.append({'file': name, 'offset': pos, 'length': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})

lead_start, lead_end = span('lead.template.md', '## Sidekick\n', 'Agreement on the symptom (a restatement of what happened) is never evidence for a particular mechanism.')
side_start, side_end = span('sidekick.template.md', 'You are the Sidekick subagent of Devin', 'Working around it command by command is always the wrong choice.')
span('lead-variants.txt', '{SIDEKICK_TOOL}{READ_TOOL}{LEAD_IDENTITY}DevinInvestigations', 'This is your first handoff from the lead.', include_end=False)
span('sidekick-variants.txt', '{VISUAL_VERIFICATION}Task management:', '{FILE_TOOL_PREFERENCE}')
span('visual-verification.txt', 'Visual verification: the browser tools are slow', 'call out prominently only checks that surfaced problems.')
span('first-handoff.txt', 'This is your first handoff from the lead.', 'anything you need from the lead.')
span('lead-update-prefix.txt', 'The lead sent an update for the handoff you are working on.', '<lead_update>\n')
update_end = data.index(b'</lead_update>', data.index(b'The lead sent an update for the handoff you are working on.'))
save('lead-update-suffix.txt', update_end, update_end + len(b'</lead_update>'))
for i in range(2):
    span(f'first-edit-{i+1}.txt', 'You made a direct edit yourself instead of delegating to Sidekick.', '</system_guidance>', i, False)
    span(f'first-message-{i+1}.template.md', 'The sidekick is available for delegating mechanical work, including', '</system_guidance>', i, False)
span('grounding-note.txt', 'Because of sidekick delegation, you may be asked about low-level details', '</system_note>', include_end=False)
span('report-first.txt', 'The message above arrived while your sidekick is parked in a wait loop', '</system_guidance>', include_end=False)

# Rust's formatted tool description has two literals separated by four non-text bytes.
# Keep the literals separately; the Pi adapter inserts read_sidekick between them.
pos = data.index(b'Hand off work to your persistent Devin sidekick')
head_end = data.index(b'wait for it with `', pos) + len(b'wait for it with `')
tail_start = data.index(b'` (`block: true`) rather than polling', head_end)
tail_end = data.index(b'The sidekick executes lead-authored artifacts and reports results; it never composes them.', tail_start) + len(b'The sidekick executes lead-authored artifacts and reports results; it never composes them.')
save('tool-description-prefix.txt', pos, head_end)
save('tool-description-suffix.txt', tail_start, tail_end)
manifest = {'binary': f'<local-devin-install>/{binary.parent.parent.name}/bin/{binary.name}', 'binary_sha256': hashlib.sha256(data).hexdigest(),
            'version_directory': binary.parent.parent.name,
            'method': 'UTF-8 literal spans from local executable; not source-code recovery or proof of active conditional branches',
            'tool_description_gap': {'offset': head_end, 'length': tail_start-head_end, 'hex': data[head_end:tail_start].hex()},
            'spans': records}
(args.out / 'manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False)+'\n')
print(json.dumps({'output': str(args.out), 'version': manifest['version_directory'], 'files': len(records)}, ensure_ascii=False))
