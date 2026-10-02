#!/usr/bin/env python3
"""Find a release note and render a compact, text-accurate WeChat poster."""

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


VERSION_RE = re.compile(r"^release-notes/v(\d+)\.(\d+)\.(\d+)\.md$")
LOGIN_RE = re.compile(r"(?<![A-Za-z0-9._%+-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)")
RELEASE_HEADING_RE = re.compile(r"(?m)^#\s+Claude Code Haha v\d+\.\d+\.\d+\s*$")
CLOSING_PUNCTUATION = set("，。、；：！？）》」』】〕”’％")
OPENING_PUNCTUATION = set("（《「『【〔“‘")


def git(repo, *args):
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        check=False,
    )


def release_candidates(repo):
    notes = repo / "release-notes"
    candidates = []
    if notes.is_dir():
        for path in notes.glob("v*.md"):
            relative = path.relative_to(repo).as_posix()
            match = VERSION_RE.fullmatch(relative)
            if match:
                candidates.append((tuple(map(int, match.groups())), 4, "working-tree", relative))

    for rank, ref in ((3, "HEAD"), (2, "main"), (1, "origin/main")):
        result = git(repo, "ls-tree", "-r", "--name-only", ref, "--", "release-notes")
        if result.returncode:
            continue
        for relative in result.stdout.splitlines():
            match = VERSION_RE.fullmatch(relative)
            if match:
                candidates.append((tuple(map(int, match.groups())), rank, ref, relative))
    return candidates


def chinese_release_section(markdown):
    headings = list(RELEASE_HEADING_RE.finditer(markdown))
    if len(headings) >= 2:
        sections = [
            markdown[heading.start():(headings[index + 1].start() if index + 1 < len(headings) else len(markdown))]
            for index, heading in enumerate(headings)
        ]
    else:
        sections = [markdown]
    # Older releases put English first and Chinese in <details>; others invert
    # that order or repeat the H1 without <details>.
    candidates = []
    for section in sections:
        candidates.extend(re.split(r"(?i)<details(?:\s[^>]*)?>", section))
    selected = max(candidates, key=lambda part: len(re.findall(r"[\u4e00-\u9fff]", part)))
    if len(re.findall(r"[\u4e00-\u9fff]", selected)) < 10:
        raise ValueError("发布说明里未找到足够的中文正文，请人工核对语言版本")
    return re.sub(r"(?is)</?details[^>]*>|<summary[^>]*>.*?</summary>", "", selected).strip() + "\n"


def is_explicit_credit(line, login):
    escaped = re.escape(login)
    if re.search(rf"\*\*@{escaped}\*\*", line, re.IGNORECASE):
        return True
    return bool(re.search(rf"(?:感谢|致谢|代码贡献者|贡献者)[^\n@]{{0,70}}@{escaped}\b", line, re.IGNORECASE))


def wrap_lines(value, width, measure):
    result, current = [], ""
    # Latin model names and IDs stay together; CJK wraps character by character.
    tokens = re.findall(r"[A-Za-z0-9][A-Za-z0-9._/+:-]*|.", str(value), flags=re.DOTALL)
    for token in tokens:
        if token == "\n":
            result.append(current)
            current = ""
            continue
        trial = current + token
        if current and measure(trial) > width:
            if token in CLOSING_PUNCTUATION:
                tail_match = re.search(r"(?:[A-Za-z0-9._/+:-]+|.)$", current)
                tail = tail_match.group(0) if tail_match else ""
                prefix = current[:-len(tail)].rstrip() if tail else ""
                if prefix:
                    result.append(prefix)
                    current = tail + token
                else:
                    current = trial
            elif current[-1] in OPENING_PUNCTUATION and len(current) > 1:
                result.append(current[:-1].rstrip())
                current = current[-1] + token
            else:
                result.append(current.rstrip())
                current = token.lstrip()
        else:
            current = trial
    result.append(current)
    return result


