/**
 * expo-image-picker shim → react-native-image-picker（harmony.alias →
 * @react-native-ohos/react-native-image-picker；相册选择用系统 photoPicker，无需权限）。
 */
import { launchImageLibrary } from 'react-native-image-picker';

export type ImagePickerAsset = {
  uri: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  width?: number;
  height?: number;
};

export type ImagePickerResult =
  | { canceled: true; assets: null }
  | { canceled: false; assets: ImagePickerAsset[] };

export async function launchImageLibraryAsync(options?: {
  mediaTypes?: unknown;
  allowsMultipleSelection?: boolean;
  selectionLimit?: number;
  quality?: number;
  exif?: boolean;
}): Promise<ImagePickerResult> {
  const res = await launchImageLibrary({
    mediaType: 'photo',
    selectionLimit: options?.allowsMultipleSelection ? options?.selectionLimit ?? 0 : 1,
    quality: (options?.quality ?? 1) as never,
    includeBase64: false,
  });
  if (res.didCancel || !res.assets?.length) return { canceled: true, assets: null };
  type RNAsset = {
    uri?: string;
    fileName?: string;
    type?: string;
    fileSize?: number;
    width?: number;
    height?: number;
  };
  return {
    canceled: false,
    assets: (res.assets as RNAsset[])
      .filter((a: RNAsset) => !!a.uri)
      .map((a: RNAsset) => ({
        uri: a.uri as string,
        fileName: a.fileName,
        mimeType: a.type,
        fileSize: a.fileSize,
        width: a.width,
        height: a.height,
      })),
  };
}
