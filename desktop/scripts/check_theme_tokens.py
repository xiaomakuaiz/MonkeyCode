#!/usr/bin/env python3
"""主题契约守卫(daisyUI 版)。

配色由 daisyUI 内置 light/dark 主题提供(ui/src/styles.css 的 @plugin 声明),
styles.css 只剩两类自有令牌:迁移桥接别名与长期自定义令牌(终端岛/高亮等)。
这里盯三条仍然会静默烂掉的契约:

1. index.html 首帧防闪底色与 BOOT_BG 常量一致。那两个 hex 是 daisyUI
   light/dark 主题 --color-base-100 的换算值(oklch → sRGB):styles.css 由
   main.tsx 引入,首帧时还没到,只能写死。漂了不报错,只是深色启动闪一帧
   白色,没人会注意到。
2. 若装了 node_modules(CI 的 npm ci 之后必在;本地没装则跳过),把 BOOT_BG
   与 daisyUI 主题源里的 oklch 换算值再对一遍:升级 daisyUI 忘了改防闪色,
   在 CI 上炸出来,不用等深色用户报"启动闪一下"。
3. styles.css 的深色覆写块([data-theme="dark"])只允许覆写 :root 已声明的
   令牌:覆写一个拼错/已删除的名字没有任何报错,只是深色下静默 no-op。
   同一块内重复声明同一令牌也报(后写的静默盖掉先写的);跨块重复是合法的
   (@media 窄窗覆写 --railW、桥接块与长期块分写)。

放在 scripts/ 而不是 vitest:检查对象是静态文件契约,与
check_command_contract.py / check_bundle_configs.py 同类。
"""

from __future__ import annotations

import math
import pathlib
import re
import sys


ROOT = pathlib.Path(__file__).resolve().parents[1]
STYLES = ROOT / "ui/src/styles.css"
INDEX_HTML = ROOT / "ui/index.html"
DAISYUI_THEME_DIR = ROOT / "ui/node_modules/daisyui/theme"

# daisyUI 内置主题 --color-base-100 的 sRGB 换算值(见模块注释第 1 条)。
# 升级 daisyUI 后若此处报错:用本脚本的 oklch_to_hex 重算,index.html 与
# 这两个常量一起改。
BOOT_BG = {"light": "#ffffff", "dark": "#1d232a"}

DARK_SELECTOR = '[data-theme="dark"]'