def scan(repo, requested_version=None):
    candidates = release_candidates(repo)
    if requested_version:
        requested = requested_version.removeprefix("v")
        if not re.fullmatch(r"\d+\.\d+\.\d+", requested):
            raise ValueError(f"无效版本号：{requested_version}")
        target = tuple(map(int, requested.split(".")))
        candidates = [candidate for candidate in candidates if candidate[0] == target]
    if not candidates:
        label = requested_version or "最新版本"
        raise ValueError(f"未找到 {label} 的 release-notes Markdown")
    version, _, source, relative = max(candidates)
    if source == "working-tree":
        markdown = (repo / relative).read_text(encoding="utf-8")
    else:
        result = git(repo, "show", f"{source}:{relative}")
        if result.returncode:
            raise ValueError(f"无法从 {source} 读取 {relative}: {result.stderr.strip()}")
        markdown = result.stdout

    chinese = chinese_release_section(markdown)
    mentions = {}
    for line in chinese.splitlines():
        for match in LOGIN_RE.finditer(line):
            login = match.group(1)
            key = login.lower()
            entry = mentions.setdefault(key, {"login": login, "lines": [], "credit_candidate": False})
            if line not in entry["lines"]:
                entry["lines"].append(line.strip())
            if is_explicit_credit(line, login):
                entry["credit_candidate"] = True

    return {
        "version": ".".join(map(str, version)),
        "source": source,
        "path": relative,
        "sha256": hashlib.sha256(chinese.encode("utf-8")).hexdigest(),
        "chinese_markdown": chinese,
        "mentions": list(mentions.values()),
    }


def font_paths(bold):
    mac = "/System/Library/Fonts/STHeiti Medium.ttc" if bold else "/System/Library/Fonts/STHeiti Light.ttc"
    linux = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc" if bold else "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
    windows = "C:/Windows/Fonts/msyhbd.ttc" if bold else "C:/Windows/Fonts/msyh.ttc"
    return [mac, linux, windows, "/System/Library/Fonts/Hiragino Sans GB.ttc"]


def choose_font_path(bold):
    for candidate in font_paths(bold):
        if Path(candidate).is_file():
            return candidate
    raise RuntimeError("缺少可用的中文系统字体；请提供宋体、黑体或 Noto CJK 字体")


def check_spec(spec, scan_data, allow_offline_avatars=False):
    if not isinstance(spec, dict):
        raise ValueError("poster spec 必须是 JSON 对象")
    if spec.get("version") != scan_data.get("version"):
        raise ValueError("poster spec 的 version 与最新 release note 不一致")
    for field in ("features", "fixes", "contributors"):
        if not isinstance(spec.get(field), list):
            raise ValueError(f"poster spec 缺少数组字段 {field}")
    if not spec["features"] and not spec["fixes"]:
        raise ValueError("至少需要一个主要功能或修复项")
    if len(spec["features"]) > 6 or len(spec["fixes"]) > 12:
        raise ValueError("内容过多：最多 6 项功能、12 项修复，请先提炼")
    mention_ids = {m["login"].lower() for m in scan_data.get("mentions", []) if m.get("credit_candidate") is True}
    seen = set()
    for person in spec["contributors"]:
        login = person.get("login", "")
        if not isinstance(login, str) or not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?", login):
            raise ValueError(f"无效 GitHub ID: {login!r}")
        if login.lower() not in mention_ids:
            raise ValueError(f"贡献者 @{login} 未在 release note 中文部分明确署名")
        if login.lower() in seen:
            raise ValueError(f"重复的贡献者 @{login}")
        seen.add(login.lower())
        if not person.get("contribution"):
            raise ValueError(f"缺少 @{login} 的贡献概述")
        if person.get("avatar_path") and not allow_offline_avatars:
            raise ValueError("avatar_path 仅供显式离线测试使用，正式成图必须核验 GitHub 头像")
    for field in ("features", "fixes"):
        for item in spec[field]:
            if not item.get("title") or not item.get("body"):
                raise ValueError(f"{field} 每项都需要 title 和 body")


def get_avatar(person, spec_path, avatar_dir, allow_offline_avatars=False):
    from PIL import Image

    login = person["login"]
    if person.get("avatar_path"):
        if not allow_offline_avatars:
            raise ValueError("正式成图不能使用 avatar_path")
        path = Path(person["avatar_path"])
        if not path.is_absolute():
            path = spec_path.parent / path
        return Image.open(path).convert("RGB")

    request = Request(
        "https://api.github.com/users/" + quote(login),
        headers={"Accept": "application/vnd.github+json", "User-Agent": "cc-haha-release-announcement"},
    )
    try:
        with urlopen(request, timeout=20) as response:
            profile = json.load(response)
        if profile.get("login", "").lower() != login.lower():
            raise ValueError(f"GitHub 返回的账号与 @{login} 不符")
        url = profile.get("avatar_url")
        if not url:
            raise ValueError(f"@{login} 没有公开头像地址")
        image_request = Request(url + "&s=256", headers={"User-Agent": "cc-haha-release-announcement"})
        with urlopen(image_request, timeout=20) as response:
            content = response.read()
    except (HTTPError, URLError, TimeoutError) as exc:
        raise RuntimeError(f"获取 @{login} 的 GitHub 头像失败：{exc}") from exc
    avatar_dir.mkdir(parents=True, exist_ok=True)
    path = avatar_dir / (login + ".png")
    path.write_bytes(content)
    return Image.open(path).convert("RGB")


