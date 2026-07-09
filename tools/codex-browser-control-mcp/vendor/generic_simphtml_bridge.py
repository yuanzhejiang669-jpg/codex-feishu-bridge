import json
import sys

import generic_simphtml as simphtml

if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def _as_lists(value):
    if isinstance(value, list):
        return value
    if isinstance(value, dict) and value.get("selector"):
        return [value]
    return []


def _postprocess_html(page, lists=None, cutlist=False, maxchars=35000, instruction=""):
    soup = simphtml.optimize_html_for_tokens(page)
    for div in soup.select('div[data-tag="iframe"]'):
        div.name = "iframe"
        if div.has_attr("data-tag"):
            del div["data-tag"]
    html = str(soup)
    if not cutlist:
        return html if len(html) <= maxchars else str(simphtml.smart_truncate(soup, maxchars))

    for entry in _as_lists(lists):
        sel = entry.get("selector") if isinstance(entry, dict) else None
        if not sel:
            continue
        try:
            items = soup.select(sel)
        except Exception:
            continue
        if len(items) < 5:
            continue
        total_len = sum(len(str(it)) for it in items)
        avg_len = total_len / len(items)
        if avg_len < 200 or (avg_len < 700 and total_len < 2500):
            continue
        hit = [it for it in items if instruction and instruction.strip() and instruction in it.get_text(" ", strip=True)]
        keep = hit[:6] if hit else items[:3]
        removed = [it for it in items if it not in keep]
        sample_texts = []
        for rm in removed[:5]:
            txt = rm.get_text(" ", strip=True)[:40]
            if txt:
                sample_texts.append(txt)
        hint_parts = [f'[FAKE ELEMENT] {len(removed)} more items hidden, selector: "{sel}"']
        if sample_texts:
            hint_parts.append("Hidden items: " + ",".join(f'"{t}"' for t in sample_texts))
        hint_tag = soup.new_tag("div")
        hint_tag.string = " ".join(hint_parts)
        if keep:
            keep[-1].insert_after(hint_tag)
        for it in removed:
            it.decompose()
    ss = str(simphtml.optimize_html_for_tokens(soup)) if _as_lists(lists) else html
    if len(ss) > maxchars:
        ss = str(simphtml.smart_truncate(soup, maxchars))
    return ss


def _stop_monitor_js():
    return """function stopStrMonitor() {
        if (!window._tm) return [];
        clearInterval(window._tm.id);
        const final = window._tm.extract();
        const newlySeen = [...window._tm.all].filter(t => !window._tm.init.has(t));
        let result;
        if (newlySeen.length < 8) {
            result = newlySeen;
        } else {
            result = newlySeen.filter(t => !final.has(t));
        }
        delete window._tm;
        return result;
        }
        stopStrMonitor();
    """


def main():
    request = json.load(sys.stdin)
    cmd = request.get("cmd")
    if cmd == "assets":
        print(json.dumps({
            "js_optHTML": simphtml.js_optHTML,
            "js_findMainList": simphtml.js_findMainList,
            "temp_monitor_js": simphtml.temp_monitor_js,
            "stop_monitor_js": _stop_monitor_js(),
        }, ensure_ascii=False))
        return
    if cmd == "postprocess":
        content = request.get("content", "")
        if request.get("text_only"):
            import re
            page = re.sub(r" {2,}", " ", content)
            page = re.sub(r"^ +", "", page, flags=re.M)
            page = re.sub(r"(\n\s*){3,}", "\n\n", page)
            print(json.dumps({"content": page.strip()}, ensure_ascii=False))
            return
        result = _postprocess_html(
            content,
            lists=request.get("lists"),
            cutlist=bool(request.get("cutlist")),
            maxchars=int(request.get("maxchars") or 35000),
            instruction=request.get("instruction") or "",
        )
        print(json.dumps({"content": result}, ensure_ascii=False))
        return
    raise SystemExit(f"unknown cmd: {cmd}")


if __name__ == "__main__":
    main()
