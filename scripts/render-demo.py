#!/usr/bin/env python3
"""Render illustrative README demos. Requires Pillow; see docs/media/README.md."""
from __future__ import annotations

import argparse
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
W, H, SCALE = 1040, 680, 2
BG = '#F3F5F8'
INK = '#192536'
MUTED = '#66758A'
DARK = '#101A28'
CARD = '#192637'
EDGE = '#2B3B50'
WHITE = '#EDF3FA'
DIM = '#A9B9CC'
TEAL = '#69DFC5'
VIOLET = '#C2ACFF'

COPY = {
    'zh': {
        'demo': '流程示意 · 非运行录像',
        'titles': ['先选一个协作模型', '主模型定方案，再交接任务', '后台继续做，要求随时补充', '拿到结果，再检查改动', '下一件事，接着上次继续'],
        'subs': ['主模型保持不变；协作模型从 Pi 已配置的模型中选择。',
                 '你正常提出需求，主模型决定如何分工。',
                 '主模型可以继续工作；新要求由它转交给协作模型。',
                 '完成通知之后，主模型读取报告、检查代码和验证结果。',
                 '同一个协作模型保留历史，不必每次从头解释。'],
        'steps': ['选模型', '交任务', '后台执行', '检查结果', '继续协作'],
        'lead': '主模型 / LEAD', 'side': '协作模型 / SIDEKICK',
        'lead_lines': [['继续与你沟通', '当前模型不变'], ['明确导出格式', '拆分实现与验证任务'], ['继续检查接口设计', '转交：也处理空列表'], ['读取交接报告', '检查完整 diff 与验证结果'], ['接着已有结果', '安排下一步修改']],
        'side_lines': [['从已配置的模型中选择', 'provider/model-id'], ['接收任务说明', '实现 CSV 导出'], ['执行实现与相关验证', '接收主模型补充的要求'], ['返回修改说明', '附上文件与验证记录'], ['沿用同一个会话', '继续完善导出功能']],
        'lead_status': ['保持当前模型', '确定方案', '主模型仍可工作', '审查后向你汇报', '追加任务'],
        'side_status': ['选择后启用', '开始执行', '后台执行中', '报告已送达', '上下文已保留'],
        'events': ['/fusion', '用户：给报表页增加 CSV 导出', '补充要求：也处理没有数据的情况', '主模型调用 read_sidekick 读取结果', '后续要求：支持自定义导出文件名'],
        'footer': ['选择具体模型后，Fusion 即可开始协作', '主模型与协作模型共享工作区，分别保留对话', '等待超时不等于任务停止', '结果领取时计入用量，重复读取不重复计算', '一个会话，一个持续协作的伙伴'],
        'bottom': '示例任务与模型标识仅用于说明流程',
    },
    'en': {
        'demo': 'ILLUSTRATIVE DEMO',
        'titles': ['Choose your sidekick', 'Plan first. Hand off focused work.', 'Keep working while it runs', 'Read the report. Review the changes.', 'Pick up where you left off'],
        'subs': ['Your lead stays the same. Choose a model already configured in Pi.',
                 'Ask for work as usual. The lead decides what to delegate.',
                 'The lead can work independently and relay new requirements.',
                 'After completion, the lead reads the report and checks the evidence.',
                 'One persistent sidekick keeps its history across handoffs.'],
        'steps': ['Choose', 'Hand off', 'Run', 'Review', 'Continue'],
        'lead': 'LEAD', 'side': 'SIDEKICK',
        'lead_lines': [['Keeps talking with you', 'Current model unchanged'], ['Decides the CSV format', 'Scopes implementation and checks'], ['Reviews the API design', 'Relays: handle empty lists too'], ['Reads the handoff report', 'Reviews the diff and checks'], ['Builds on the last result', 'Plans the next change']],
        'side_lines': [['Pick a configured model', 'provider/model-id'], ['Receives the task brief', 'Implements CSV export'], ['Implements and verifies', 'Receives the lead\'s update'], ['Returns a change summary', 'Includes files and check results'], ['Resumes the same session', 'Extends the export feature']],
        'lead_status': ['Same lead model', 'Planning', 'Lead can keep working', 'Reviews before reporting', 'Follow-up task'],
        'side_status': ['Selection enables Fusion', 'Starting work', 'Running in background', 'Report delivered', 'Context retained'],
        'events': ['/fusion', 'User: Add CSV export to the reports page', 'Update: Handle the empty-list case too', 'Lead calls read_sidekick to retrieve the report', 'Next: Support custom export filenames'],
        'footer': ['Choose a concrete model to start collaborating', 'Shared workspace. Separate conversations.', 'A wait timeout does not stop the running task', 'Usage is claimed once when the report is retrieved', 'One session. One persistent collaborator.'],
        'bottom': 'Illustration, not a recording. Task and model names are examples.',
    },
}


