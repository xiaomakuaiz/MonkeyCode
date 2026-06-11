/**
 * expo-file-system shim（鸿蒙轨），底层 react-native-fs（harmony.alias →
 * @react-native-ohos/react-native-fs）。
 *
 * 下载一律走 RN 自带 XHR（withCredentials）而不是 RNFS.downloadFile：
 * RNOH 的 fetch/XHR 复用 ArkWeb Cookie 池、能自动携带会话 Cookie，RNFS 的原生下载不会带 ——
 * 与主轨 Android 因 cookie jar 不通而改用 XHR 是同一个原因（见 FilesPanel.tsx 注释）。
 * 代价同 Android：整包先进内存。
 */
import RNFS from 'react-native-fs';
// 复用主轨的线性 base64 实现（'@/' 由 babel alias / tsconfig paths 解析到 mobile/src）
import { bytesToBase64 } from '@/messages/base64';

export const EncodingType = {
  UTF8: 'utf8',
  Base64: 'base64',
} as const;

export const cacheDirectory: string = `file://${RNFS.CachesDirectoryPath}/`;
export const documentDirectory: string = `file://${RNFS.DocumentDirectoryPath}/`;

function toPath(uri: string): string {
  return uri.replace(/^file:\/\//, '');
}

export async function writeAsStringAsync(
  fileUri: string,
  contents: string,
  options?: { encoding?: string },
): Promise<void> {
  const enc = options?.encoding === EncodingType.Base64 ? 'base64' : 'utf8';
  await RNFS.writeFile(toPath(fileUri), contents, enc);
}

export async function readAsStringAsync(
  fileUri: string,
  options?: { encoding?: string },
): Promise<string> {
  const enc = options?.encoding === EncodingType.Base64 ? 'base64' : 'utf8';
  return RNFS.readFile(toPath(fileUri), enc);
}

export async function deleteAsync(fileUri: string, options?: { idempotent?: boolean }): Promise<void> {
  try {
    await RNFS.unlink(toPath(fileUri));
  } catch (e) {
    if (!options?.idempotent) throw e;
  }
}

export async function getInfoAsync(
  fileUri: string,
): Promise<{ exists: boolean; uri: string; size?: number; isDirectory?: boolean }> {
  const p = toPath(fileUri);
  if (!(await RNFS.exists(p))) return { exists: false, uri: fileUri };
  const st = await RNFS.stat(p);
  return { exists: true, uri: fileUri, size: Number(st.size), isDirectory: st.isDirectory() };
}

/* ------------------------------- 下载（XHR） ------------------------------- */

export type DownloadProgressData = {
  totalBytesWritten: number;
  totalBytesExpectedToWrite: number;
};

export type DownloadResult = {
  uri: string;
  status: number;
  headers: Record<string, string>;
};

type ProgressCallback = (progress: DownloadProgressData) => void;

function parseResponseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf(':');
    // 头名统一小写：HTTP 头大小写不敏感，调用方（FilesPanel）按 'x-internal-error' 查
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

export class DownloadResumable {
  private xhr: XMLHttpRequest | null = null;
  private canceled = false;

  constructor(
    private url: string,
    private fileUri: string,
    private options?: { headers?: Record<string, string> },
    private callback?: ProgressCallback,
  ) {}

  downloadAsync(): Promise<DownloadResult | undefined> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      this.xhr = xhr;
      xhr.open('GET', this.url);
      xhr.responseType = 'arraybuffer';
      xhr.withCredentials = true; // 会话 Cookie
      const headers = this.options?.headers ?? {};
      for (const k of Object.keys(headers)) xhr.setRequestHeader(k, headers[k]);
      xhr.onprogress = (e) => {
        this.callback?.({
          totalBytesWritten: e.loaded,
          totalBytesExpectedToWrite: e.lengthComputable ? e.total : -1,
        });
      };
      xhr.onload = async () => {
        if (this.canceled) return resolve(undefined);
        try {
          const buf = xhr.response as ArrayBuffer | null;
          const b64 = buf && buf.byteLength ? bytesToBase64(new Uint8Array(buf)) : '';
          await RNFS.writeFile(toPath(this.fileUri), b64, 'base64');
          resolve({
            uri: this.fileUri,
            status: xhr.status,
            headers: parseResponseHeaders(xhr.getAllResponseHeaders() || ''),
          });
        } catch (e) {
          reject(e);
        } finally {
          this.xhr = null;
        }
      };
      xhr.onerror = () => {
        this.xhr = null;
        if (this.canceled) resolve(undefined);
        else reject(new Error('网络错误'));
      };
      xhr.onabort = () => {
        this.xhr = null;
        resolve(undefined);
      };
      xhr.send();
    });
  }

  async cancelAsync(): Promise<void> {
    this.canceled = true;
    try {
      this.xhr?.abort();
    } catch {
      /* noop */
    }
    this.xhr = null;
  }
}

export function createDownloadResumable(
  url: string,
  fileUri: string,
  options?: { headers?: Record<string, string> },
  callback?: ProgressCallback,
): DownloadResumable {
  return new DownloadResumable(url, fileUri, options, callback);
}

export async function downloadAsync(
  url: string,
  fileUri: string,
  options?: { headers?: Record<string, string> },
): Promise<DownloadResult> {
  const res = await new DownloadResumable(url, fileUri, options).downloadAsync();
  if (!res) throw new Error('下载被取消');
  return res;
}

/* --------------------- Android 专属 SAF（鸿蒙不会走到） --------------------- */

export const StorageAccessFramework = {
  async requestDirectoryPermissionsAsync(): Promise<{ granted: boolean; directoryUri: string }> {
    return { granted: false, directoryUri: '' };
  },
  async createFileAsync(_dirUri: string, _fileName: string, _mimeType: string): Promise<string> {
    throw new Error('StorageAccessFramework 仅 Android 可用');
  },
};
