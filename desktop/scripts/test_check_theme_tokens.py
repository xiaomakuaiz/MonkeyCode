#!/usr/bin/env python3

import pathlib
import tempfile
import unittest

from check_theme_tokens import (
    BOOT_BG,
    check_boot_background,
    check_daisyui_source,
    check_dark_overrides,
    oklch_to_hex,
    parse_oklch,
)


def css_of(light: dict[str, str], dark: dict[str, str]) -> str:
    def block(selector: str, decls: dict[str, str]) -> str:
        body = "".join(f"  {k}: {v};\n" for k, v in decls.items())
        return f"{selector} {{\n{body}}}\n"

    return block(":root", light) + "\n" + block('[data-theme="dark"]', dark)


class OklchConversionTest(unittest.TestCase):
    """BOOT_BG 常量的来源:daisyUI light/dark 主题 base-100 的换算。"""

    def test_daisyui_light_base_100(self) -> None:
        self.assertEqual(oklch_to_hex(*parse_oklch("oklch(100% 0 0)")), "#ffffff")

    def test_daisyui_dark_base_100(self) -> None:
        self.assertEqual(oklch_to_hex(*parse_oklch("oklch(25.33% .016 252.42)")), "#1d232a")

    def test_unparseable_value_returns_none(self) -> None:
        self.assertIsNone(parse_oklch("light-dark(#fff, #000)"))


class DarkOverrideContractTest(unittest.TestCase):
    def test_real_stylesheet_satisfies_the_contract(self) -> None:
        css = (pathlib.Path(__file__).resolve().parents[1] / "ui/src/styles.css").read_text(encoding="utf-8")
        self.assertEqual(check_dark_overrides(css), [])

    def test_dark_override_of_unknown_token_is_reported(self) -> None:
        errors = check_dark_overrides(css_of({"--a": "#fff"}, {"--a": "#000", "--typo": "#000"}))
        self.assertEqual(len(errors), 1, errors)
        self.assertIn("--typo", errors[0])
        self.assertIn("no-op", errors[0])

    def test_duplicate_within_one_block_is_reported(self) -> None:
        css = css_of({"--a": "#fff"}, {"--a": "#000"}).replace(
            "  --a: #fff;\n", "  --a: #fff;\n  --a: #111;\n", 1
        )
        errors = check_dark_overrides(css)
        self.assertTrue(any("重复声明" in e for e in errors), errors)

    def test_media_query_redeclare_is_legal(self) -> None:
        # @media 窄窗覆写 --railW 是既有用法,不算重复;桥接块与长期块分写同理
        css = css_of({"--railW": "62px"}, {"--railW": "58px"}) + "\n:root {\n  --railW: 58px;\n}\n"
        self.assertEqual(check_dark_overrides(css), [])

    def test_missing_dark_block_is_reported(self) -> None:
        errors = check_dark_overrides(":root {\n  --a: #fff;\n}\n")
        self.assertTrue(any("覆写块" in e for e in errors), errors)


GOOD_HTML = f"""<!DOCTYPE html>
<html>
  <head>
    <style>
      html, body {{ background: {BOOT_BG["light"]}; }}
      html[data-theme="dark"], html[data-theme="dark"] body {{ background: {BOOT_BG["dark"]}; }}
    </style>
    <script>
      try {{ document.documentElement.dataset.theme = localStorage.getItem("mc.theme") === "dark" ? "dark" : "light"; }} catch (e) {{}}
    </script>
  </head>
  <body><script type="module" src="/src/main.tsx"></script></body>
</html>
"""


def write_html(html: str) -> pathlib.Path:
    tmp = pathlib.Path(tempfile.mkdtemp()) / "index.html"
    tmp.write_text(html, encoding="utf-8")
    return tmp


class BootBackgroundTest(unittest.TestCase):
    """index.html 的首帧底色是唯一走不了 var() 的颜色,只能靠检查器盯着
    别与 daisyUI base-100 漂开——漂了不报错,只是启动闪一帧另一个颜色。"""

    def test_real_index_html_passes(self) -> None:
        self.assertEqual(check_boot_background(), [])

    def test_matching_pair_passes(self) -> None:
        self.assertEqual(check_boot_background(write_html(GOOD_HTML)), [])

    def test_drifted_light_background_is_reported(self) -> None:
        errors = check_boot_background(write_html(GOOD_HTML.replace(BOOT_BG["light"], "#fcfdfc")))
        self.assertTrue(any("闪一帧" in e for e in errors), errors)

    def test_missing_dark_rule_is_reported(self) -> None:
        html = "\n".join(l for l in GOOD_HTML.split("\n") if "data-theme" not in l or "localStorage" in l)
        errors = check_boot_background(write_html(html))
        self.assertTrue(any("缺首帧防闪底色规则" in e for e in errors), errors)

    def test_deferred_only_script_is_reported(self) -> None:
        # 只剩 <script type="module">:属性落得比首帧晚,防闪规则命不中
        html = GOOD_HTML.replace("<script>", '<script type="module">')
        errors = check_boot_background(write_html(html))
        self.assertTrue(any("同步内联脚本" in e for e in errors), errors)


class DaisyuiSourceTest(unittest.TestCase):
    """升级 daisyUI 忘改防闪色:靠与主题源对账在 CI 上炸出来。"""

    def theme_dir(self, light: str, dark: str) -> pathlib.Path:
        tmp = pathlib.Path(tempfile.mkdtemp())
        (tmp / "light.css").write_text(f":root {{\n--color-base-100: {light};\n}}\n", encoding="utf-8")
        (tmp / "dark.css").write_text(f":root {{\n--color-base-100: {dark};\n}}\n", encoding="utf-8")
        return tmp

    def test_matching_source_passes(self) -> None:
        d = self.theme_dir("oklch(100% 0 0)", "oklch(25.33% .016 252.42)")
        self.assertEqual(check_daisyui_source(d), [])

    def test_upgraded_theme_color_is_reported(self) -> None:
        d = self.theme_dir("oklch(100% 0 0)", "oklch(30% .02 250)")
        errors = check_daisyui_source(d)
        self.assertTrue(any("忘了同步防闪色" in e for e in errors), errors)

    def test_missing_node_modules_is_skipped(self) -> None:
        self.assertEqual(check_daisyui_source(pathlib.Path(tempfile.mkdtemp()) / "nope"), [])


if __name__ == "__main__":
    unittest.main()
