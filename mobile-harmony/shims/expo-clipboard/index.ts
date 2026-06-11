/** expo-clipboard shim → @react-native-clipboard/clipboard（由 harmony.alias 重定向到 @react-native-ohos/clipboard）。 */
import Clipboard from '@react-native-clipboard/clipboard';

export async function setStringAsync(text: string): Promise<boolean> {
  Clipboard.setString(text);
  return true;
}

export async function getStringAsync(): Promise<string> {
  return Clipboard.getString();
}
