/**
 * expo-constants shim：直接读主轨 app.json 的 expo 字段（version / extra.updatesServer 等）。
 * nativeAppVersion 取 app.json 的 version —— 发版时需与 harmony/AppScope/app.json5 的
 * versionName 保持同步（见 mobile-harmony/README.md 发版清单）。
 */
type ExpoConfig = {
  name?: string;
  version?: string;
  extra?: Record<string, unknown>;
} & Record<string, unknown>;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const appJson = require('../../../mobile/app.json') as { expo?: ExpoConfig };

const expoConfig: ExpoConfig = appJson.expo ?? {};

const Constants = {
  expoConfig,
  nativeAppVersion: (expoConfig.version as string | undefined) ?? null,
  executionEnvironment: 'bare' as const,
};

export default Constants;