def oklch_to_hex(ll: float, c: float, h_deg: float) -> str:
    """OKLCH → sRGB hex(标准矩阵;超色域按 clamp 处理,与浏览器一致)。"""
    h = math.radians(h_deg)
    a, b = c * math.cos(h), c * math.sin(h)
    l_ = (ll + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m_ = (ll - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s_ = (ll - 0.0894841775 * a - 1.2914855480 * b) ** 3
    rgb = (
        4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
        -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
        -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_,
    )

    def gamma(x: float) -> float:
        x = min(1.0, max(0.0, x))
        return 12.92 * x if x <= 0.0031308 else 1.055 * x ** (1 / 2.4) - 0.055

    return "#%02x%02x%02x" % tuple(round(gamma(v) * 255) for v in rgb)


def parse_oklch(value: str) -> tuple[float, float, float] | None:
    """"oklch(25.33% .016 252.42)" → (0.2533, 0.016, 252.42)。"""
    found = re.match(r"oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)", value.strip())
    if not found:
        return None
    return float(found.group(1)) / 100, float(found.group(2)), float(found.group(3))


def blocks_of(css: str, selector: str) -> list[str]:
    """取该选择器所有声明块的内容(自定义属性块不嵌套,取到首个 `}`)。
    选择器按"行首恰好是它"匹配,避免 `[data-theme="dark"] .foo` 之类误入。"""
    return re.findall(re.escape(selector) + r"\s*\{([^}]*)\}", css)


def tokens_in(block: str) -> list[str]:
    return re.findall(r"^\s*(--[\w-]+)\s*:", block, re.M)


def check_dark_overrides(css: str) -> list[str]:
    root_tokens = {t for b in blocks_of(css, ":root") for t in tokens_in(b)}
    dark_blocks = blocks_of(css, DARK_SELECTOR)
    errors: list[str] = []
    if not root_tokens:
        errors.append("styles.css 找不到任何 :root 令牌块")
    if not dark_blocks:
        errors.append(f"styles.css 找不到 {DARK_SELECTOR} 覆写块")

    dark_tokens = [t for b in dark_blocks for t in tokens_in(b)]
    if orphans := sorted(set(dark_tokens) - root_tokens):
        errors.append(
            f"深色块覆写了 :root 不存在的令牌(拼错或忘删,深色下静默 no-op): "
            f"{', '.join(orphans)}"
        )
    # 同一块内重复;跨块重复合法(@media 覆写/桥接与长期块分写)
    for label, selector in ((":root", ":root"), ("深色块", DARK_SELECTOR)):
        for block in blocks_of(css, selector):
            seq = tokens_in(block)
            if dupes := sorted({t for t in seq if seq.count(t) > 1}):
                errors.append(f"{label} 同一块内重复声明: {', '.join(dupes)}")
    return errors


def check_boot_background(index_html: pathlib.Path = INDEX_HTML) -> list[str]:
    """index.html 的首帧防闪底色必须与 BOOT_BG 常量逐字一致,
    且同步内联脚本在(带 type="module" 的是 defer,赶不上首帧)。"""
    html = index_html.read_text(encoding="utf-8")
    errors: list[str] = []
    for key, rule in (
        ("light", r"^\s*html, body \{ background: (#[0-9a-fA-F]{3,6}); \}"),
        ("dark", r'^\s*html\[data-theme="dark"\][^{]*\{ background: (#[0-9a-fA-F]{3,6}); \}'),
    ):
        found = re.search(rule, html, re.M)
        if not found:
            errors.append(f"index.html 缺首帧防闪底色规则({key} 档)")
        elif found.group(1).lower() != BOOT_BG[key]:
            errors.append(
                f"index.html 的首帧底色 {found.group(1)} 与 daisyUI {key} 主题的"
                f" base-100({BOOT_BG[key]})不一致:启动会闪一帧另一个颜色"
            )
    if "<script>" not in html or "mc.theme" not in html:
        errors.append("index.html 缺同步内联脚本(按 mc.theme 在首帧前落 data-theme)")
    return errors


def check_daisyui_source(theme_dir: pathlib.Path = DAISYUI_THEME_DIR) -> list[str]:
    """BOOT_BG 常量与 daisyUI 主题源对账;没装 node_modules 时跳过(CI 必装)。"""
    if not theme_dir.is_dir():
        return []
    errors: list[str] = []
    for key in ("light", "dark"):
        source = theme_dir / f"{key}.css"
        if not source.is_file():
            errors.append(f"daisyUI 主题文件缺失: {source}")
            continue
        found = re.search(r"--color-base-100:\s*([^;]+);", source.read_text(encoding="utf-8"))
        if not found:
            errors.append(f"{source} 里找不到 --color-base-100")
            continue
        parsed = parse_oklch(found.group(1))
        if parsed is None:
            errors.append(f"{source} 的 --color-base-100 不是可解析的 oklch: {found.group(1)}")
            continue
        want = oklch_to_hex(*parsed)
        if want != BOOT_BG[key]:
            errors.append(
                f"daisyUI {key} 主题 base-100 换算为 {want},与 BOOT_BG 常量"
                f" {BOOT_BG[key]} 不一致:daisyUI 升级后忘了同步防闪色"
                f"(index.html 与本脚本常量一起改)"
            )
    return errors


def check(styles: pathlib.Path = STYLES) -> list[str]:
    css = styles.read_text(encoding="utf-8")
    return check_dark_overrides(css) + check_boot_background() + check_daisyui_source()


def main() -> int:
    errors = check()
    if errors:
        print("主题令牌契约破裂:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("主题令牌契约 OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
