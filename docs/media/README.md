# README demos

`workflow-zh.gif` and `workflow-en.gif` illustrate the documented lead/sidekick workflow. They are diagrams styled like a terminal, not recordings of a real Pi session. Model identifiers and task text are examples; the animation does not claim measured timings or test results.

Each animation loops through five steps in about 22 seconds: choose a model, hand off a task, run in the background, review the report, and continue in the same session. Matching PNG files provide a static alternative.

## Regenerate

From the repository root:

```bash
python3 -m venv /tmp/pi-fusion-demo-venv
/tmp/pi-fusion-demo-venv/bin/python -m pip install Pillow==12.3.0
/tmp/pi-fusion-demo-venv/bin/python scripts/render-demo.py
```

The renderer uses STHeiti and Menlo on macOS, or Noto Sans CJK and DejaVu Sans Mono at the standard Linux paths. To use fonts installed elsewhere:

```bash
/tmp/pi-fusion-demo-venv/bin/python scripts/render-demo.py \
  --font /path/to/chinese-font.ttc \
  --mono-font /path/to/monospace.ttf
```

`--contact-sheet /tmp/pi-fusion-demo-contact.png` also writes a review image showing all five steps in both languages. Only the resulting images are required to read the READMEs; Pillow is a documentation development dependency.