def render(spec, scan_data, spec_path, output, allow_offline_avatars=False):
    from PIL import Image, ImageDraw, ImageFont, ImageOps

    check_spec(spec, scan_data, allow_offline_avatars)
    regular_path, bold_path = choose_font_path(False), choose_font_path(True)
    def face(size, bold=False):
        return ImageFont.truetype(bold_path if bold else regular_path, size)

    W, MAX_H = 1080, 16000
    paper, ink, muted, rust, line = "#F8F5EE", "#25211D", "#746B62", "#A84D35", "#DED5C9"
    canvas = Image.new("RGB", (W, MAX_H), paper)
    draw = ImageDraw.Draw(canvas)

    def lines(value, text_face, width):
        return wrap_lines(value, width, lambda text: draw.textlength(text, font=text_face))

    def write(x, y, value, text_face, color, width, leading=1.38):
        step = round(text_face.size * leading)
        for text_line in lines(value, text_face, width):
            draw.text((x, y), text_line, font=text_face, fill=color)
            y += step
        return y

    # Compact hero: the first release content appears in the first phone viewport.
    draw.rectangle((0, 0, W, 230), fill=ink)
    product = str(spec.get("product") or "Claude Code Haha").upper()
    write(64, 40, f"{product}  ·  v{spec['version']}", face(29, True), "#D6B99E", 950)
    draw.text((64, 99), "新版本发布", font=face(63, True), fill="#F4EFE4")
    draw.line((64, 207, 1016, 207), fill=rust, width=4)

    y = 286
    features = spec["features"]
    if features:
        draw.text((64, y), "这次新增", font=face(58, True), fill=ink)
        draw.text((68, y + 80), "本次最值得关注的变化", font=face(30), fill=muted)
        y += 150
        cols = 1 if len(features) == 1 else 2
        gap_x, gap_y = 28, 28
        for start in range(0, len(features), cols):
            row = features[start:start + cols]
            card_w = 952 if len(row) == 1 else 461
            dimensions = []
            for item in row:
                title_lines = lines(item["title"], face(37, True), card_w - 60)
                body_lines = lines(item["body"], face(30), card_w - 60)
                body_top = 87 + len(title_lines) * 45 + 24
                dimensions.append((title_lines, body_lines, body_top))
            minimum_height = 240 if len(row) == 1 else 340
            height = max(minimum_height, *(body_top + len(body_lines) * 42 + 35 for _, body_lines, body_top in dimensions))
            for col, (item, (_, _, body_top)) in enumerate(zip(row, dimensions)):
                x = 64 + col * (card_w + gap_x)
                draw.rounded_rectangle((x, y, x + card_w, y + height), radius=26, fill="#FFFFFF", outline=line, width=2)
                draw.text((x + 30, y + 28), f"{start + col + 1:02d}", font=face(28, True), fill=rust)
                write(x + 30, y + 87, item["title"], face(37, True), ink, card_w - 60, 1.22)
                write(x + 30, y + body_top, item["body"], face(30), muted, card_w - 60, 1.4)
            y += height + gap_y
        y += 66

    for extra in spec.get("extras", []):
        if not all(extra.get(key) for key in ("title", "headline", "body")):
            raise ValueError("extras 每项需要 title、headline、body")
        draw.text((64, y), extra["title"], font=face(54, True), fill=ink)
        y += 90
        head_lines = lines(extra["headline"], face(34, True), 890)
        body_lines = lines(extra["body"], face(30), 880)
        box_h = 30 + len(head_lines) * 45 + 20 + len(body_lines) * 40 + 30
        draw.rounded_rectangle((64, y, 1016, y + box_h), radius=25, fill="#EEE4D7")
        write(94, y + 30, extra["headline"], face(34, True), ink, 890, 1.32)
        write(94, y + 30 + len(head_lines) * 45 + 20, extra["body"], face(30), muted, 880, 1.38)
        y += box_h + 80

    if spec["fixes"]:
        draw.text((64, y), "重点修复", font=face(58, True), fill=ink)
        draw.text((68, y + 80), "那些真正影响使用的问题", font=face(30), fill=muted)
        y += 160
        for index, item in enumerate(spec["fixes"]):
            row_y = y
            draw.ellipse((67, y + 16, 83, y + 32), fill=rust)
            title_end = write(107, y, item["title"], face(34, True), ink, 870, 1.2)
            body_end = write(107, title_end + 12, item["body"], face(30), muted, 870, 1.36)
            y = max(row_y + 116, body_end + 24)
            if index < len(spec["fixes"]) - 1:
                draw.line((107, y - 13, 1016, y - 13), fill=line, width=2)
        y += 56

    people = spec["contributors"]
    if people:
        draw.text((64, y), "感谢社区贡献者", font=face(54, True), fill=ink)
        draw.text((67, y + 78), "头像与 GitHub ID 来自公开主页", font=face(28), fill=muted)
        y += 150
        avatar_dir = output.parent / "avatars"
        avatars = [(person, get_avatar(person, spec_path, avatar_dir, allow_offline_avatars)) for person in people]
        for person, photo in avatars:
            contribution_lines = lines(person["contribution"], face(24), 805)
            row_h = max(116, 75 + len(contribution_lines) * 31)
            draw.rounded_rectangle((64, y, 1016, y + row_h), radius=20, fill="#FFFFFF", outline=line, width=2)
            square = ImageOps.fit(photo, (78, 78), method=Image.Resampling.LANCZOS)
            mask = Image.new("L", (78, 78))
            ImageDraw.Draw(mask).ellipse((0, 0, 77, 77), fill=255)
            canvas.paste(square, (86, y + 19), mask)
            draw.text((184, y + 23), "@" + person["login"], font=face(30, True), fill=ink)
            write(184, y + 66, person["contribution"], face(24), muted, 805)
            y += row_h + 16
        y += 20

    if spec.get("install_note"):
        note_lines = lines(spec["install_note"], face(27), 885)
        box_h = 77 + len(note_lines) * 38 + 30
        draw.rounded_rectangle((64, y, 1016, y + box_h), radius=25, fill=ink)
        draw.text((96, y + 28), "安装提示", font=face(31, True), fill="#F5D3B4")
        write(96, y + 76, spec["install_note"], face(27), "#F4EFE4", 885)
        y += box_h + 68

    draw.text((64, y), f"{spec.get('product') or 'Claude Code Haha'}  ·  v{spec['version']}", font=face(28, True), fill=ink)
    if spec.get("footer_url"):
        draw.text((64, y + 48), spec["footer_url"], font=face(27), fill=muted)
    y += 137
    if y > MAX_H:
        raise ValueError(f"海报高度 {y}px 超出上限，请减少内容")
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.crop((0, 0, W, y)).save(output, optimize=True)
    return (W, y)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    scan_cmd = commands.add_parser("scan", help="查找最新 release note，并输出中文内容与署名候选")
    scan_cmd.add_argument("--repo", type=Path, default=Path.cwd())
    scan_cmd.add_argument("--version", help="指定旧版本进行复测，例如 0.6.6；默认选最新版本")
    scan_cmd.add_argument("--out", type=Path, required=True)
    render_cmd = commands.add_parser("render", help="从经过审核的 JSON 绘制微信群长图")
    render_cmd.add_argument("--scan", type=Path, required=True)
    render_cmd.add_argument("--spec", type=Path, required=True)
    render_cmd.add_argument("--out", type=Path, required=True)
    render_cmd.add_argument("--allow-offline-avatars", action="store_true", help="仅测试用：允许 avatar_path 跳过 GitHub 请求")
    args = parser.parse_args()
    try:
        if args.command == "scan":
            data = scan(args.repo.resolve(), args.version)
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            credited = sum(mention["credit_candidate"] for mention in data["mentions"])
            print(f"v{data['version']} | {data['source']}:{data['path']} | {credited} credits / {len(data['mentions'])} mentions | {args.out}")
        else:
            scan_data = json.loads(args.scan.read_text(encoding="utf-8"))
            spec = json.loads(args.spec.read_text(encoding="utf-8"))
            width, height = render(spec, scan_data, args.spec, args.out, args.allow_offline_avatars)
            print(f"{args.out} | {width}x{height}")
    except (ValueError, RuntimeError, OSError, KeyError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
