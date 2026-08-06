// 文件类型图标映射:整名优先、扩展名兜底、未知回落中性件。
// 断言比图标**引用**而非 displayName:lucide 多个名字是同一组件的别名
// (FileJson === FileBraces),按名字断言会随上游改名假失败。
import {
  Database,
  File,
  FileArchive,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileLock,
  FileTerminal,
  FileText,
} from "lucide-react";
import { describe, expect, it } from "vitest";

import { fileIconOf } from "./fileIcon";

const iconOf = (f: string) => fileIconOf(f).icon;

describe("fileIconOf", () => {
  it("按扩展名分型(代码/数据/媒体/脚本/归档),大小写与路径前缀不影响", () => {
    expect(iconOf("src/App.TSX")).toBe(FileCode);
    expect(iconOf("tsconfig.json")).toBe(FileJson);
    expect(iconOf("logo.PNG")).toBe(FileImage);
    expect(iconOf("build.sh")).toBe(FileTerminal);
    expect(iconOf("dist.tar.gz")).toBe(FileArchive);
    expect(iconOf("schema.sql")).toBe(Database);
  });

  it("整名优先于扩展名:锁文件不算 json/yaml", () => {
    expect(iconOf("package-lock.json")).toBe(FileLock);
    expect(iconOf("pnpm-lock.yaml")).toBe(FileLock);
    expect(iconOf("Cargo.lock")).toBe(FileLock);
    expect(iconOf("package.json")).toBe(FileJson); // 对照:普通文件仍按扩展名走
  });

  it("无扩展名/隐藏文件:知名的给配置件,其余回落中性 File", () => {
    expect(iconOf("Dockerfile")).toBe(FileCog);
    expect(iconOf(".gitignore")).toBe(FileCog);
    expect(iconOf(".unknownrc")).toBe(File); // 前导点不当扩展名解析
    expect(iconOf("LICENSE")).toBe(FileText);
    expect(iconOf("mystery")).toBe(File);
  });

  it("色调一律是完整 Tailwind 类字面量(禁拼接,静态扫描要求)", () => {
    for (const f of ["a.ts", "b.json", "c.png", "d.sh", "e.unknown"]) {
      expect(fileIconOf(f).tone).toMatch(/^text-[a-z0-9/-]+$/);
    }
  });
});
