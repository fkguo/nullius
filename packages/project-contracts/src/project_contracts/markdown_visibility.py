from __future__ import annotations

import re
from collections.abc import Collection


def visible_markdown(text: str, *, preserved_markers: Collection[str] = ()) -> str:
    """Return visible Markdown while retaining exact standalone contract markers."""
    markers = set(preserved_markers)
    output: list[str] = []
    in_comment = False
    fence_char = ""
    fence_length = 0
    for raw_line in text.splitlines(keepends=True):
        content = raw_line.rstrip("\r\n")
        ending = raw_line[len(content):]
        if fence_char:
            if re.fullmatch(rf" {{0,3}}{re.escape(fence_char)}{{{fence_length},}}[ \t]*", content):
                fence_char = ""
                fence_length = 0
            output.append(ending)
            continue
        if not in_comment:
            opening = re.match(r"^ {0,3}(`{3,}|~{3,})", content)
            if opening:
                token = opening.group(1)
                fence_char = token[0]
                fence_length = len(token)
                output.append(ending)
                continue
            if content in markers:
                output.append(content + ending)
                continue

        visible_parts: list[str] = []
        cursor = 0
        while cursor < len(content):
            if in_comment:
                end = content.find("-->", cursor)
                if end < 0:
                    cursor = len(content)
                else:
                    in_comment = False
                    cursor = end + 3
                continue
            start = content.find("<!--", cursor)
            if start < 0:
                visible_parts.append(content[cursor:])
                cursor = len(content)
            else:
                visible_parts.append(content[cursor:start])
                in_comment = True
                cursor = start + 4
        output.append("".join(visible_parts) + ending)
    return "".join(output)
