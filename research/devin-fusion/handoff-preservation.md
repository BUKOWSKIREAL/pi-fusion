# Handoff preservation: additional static findings

Target: Devin CLI `3000.11.3`, SHA-256 `7ef3859e68d4eabc0115e51898fcd4eab1edde753c27a472349ef551180b38ff` (the build pinned in `engineering-evidence.json`). This note records static instruction/data evidence, not observed execution or recovered source.

## Recognition and carry-forward

`HandoffHistoryHandler::extract` occupies `0x100682244`–`0x100683698` (exclusive end from LC_FUNCTION_STARTS). Four direct calls to `ChatMessage::get_extension` establish metadata lookups:

| Call instruction | Data address | Byte length | Exact key |
| --- | --- | --- | --- |
| `0x1006822d8` | `0x10612361b` | 24 | `subagent/handoff_history` |
| `0x1006824f4` | `0x106122bd0` | 16 | `subagent/handoff` |
| `0x10068250c` | `0x106120bd9` | 20 | `local_fusion/handoff` |
| `0x100682524` | `0x106120bed` | 27 | `devin-rs/user_communication` |

The last path then looks up the six-byte key `source` at `0x106120497` and compares a four-byte string against `lead` at `0x106120c08` (`0x100682530`–`0x100682584`). The existing history path references the 22-byte name `HandoffHistoryMetadata` at `0x106123088` before collecting records. The output also references `subagent/handoff_history` (`0x100682e80`). These are concrete reasons to preserve provenance and carry-forward metadata, rather than recognize a handoff by finding matching text in tool output.

There is an additional candidate-message path at `0x100682640`–`0x1006826dc`: it checks a message discriminator and another field, retains one text candidate, then emits that candidate when the next handoff arrives or the loop ends. The full message enum/field layout has not been independently established, so this note does not claim that every assistant message, or only final reports, is preserved.

## Bounded retention

The backwards retention scan at `0x100682728`–`0x10068276c` initializes a counter to `0x9c40` (40,000), loads a length-sized field from 32-byte records, subtracts it with saturation, and branches into the truncation path. At least the newest record is treated specially by comparing the current index with the original count. This is evidence of a bounded retention mechanism, not a tokenizer-derived context threshold.

Exact log fragments referenced by this function include:

- `Summarize: preserving ` and ` handoff message(s) verbatim across compaction`
- `Summarize: truncated handoff history from `, ` messages (` and ` dropped)`

The initial Pi adapter preserves delivered user/lead text before the kept boundary and rejects compaction when the resulting context estimate cannot fit. That is an explicit local adaptation. It does **not** reproduce the original 40,000-unit retention scan, original message metadata schema, or the unresolved extra-message selection path. Copying this constant into Pi as a token threshold would be incorrect.

## Sidekick inheritance gate

The future returned by `SidekickInheritable::inherit_for_subagent` uses a poll entry at `0x1014ad3ac` (vtable method at `0x109e85d80 + 24`). Instructions `0x1014ad3d0`–`0x1014ad3f8` require an eight-byte identifier equal to `sidekick`. The function then reads the same activation object layout used by `LocalFusionSession::activation`, under a shared lock, and only with a non-null activation clones a shared object into a runtime field at offset `0x150` (`0x1014ad470`–`0x1014ad4bc`).

This establishes a sidekick-specific, activation-dependent inheritance step. The exact type of the destination runtime field remains unresolved. A generic drop-function symbol at an identical machine address is insufficient evidence of that type because compiler/linker code sharing can merge implementations.

## Reproduction

Use the matching local binary with `objdump -d --start-address=0x100682244 --stop-address=0x100683698 <binary>` (or the corresponding bounded ranges above). Literal virtual addresses map to file offsets by subtracting `0x100000000` for the inspected image regions. Read exact lengths from the table; adjacent Rust string literals are not necessarily NUL-separated. Recovered names originate in the orphan export trie and are not ordinary `nm` output.
