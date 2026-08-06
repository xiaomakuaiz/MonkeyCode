// 文件类型图标:文件名 → lucide 图标 + 色调。文件树/改动列表/云端文件页
// 共用一份(三处此前要么清一色灰 File、要么根本没图标,用户报障
// 2026-08-06「太丑」)。
//
// 颜色纪律(LAYOUT §8):一律用 daisyUI 语义色类,跟主题变量走——35 个
// 主题(含深色/高对比)下都协调;硬编码 hex 色板只在浅色主题上好看。
// 类名必须是完整字面量:Tailwind 静态扫描源码文本,拼接出来的类不生成。
// 语义色在这里表达的是「文件族类」不是状态——状态另有行尾徽标承担,
// 两者一个在行首一个在行尾,不抢读。
import {
  Database,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileLock,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType,
  FileVideo,
  type LucideIcon,
} from "lucide-react";

export interface FileIconSpec {
  icon: LucideIcon;
  /** 完整的 Tailwind 颜色类字面量(禁拼接) */
  tone: string;
}

const CODE: FileIconSpec = { icon: FileCode, tone: "text-info" };
const MARKUP: FileIconSpec = { icon: FileCode, tone: "text-warning" };
const STYLE: FileIconSpec = { icon: FileCode, tone: "text-secondary" };
const DATA: FileIconSpec = { icon: FileJson, tone: "text-warning" };
const CONF: FileIconSpec = { icon: FileCog, tone: "text-base-content/45" };
const DOC: FileIconSpec = { icon: FileText, tone: "text-base-content/50" };
const IMAGE: FileIconSpec = { icon: FileImage, tone: "text-accent" };
const VIDEO: FileIconSpec = { icon: FileVideo, tone: "text-accent" };
const AUDIO: FileIconSpec = { icon: FileAudio, tone: "text-accent" };
const ARCHIVE: FileIconSpec = { icon: FileArchive, tone: "text-base-content/45" };
const SHELL: FileIconSpec = { icon: FileTerminal, tone: "text-success" };
const SHEET: FileIconSpec = { icon: FileSpreadsheet, tone: "text-success" };
const DB: FileIconSpec = { icon: Database, tone: "text-info" };
const LOCK: FileIconSpec = { icon: FileLock, tone: "text-base-content/35" };
const FONT: FileIconSpec = { icon: FileType, tone: "text-base-content/45" };
const PLAIN: FileIconSpec = { icon: File, tone: "text-base-content/40" };

const BY_EXT: Record<string, FileIconSpec> = {
  // 代码
  ts: CODE, tsx: CODE, js: CODE, jsx: CODE, mjs: CODE, cjs: CODE,
  rs: CODE, go: CODE, py: CODE, rb: CODE, java: CODE, kt: CODE, swift: CODE,
  c: CODE, h: CODE, cc: CODE, cpp: CODE, hpp: CODE, cs: CODE, php: CODE,
  lua: CODE, dart: CODE, scala: CODE, ex: CODE, exs: CODE, zig: CODE,
  // 标记 / 模板
  html: MARKUP, htm: MARKUP, xml: MARKUP, vue: MARKUP, svelte: MARKUP, astro: MARKUP,
  // 样式
  css: STYLE, scss: STYLE, sass: STYLE, less: STYLE, styl: STYLE,
  // 结构化数据
  json: DATA, jsonc: DATA, json5: DATA,
  // 配置
  yaml: CONF, yml: CONF, toml: CONF, ini: CONF, conf: CONF, cfg: CONF, env: CONF, properties: CONF,
  // 文档
  md: DOC, mdx: DOC, txt: DOC, rst: DOC, adoc: DOC, pdf: DOC, doc: DOC, docx: DOC,
  // 媒体
  png: IMAGE, jpg: IMAGE, jpeg: IMAGE, gif: IMAGE, webp: IMAGE, svg: IMAGE, ico: IMAGE, bmp: IMAGE, avif: IMAGE,
  mp4: VIDEO, mov: VIDEO, webm: VIDEO, mkv: VIDEO, avi: VIDEO,
  mp3: AUDIO, wav: AUDIO, flac: AUDIO, ogg: AUDIO, m4a: AUDIO,
  // 归档
  zip: ARCHIVE, tar: ARCHIVE, gz: ARCHIVE, tgz: ARCHIVE, bz2: ARCHIVE, xz: ARCHIVE, rar: ARCHIVE, "7z": ARCHIVE,
  // 脚本
  sh: SHELL, bash: SHELL, zsh: SHELL, fish: SHELL, ps1: SHELL, bat: SHELL, cmd: SHELL,
  // 表格 / 数据库
  csv: SHEET, tsv: SHEET, xls: SHEET, xlsx: SHEET,
  sql: DB, db: DB, sqlite: DB, sqlite3: DB,
  // 字体
  ttf: FONT, otf: FONT, woff: FONT, woff2: FONT, eot: FONT,
};

/** 整名匹配(无扩展名或扩展名不表意的知名文件);键一律小写比对。 */
const BY_NAME: Record<string, FileIconSpec> = {
  dockerfile: CONF,
  makefile: CONF,
  procfile: CONF,
  ".gitignore": CONF,
  ".gitattributes": CONF,
  ".dockerignore": CONF,
  ".editorconfig": CONF,
  ".npmrc": CONF,
  ".nvmrc": CONF,
  "package-lock.json": LOCK,
  "pnpm-lock.yaml": LOCK,
  "yarn.lock": LOCK,
  "bun.lock": LOCK,
  "cargo.lock": LOCK,
  "poetry.lock": LOCK,
  "go.sum": LOCK,
  license: DOC,
  "license.md": DOC,
  readme: DOC,
};

/** 文件名 → 图标与色调。整名优先(package-lock.json 是锁文件不是 json),
 * 再看扩展名,都不认识回落中性 File。 */
export function fileIconOf(name: string): FileIconSpec {
  const base = name.slice(name.lastIndexOf("/") + 1).toLowerCase();
  const whole = BY_NAME[base];
  if (whole) return whole;
  const dot = base.lastIndexOf(".");
  // 前导点的隐藏文件(.gitignore)没在整名表里就当无扩展名,不把 "gitignore" 当扩展
  if (dot <= 0) return PLAIN;
  return BY_EXT[base.slice(dot + 1)] ?? PLAIN;
}
