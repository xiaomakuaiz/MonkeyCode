#!/usr/bin/env python3
"""汇集 updater 发布物:.app.tar.gz(.sig) 重命名为带版本文件名 + 生成 latest.json。

产物集中在 bundle/updater/,人工上传 OSS(public/desktop/):
先传 tar.gz,再覆盖 latest.json,顺序保证客户端不会拉到不存在的包。
"""

import json
import pathlib
import shutil
import sys
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent
URL_BASE = "https://release.monkeycode-ai.com/public/desktop/"

version = json.loads((ROOT / "tauri.conf.json").read_text())["version"]
short = version.removesuffix(".0.0")  # 26071401.0.0 → 26071401

bundle = ROOT / "target/universal-apple-darwin/release/bundle"
tarball = bundle / "macos/MonkeyCode.app.tar.gz"
sig = pathlib.Path(str(tarball) + ".sig")
if not tarball.exists() or not sig.exists():
    sys.exit(
        f"缺少 updater 产物: {tarball}(.sig)\n"
        "需要带签名的发布构建(make macos-release,设置 TAURI_SIGNING_PRIVATE_KEY)"
    )

out = bundle / "updater"
out.mkdir(exist_ok=True)
name = f"MonkeyCode_{short}_universal.app.tar.gz"
shutil.copy2(tarball, out / name)

# universal 包同时服务两种架构,两个 target key 指向同一 URL
entry = {"signature": sig.read_text(), "url": URL_BASE + name}
manifest = {
    "version": version,
    "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": {"darwin-aarch64": entry, "darwin-x86_64": entry},
}
(out / "latest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
print(f"updater 产物就绪: {out / name} + latest.json(版本 {version})")