def find_font(explicit: str | None, candidates: list[str]) -> str:
    if explicit:
        if not Path(explicit).is_file():
            raise SystemExit(f'Font does not exist: {explicit}')
        return explicit
    for candidate in candidates:
        if Path(candidate).is_file():
            return candidate
    raise SystemExit('No suitable font found. Pass --font and --mono-font.')


class Renderer:
    def __init__(self, font: str, mono: str):
        self.font_path, self.mono_path = font, mono
        self.fonts: dict[tuple[int, bool], ImageFont.FreeTypeFont] = {}

    def font(self, size: int, mono: bool = False):
        key = (size, mono)
        if key not in self.fonts:
            self.fonts[key] = ImageFont.truetype(self.mono_path if mono else self.font_path, size * SCALE)
        return self.fonts[key]

    def frame(self, lang: str, stage: int, tick: int) -> Image.Image:
        c = COPY[lang]
        im = Image.new('RGB', (W * SCALE, H * SCALE), BG)
        d = ImageDraw.Draw(im)

        def box(rect, color, radius=12, outline=None):
            d.rounded_rectangle(tuple(round(v * SCALE) for v in rect), radius=radius * SCALE,
                                fill=color, outline=outline, width=SCALE)

        def text(x, y, value, size=20, color=WHITE, mono=False):
            d.text((round(x * SCALE), round(y * SCALE)), value, font=self.font(size, mono), fill=color)

        def line(coords, color, width=1):
            d.line(tuple(round(v * SCALE) for v in coords), fill=color, width=width * SCALE)

        def dot(x, y, r, color):
            d.ellipse(((x-r)*SCALE, (y-r)*SCALE, (x+r)*SCALE, (y+r)*SCALE), fill=color)

        text(42, 24, 'PI FUSION', 18, INK, mono=True)
        demo_width = d.textlength(c['demo'], font=self.font(15)) / SCALE
        text(W - 42 - demo_width, 28, c['demo'], 15, MUTED)
        text(40, 66, c['titles'][stage], 35, INK)
        text(42, 121, c['subs'][stage], 20, MUTED)
        box((40, 175, 1000, 578), '#DEE4ED', 18)
        box((40, 169, 1000, 572), DARK, 18)
        for x, color in [(63, '#F47D80'), (82, '#EFCC73'), (101, '#73CDA9')]:
            dot(x, 190, 5, color)
        text(129, 179, 'pi / workspace', 15, DIM, mono=True)
        state = ['ready', 'handoff', 'running', 'completed', 'running'][stage]
        text(787, 179, f'Fusion · {state}', 15, TEAL)
        line((41, 211, 999, 211), EDGE)

        event = c['events'][stage]
        chars = len(event) if stage == 0 else min(len(event), math.ceil(len(event) * (tick + 1) / 6))
        text(65, 224, '> ', 20, TEAL, mono=True)
        text(92, 224, event[:chars], 20, WHITE, mono=stage == 0)
        if stage > 0 and tick < 6:
            tw = d.textlength(event[:chars], font=self.font(20, stage == 0)) / SCALE
            box((95 + tw, 226, 103 + tw, 247), TEAL, 1)

        active_lead = stage in (1, 3, 4)
        active_side = stage in (2, 4)
        for side, x, accent, active in [('lead', 64, TEAL, active_lead), ('side', 576, VIOLET, active_side)]:
            box((x, 269, x + 400, 466), CARD, 12, accent if active else EDGE)
            dot(x + 22, 294, 4, accent)
            text(x + 36, 281, c[side], 18, accent)
            for i, value in enumerate(c[f'{side}_lines'][stage]):
                if stage == 0 or tick >= 2 + i:
                    text(x + 20, 330 + 35 * i, value, 19, WHITE if i == 0 else DIM,
                         mono=(stage == 0 and side == 'side' and i == 1))
            box((x + 16, 417, x + 384, 451), '#22364A', 8)
            status = c[f'{side}_status'][stage]
            text(x + 28, 424, status, 16, accent)

        # Animated message path. The arrow reverses for the report handoff.
        report = stage == 3
        direction_color = VIOLET if report else TEAL
        line((480, 367, 559, 367), EDGE, 2)
        end, start = (480, 559) if report else (559, 480)
        if stage > 0:
            phase = min(1.0, max(0.0, (tick - 3) / 8))
            dot(start + (end - start) * phase, 367, 5, direction_color)
            sign = 1 if report else -1
            line((end + sign * 8, 361, end, 367, end + sign * 8, 373), direction_color, 2)
        else:
            text(495, 350, '+', 29, DIM, mono=True)

        line((64, 488, 976, 488), EDGE)
        text(65, 507, c['footer'][stage], 19, DIM)
        line((65, 552, 975, 552), EDGE, 3)
        fraction = (stage + min(1.0, (tick + 1) / 16)) / 5
        line((65, 552, 65 + 910 * fraction, 552), TEAL, 3)

        for i, label in enumerate(c['steps']):
            x = 58 + i * 196
            color = '#186E64' if i <= stage else MUTED
            dot(x + 12, 609, 12, '#D3EAE3' if i <= stage else '#E2E7EE')
            text(x + 7, 599, str(i + 1), 16, color, mono=True)
            text(x + 32, 597, label, 18, color)
        text(42, 649, c['bottom'], 14, MUTED)
        return im.resize((W, H), Image.Resampling.LANCZOS)

    def render(self, lang: str, destination: Path):
        frames = [self.frame(lang, stage, tick) for stage in range(5) for tick in range(16)]
        # Share a palette across the entire animation, avoiding color flicker.
        atlas = Image.new('RGB', (W, H * 5))
        for stage in range(5):
            atlas.paste(frames[stage * 16 + 15], (0, H * stage))
        palette = atlas.quantize(colors=128, method=Image.Quantize.MEDIANCUT)
        indexed = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in frames]
        durations = [140] * len(indexed)
        for stage in range(5):
            durations[stage * 16 + 15] = 2260
        gif = destination / f'workflow-{lang}.gif'
        indexed[0].save(gif, save_all=True, append_images=indexed[1:], duration=durations,
                        loop=0, optimize=True, disposal=1)
        frames[-1].save(destination / f'workflow-{lang}.png')
        print(f'{gif.relative_to(ROOT) if gif.is_relative_to(ROOT) else gif}: {gif.stat().st_size:,} bytes')
        return frames


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--font', help='Font with Chinese and Latin glyphs (TTF/OTF/TTC)')
    parser.add_argument('--mono-font', help='Monospace font for commands')
    parser.add_argument('--output', type=Path, default=ROOT / 'docs/media')
    parser.add_argument('--contact-sheet', type=Path, help='Optional review image outside the repository')
    args = parser.parse_args()
    font = find_font(args.font, ['/System/Library/Fonts/STHeiti Light.ttc',
                                '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'])
    mono = find_font(args.mono_font, ['/System/Library/Fonts/Menlo.ttc',
                                    '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'])
    args.output.mkdir(parents=True, exist_ok=True)
    renderer = Renderer(font, mono)
    captures = [renderer.render(lang, args.output) for lang in ('zh', 'en')]
    if args.contact_sheet:
        sheet = Image.new('RGB', (W, H * 5 // 2), BG)
        for col, frames in enumerate(captures):
            for stage in range(5):
                tile = frames[stage * 16 + 15].resize((W // 2, H // 2), Image.Resampling.LANCZOS)
                sheet.paste(tile, (col * W // 2, stage * H // 2))
        sheet.save(args.contact_sheet)


if __name__ == '__main__':
    main()
